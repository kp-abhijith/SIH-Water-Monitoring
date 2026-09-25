import os
import sqlite3
import csv
import io
import time
from flask import Flask, request, jsonify, session, Response, send_from_directory
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash
from twilio.rest import Client
from dotenv import load_dotenv

load_dotenv()

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY", "jal_sathi_secure_session_key_2026")

# IS_PRODUCTION: set this env var to "true" on Render. Cross-domain cookies
# (frontend on one domain, backend on another) require SameSite=None + Secure,
# which only works over HTTPS — so we only enable it in production.
IS_PRODUCTION = os.environ.get("IS_PRODUCTION", "false").lower() == "true"
app.config["SESSION_COOKIE_SAMESITE"] = "None" if IS_PRODUCTION else "Lax"
app.config["SESSION_COOKIE_SECURE"] = IS_PRODUCTION
app.config["SESSION_COOKIE_HTTPONLY"] = True

# FRONTEND_URL: set this env var on Render to your deployed frontend's exact URL
# once you have it (e.g. https://jal-sathi.onrender.com). Falls back to local
# dev origins so nothing breaks while testing on your laptop.
_frontend_url = os.environ.get("FRONTEND_URL", "")
_cors_origins = [
    "http://127.0.0.1:5500", "http://localhost:5500",
    "http://127.0.0.1:3000", "http://localhost:3000",
]
if _frontend_url:
    _cors_origins.append(_frontend_url)

CORS(app, supports_credentials=True, origins=_cors_origins)

DB_PATH = os.path.join(os.path.dirname(__file__), "database.db")

# --- TWILIO — pulled from environment, never hardcoded ---
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "")
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_SMS_NUMBER = os.environ.get("TWILIO_SMS_NUMBER", "")
ALERT_RECIPIENT_NUMBER = os.environ.get("ALERT_RECIPIENT_NUMBER", "")

# Feature 5: SMS cooldown — one alert per station per window, not one per 3s packet
SMS_COOLDOWN_SECONDS = 5 * 60
_last_alert_time = {}  # device_id -> unix timestamp of last SMS sent


# ================= DATABASE INITIALIZATION =================
def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS water_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            device_id TEXT,
            raw_ph REAL, raw_tds REAL, raw_turb REAL,
            treated_ph REAL, treated_tds REAL, treated_turb REAL,
            temperature REAL,
            alarm_status INTEGER
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL
        )
    """)

    cursor.execute("""
        CREATE TABLE IF NOT EXISTS thresholds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            parameter TEXT UNIQUE NOT NULL,
            min_val REAL,
            max_val REAL
        )
    """)

    # Feature 2: stations table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS stations (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            device_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            lat REAL NOT NULL,
            lng REAL NOT NULL,
            notes TEXT
        )
    """)

    cursor.execute("SELECT * FROM users WHERE username = ?", ("admin",))
    if not cursor.fetchone():
        admin_pass = generate_password_hash("admin123")
        cursor.execute(
            "INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)",
            ("admin", admin_pass, "System Administrator")
        )
        print("[DB Init] Default admin user created (admin / admin123)")

    default_thresholds = [
        ("ph", 6.5, 8.5), ("tds", 50.0, 500.0),
        ("turb", 0.0, 5.0), ("temp", 10.0, 38.0)
    ]
    for param, min_v, max_v in default_thresholds:
        cursor.execute("""
            INSERT INTO thresholds (parameter, min_val, max_val) VALUES (?, ?, ?)
            ON CONFLICT(parameter) DO NOTHING
        """, (param, min_v, max_v))

    # Feature 2: seed the three stations mentioned in your spec
    default_stations = [
        ("ESP32_JH01", "Dhanbad Mining Area Filtration Unit", 23.7957, 86.4304, "Primary demo unit"),
        ("ESP32_JH02", "Ranchi Station", 23.3441, 85.3096, ""),
        ("ESP32_JH03", "Bokaro Station", 23.6693, 86.1511, ""),
    ]
    for device_id, name, lat, lng, notes in default_stations:
        cursor.execute("""
            INSERT INTO stations (device_id, name, lat, lng, notes) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(device_id) DO NOTHING
        """, (device_id, name, lat, lng, notes))

    conn.commit()
    conn.close()


init_db()


# ================= SMS ALERTS (Feature 5: cooldown per station) =================
def send_sms_alert(message_body, device_id):
    now = time.time()
    last = _last_alert_time.get(device_id, 0)
    if now - last < SMS_COOLDOWN_SECONDS:
        print(f"[SMS Skipped] Cooldown active for {device_id} "
              f"({int(SMS_COOLDOWN_SECONDS - (now - last))}s remaining)")
        return False

    try:
        if not TWILIO_ACCOUNT_SID or not TWILIO_AUTH_TOKEN:
            print("[SMS Bypass] Twilio credentials not set. Message was:", message_body)
            _last_alert_time[device_id] = now
            return False

        client = Client(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
        message = client.messages.create(
            body=message_body, from_=TWILIO_SMS_NUMBER, to=ALERT_RECIPIENT_NUMBER
        )
        _last_alert_time[device_id] = now
        print(f"[SMS Success] Alert sent for {device_id}. SID: {message.sid}")
        return True
    except Exception as e:
        print(f"[SMS Error] {e}")
        return False


# ================= AUTH =================
@app.route('/api/login', methods=['POST'])
def login():
    data = request.get_json() or {}
    username, password = data.get('username'), data.get('password')
    if not username or not password:
        return jsonify({"status": "error", "message": "Username and password required"}), 400

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = cursor.fetchone()
    conn.close()

    if user and check_password_hash(user['password_hash'], password):
        session['user_id'] = user['id']
        session['username'] = user['username']
        session['role'] = user['role']
        return jsonify({"status": "success", "user": {"username": user['username'], "role": user['role']}}), 200
    return jsonify({"status": "error", "message": "Invalid username or password"}), 401


@app.route('/api/logout', methods=['POST'])
def logout():
    session.clear()
    return jsonify({"status": "success"}), 200


@app.route('/api/me', methods=['GET'])
def get_current_user():
    if 'username' in session:
        return jsonify({"authenticated": True, "user": {"username": session['username'], "role": session['role']}})
    return jsonify({"authenticated": False}), 200


def get_current_thresholds():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT parameter, min_val, max_val FROM thresholds")
    rows = cursor.fetchall()
    conn.close()
    return {r["parameter"]: {"min": r["min_val"], "max": r["max_val"]} for r in rows}


def calculate_alarm(t_ph, t_tds, t_turb, temp):
    """Independently recompute alarm from the DB's current thresholds —
    never trust a client-supplied 'alarm' boolean, since it may be stale,
    faked (e.g. during manual testing), or based on thresholds that no
    longer match what's configured on the Threshold Limits page."""
    th = get_current_thresholds()
    breaches = []

    if 'ph' in th and not (th['ph']['min'] <= t_ph <= th['ph']['max']):
        breaches.append(f"pH {t_ph}")
    if 'tds' in th and not (th['tds']['min'] <= t_tds <= th['tds']['max']):
        breaches.append(f"TDS {t_tds}ppm")
    if 'turb' in th and not (th['turb']['min'] <= t_turb <= th['turb']['max']):
        breaches.append(f"Turbidity {t_turb}NTU")
    if 'temp' in th and not (th['temp']['min'] <= temp <= th['temp']['max']):
        breaches.append(f"Temperature {temp}°C")

    return (len(breaches) > 0), breaches


# ================= SENSOR INGESTION =================
@app.route('/api/sensor-data', methods=['POST'])
def receive_data():
    data = request.get_json()
    if not data:
        return jsonify({"status": "error", "message": "No JSON payload received"}), 400

    device_id = data.get('device_id', 'ESP32_UNKNOWN')
    r_ph = data.get('raw_ph', 7.0)
    r_tds = data.get('raw_tds', 0.0)
    r_turb = data.get('raw_turb', 0.0)
    t_ph = data.get('treated_ph', 7.0)
    t_tds = data.get('treated_tds', 0.0)
    t_turb = data.get('treated_turb', 0.0)
    temp = data.get('temp', 25.0)

    # Server-side calculation — authoritative, uses live DB thresholds,
    # ignores whatever (if anything) the client sent for 'alarm'
    is_unsafe, breaches = calculate_alarm(t_ph, t_tds, t_turb, temp)
    alarm = 1 if is_unsafe else 0

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("""
        INSERT INTO water_logs (device_id, raw_ph, raw_tds, raw_turb, treated_ph, treated_tds, treated_turb, temperature, alarm_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (device_id, r_ph, r_tds, r_turb, t_ph, t_tds, t_turb, temp, alarm))
    conn.commit()
    conn.close()

    if alarm == 1:
        breach_text = ", ".join(breaches)
        alert_msg = f"[SIH ALERT] Water Station {device_id} is discharging UNSAFE water! Breached: {breach_text}."
        send_sms_alert(alert_msg, device_id)

    return jsonify({"status": "success", "alarm": bool(alarm), "breaches": breaches}), 201


# ================= Feature 1: HISTORY with filters + pagination =================
@app.route('/api/history', methods=['GET'])
def get_history():
    device_id = request.args.get('device_id', '').strip()
    start_date = request.args.get('start_date', '').strip()   # YYYY-MM-DD
    end_date = request.args.get('end_date', '').strip()       # YYYY-MM-DD
    page = request.args.get('page', 1, type=int)
    page_size = request.args.get('page_size', 10, type=int)
    limit = request.args.get('limit', None, type=int)  # kept for backward compatibility

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    where = []
    params = []
    if device_id:
        where.append("device_id = ?")
        params.append(device_id)
    if start_date:
        where.append("date(timestamp) >= date(?)")
        params.append(start_date)
    if end_date:
        where.append("date(timestamp) <= date(?)")
        params.append(end_date)
    where_clause = ("WHERE " + " AND ".join(where)) if where else ""

    # Backward-compatible simple mode: just ?limit=N, no pagination metadata
    if limit is not None and 'page' not in request.args:
        cursor.execute(f"SELECT * FROM water_logs {where_clause} ORDER BY timestamp DESC, id DESC LIMIT ?",
                        params + [limit])
        rows = cursor.fetchall()
        conn.close()
        return jsonify([_row_to_log(r) for r in rows])

    cursor.execute(f"SELECT COUNT(*) as cnt FROM water_logs {where_clause}", params)
    total = cursor.fetchone()["cnt"]
    total_pages = max(1, (total + page_size - 1) // page_size)
    page = max(1, min(page, total_pages))
    offset = (page - 1) * page_size

    cursor.execute(
        f"SELECT * FROM water_logs {where_clause} ORDER BY timestamp DESC, id DESC LIMIT ? OFFSET ?",
        params + [page_size, offset]
    )
    rows = cursor.fetchall()
    conn.close()

    return jsonify({
        "logs": [_row_to_log(r) for r in rows],
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": total_pages
    })


def _row_to_log(r):
    return {
        "timestamp": r["timestamp"],
        "device_id": r["device_id"],
        "raw": {"ph": r["raw_ph"], "tds": r["raw_tds"], "turb": r["raw_turb"]},
        "treated": {"ph": r["treated_ph"], "tds": r["treated_tds"], "turb": r["treated_turb"]},
        "temp": r["temperature"],
        "alarm": bool(r["alarm_status"])
    }


# ================= Feature 3: STATUS filterable by station =================
@app.route('/api/status', methods=['GET'])
def get_latest_status():
    device_id = request.args.get('device_id', '').strip()

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if device_id:
        cursor.execute(
            "SELECT * FROM water_logs WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1",
            (device_id,)
        )
    else:
        cursor.execute("SELECT * FROM water_logs ORDER BY timestamp DESC, id DESC LIMIT 1")

    row = cursor.fetchone()
    conn.close()

    if not row:
        return jsonify({"status": "no_data"})
    return jsonify(_row_to_log(row))


# ================= Feature 2: STATIONS (geography places) =================
@app.route('/api/stations', methods=['GET'])
def list_stations():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute("SELECT * FROM stations ORDER BY id ASC")
    stations = cursor.fetchall()

    result = []
    for s in stations:
        # attach latest alarm status per station, so the map can color markers (Feature 5)
        cursor.execute(
            "SELECT alarm_status FROM water_logs WHERE device_id = ? ORDER BY timestamp DESC, id DESC LIMIT 1",
            (s["device_id"],)
        )
        latest = cursor.fetchone()
        result.append({
            "id": s["id"],
            "device_id": s["device_id"],
            "name": s["name"],
            "lat": s["lat"],
            "lng": s["lng"],
            "notes": s["notes"],
            "alarm": bool(latest["alarm_status"]) if latest else None,
            "has_data": latest is not None
        })
    conn.close()
    return jsonify(result)


@app.route('/api/stations', methods=['POST'])
def add_station():
    data = request.get_json() or {}
    device_id = data.get('device_id', '').strip()
    name = data.get('name', '').strip()
    lat = data.get('lat')
    lng = data.get('lng')
    notes = data.get('notes', '')

    if not device_id or not name or lat is None or lng is None:
        return jsonify({"status": "error", "message": "device_id, name, lat, lng are required"}), 400

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    try:
        cursor.execute(
            "INSERT INTO stations (device_id, name, lat, lng, notes) VALUES (?, ?, ?, ?, ?)",
            (device_id, name, float(lat), float(lng), notes)
        )
        conn.commit()
    except sqlite3.IntegrityError:
        conn.close()
        return jsonify({"status": "error", "message": "A station with this device_id already exists"}), 409
    conn.close()
    return jsonify({"status": "success"}), 201


@app.route('/api/stations/<int:station_id>', methods=['DELETE'])
def delete_station(station_id):
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute("DELETE FROM stations WHERE id = ?", (station_id,))
    conn.commit()
    conn.close()
    return jsonify({"status": "success"}), 200


# ================= THRESHOLDS (persisted in DB — Feature 5) =================
@app.route('/api/thresholds', methods=['GET', 'POST'])
def handle_thresholds():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    if request.method == 'POST':
        data = request.get_json() or {}
        for param in ['ph', 'tds', 'turb', 'temp']:
            if param in data:
                min_v = data[param].get('min')
                max_v = data[param].get('max')
                cursor.execute("""
                    INSERT INTO thresholds (parameter, min_val, max_val) VALUES (?, ?, ?)
                    ON CONFLICT(parameter) DO UPDATE SET min_val=excluded.min_val, max_val=excluded.max_val
                """, (param, min_v, max_v))
        conn.commit()
        conn.close()
        return jsonify({"status": "success", "message": "Thresholds updated"})

    cursor.execute("SELECT parameter, min_val, max_val FROM thresholds")
    rows = cursor.fetchall()
    conn.close()
    return jsonify({r["parameter"]: {"min": r["min_val"], "max": r["max_val"]} for r in rows})


# ================= MONTHLY REPORTS (Feature 5: filterable by station) =================
@app.route('/api/reports/monthly', methods=['GET'])
def get_monthly_report():
    month = request.args.get('month')
    device_id = request.args.get('device_id', '').strip()
    if not month:
        return jsonify({"status": "error", "message": "Month parameter required (YYYY-MM)"}), 400

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    where = ["strftime('%Y-%m', timestamp) = ?"]
    params = [month]
    if device_id:
        where.append("device_id = ?")
        params.append(device_id)
    where_clause = " AND ".join(where)

    cursor.execute(f"""
        SELECT strftime('%Y-%m-%d', timestamp) as date,
               AVG(treated_ph) as avg_ph, AVG(treated_tds) as avg_tds,
               AVG(treated_turb) as avg_turb, AVG(temperature) as avg_temp,
               SUM(alarm_status) as total_alarms, COUNT(*) as total_readings
        FROM water_logs WHERE {where_clause}
        GROUP BY strftime('%Y-%m-%d', timestamp) ORDER BY date ASC
    """, params)
    rows = cursor.fetchall()
    conn.close()

    daily_summary = [{
        "date": r["date"],
        "avg_ph": round(r["avg_ph"], 2) if r["avg_ph"] else 0,
        "avg_tds": round(r["avg_tds"], 1) if r["avg_tds"] else 0,
        "avg_turb": round(r["avg_turb"], 2) if r["avg_turb"] else 0,
        "avg_temp": round(r["avg_temp"], 1) if r["avg_temp"] else 0,
        "total_alarms": r["total_alarms"],
        "total_readings": r["total_readings"]
    } for r in rows]

    return jsonify({"month": month, "daily_summary": daily_summary})


@app.route('/api/reports/export/csv', methods=['GET'])
def export_csv():
    month = request.args.get('month')
    device_id = request.args.get('device_id', '').strip()
    if not month:
        return jsonify({"status": "error", "message": "Month parameter required (YYYY-MM)"}), 400

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    where = ["strftime('%Y-%m', timestamp) = ?"]
    params = [month]
    if device_id:
        where.append("device_id = ?")
        params.append(device_id)
    where_clause = " AND ".join(where)

    cursor.execute(f"""
        SELECT timestamp, device_id, raw_ph, raw_tds, raw_turb,
               treated_ph, treated_tds, treated_turb, temperature, alarm_status
        FROM water_logs WHERE {where_clause} ORDER BY timestamp ASC
    """, params)
    rows = cursor.fetchall()
    conn.close()

    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Timestamp", "Device ID", "Raw pH", "Raw TDS (ppm)", "Raw Turbidity (NTU)",
                      "Treated pH", "Treated TDS (ppm)", "Treated Turbidity (NTU)", "Temperature (°C)", "Status"])
    for r in rows:
        writer.writerow([r["timestamp"], r["device_id"], r["raw_ph"], r["raw_tds"], r["raw_turb"],
                          r["treated_ph"], r["treated_tds"], r["treated_turb"], r["temperature"],
                          "ALARM" if r["alarm_status"] else "SAFE"])
    output.seek(0)
    return Response(output.getvalue(), mimetype="text/csv",
                     headers={"Content-disposition": f"attachment; filename=JalSathi_Report_{month}.csv"})


FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")


@app.route("/")
def serve_index():
    return send_from_directory(FRONTEND_DIR, "index.html")

@app.route("/js/<path:filename>")
def serve_js(filename):
    return send_from_directory(os.path.join(FRONTEND_DIR, "js"), filename)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)