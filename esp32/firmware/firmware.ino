#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Wire.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <math.h>

// ================= NETWORK CONFIG =================
const char* ssid = "POCO X6 Neo 5G";
const char* password = "999000999";
const char* serverEndpoint = "http://10.179.39.203:5000/api/sensor-data";

// ================= PIN DEFINITIONS =================
#define TDS_PIN       35   // Real physical TDS sensor
#define ONE_WIRE_BUS  4    // DS18B20 digital temperature sensor

// 9-LED Status Matrix Pins
#define PH_GREEN   23
#define PH_YELLOW  19
#define PH_RED     18

#define TDS_GREEN  17
#define TDS_YELLOW 16
#define TDS_RED    15

#define TURB_GREEN 13
#define TURB_YELLOW 14
#define TURB_RED   33

#define BUZZER_PIN 25

#define SCREEN_WIDTH 128
#define SCREEN_HEIGHT 64
#define OLED_RESET -1
#define OLED_ADDR 0x3C

// ================= THRESHOLDS =================
#define PH_SAFE_MIN   6.5
#define PH_SAFE_MAX   8.5
#define PH_MOD_MIN    6.0
#define PH_MOD_MAX    9.0

#define TDS_SAFE_MAX  500
#define TDS_MOD_MAX   1000

#define TURB_SAFE_MAX 1.0
#define TURB_MOD_MAX  5.0

// ================= OBJECTS & GLOBAL VARS =================
Adafruit_SSD1306 display(SCREEN_WIDTH, SCREEN_HEIGHT, &Wire, OLED_RESET);
OneWire oneWire(ONE_WIRE_BUS);
DallasTemperature sensors(&oneWire);

bool phSafe = false, phModerate = false;
bool tdsSafe = false, tdsModerate = false;
bool turbSafe = false, turbModerate = false;

const unsigned long SEND_INTERVAL_MS = 3000;
unsigned long lastSendTime = 0;

// ================= LED HELPERS =================
void allLEDOff() {
  digitalWrite(PH_GREEN, LOW); digitalWrite(PH_YELLOW, LOW); digitalWrite(PH_RED, LOW);
  digitalWrite(TDS_GREEN, LOW); digitalWrite(TDS_YELLOW, LOW); digitalWrite(TDS_RED, LOW);
  digitalWrite(TURB_GREEN, LOW); digitalWrite(TURB_YELLOW, LOW); digitalWrite(TURB_RED, LOW);
}

void checkPH(float ph) {
  digitalWrite(PH_GREEN, LOW); digitalWrite(PH_YELLOW, LOW); digitalWrite(PH_RED, LOW);
  if (ph >= PH_SAFE_MIN && ph <= PH_SAFE_MAX) { digitalWrite(PH_GREEN, HIGH); phSafe = true; phModerate = false; }
  else if (ph >= PH_MOD_MIN && ph <= PH_MOD_MAX) { digitalWrite(PH_YELLOW, HIGH); phSafe = false; phModerate = true; }
  else { digitalWrite(PH_RED, HIGH); phSafe = false; phModerate = false; }
}

void checkTDS(float tds) {
  digitalWrite(TDS_GREEN, LOW); digitalWrite(TDS_YELLOW, LOW); digitalWrite(TDS_RED, LOW);
  if (tds <= TDS_SAFE_MAX) { digitalWrite(TDS_GREEN, HIGH); tdsSafe = true; tdsModerate = false; }
  else if (tds <= TDS_MOD_MAX) { digitalWrite(TDS_YELLOW, HIGH); tdsSafe = false; tdsModerate = true; }
  else { digitalWrite(TDS_RED, HIGH); tdsSafe = false; tdsModerate = false; }
}

void checkTurbidity(float turbidity) {
  digitalWrite(TURB_GREEN, LOW); digitalWrite(TURB_YELLOW, LOW); digitalWrite(TURB_RED, LOW);
  if (turbidity <= TURB_SAFE_MAX) { digitalWrite(TURB_GREEN, HIGH); turbSafe = true; turbModerate = false; }
  else if (turbidity <= TURB_MOD_MAX) { digitalWrite(TURB_YELLOW, HIGH); turbSafe = false; turbModerate = true; }
  else { digitalWrite(TURB_RED, HIGH); turbSafe = false; turbModerate = false; }
}

// ================= SENSOR READINGS =================
float readTemperature() {
  sensors.requestTemperatures();
  float tempC = sensors.getTempCByIndex(0);
  
  // DS18B20 returns -127.0 C if wiring/resistor is missing or pin is wrong
  if (tempC == DEVICE_DISCONNECTED_C || tempC <= -100.0) {
    Serial.println("  [WARN] DS18B20 Disconnected (-127C) -> Fallback to 25.0 C. Add 4.7k resistor on GPIO 4!");
    return 25.0;
  }
  return tempC;
}

float readTDS(float temperature) {
  long sum = 0;
  int samples = 30;

  // 30-sample averaging loop to remove ESP32 ADC noise spikes
  for (int i = 0; i < samples; i++) {
    sum += analogRead(TDS_PIN);
    delay(5);
  }

  int analogValue = sum / samples;

  // Ignore internal ESP32 ADC noise floor (ADC < 100 = 0 ppm)
  if (analogValue < 100) {
    Serial.print("  [DEBUG] Avg ADC: "); Serial.print(analogValue);
    Serial.println(" | Signal too low -> 0 ppm");
    return 0.0;
  }

  float voltage = analogValue * (3.3 / 4095.0);

  Serial.print("  [DEBUG] Avg ADC: "); Serial.print(analogValue);
  Serial.print("  | Voltage: "); Serial.println(voltage, 3);

  float compensationCoefficient = 1.0 + 0.02 * (temperature - 25.0);
  float compensationVoltage = voltage / compensationCoefficient;
  
  float tdsValue = (133.42 * pow(compensationVoltage, 3) 
                    - 255.86 * pow(compensationVoltage, 2) 
                    + 857.39 * compensationVoltage) * 0.5;

  return (tdsValue < 0) ? 0.0 : tdsValue;
}

// ================= WIFI =================
void connectWiFi() {
  Serial.print("Connecting to WiFi");
  WiFi.mode(WIFI_STA);
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println("\nWiFi Connected! IP: " + WiFi.localIP().toString());
}

// ================= SETUP =================
void setup() {
  Serial.begin(115200);
  delay(1000);

  // Configure ESP32 ADC resolution and range
  analogReadResolution(12);
  analogSetAttenuation(ADC_11db);

  // Configure 9-LED Matrix & Buzzer
  pinMode(PH_GREEN, OUTPUT); pinMode(PH_YELLOW, OUTPUT); pinMode(PH_RED, OUTPUT);
  pinMode(TDS_GREEN, OUTPUT); pinMode(TDS_YELLOW, OUTPUT); pinMode(TDS_RED, OUTPUT);
  pinMode(TURB_GREEN, OUTPUT); pinMode(TURB_YELLOW, OUTPUT); pinMode(TURB_RED, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);
  allLEDOff();

  // Initialize I2C OLED Display
  Wire.begin(21, 22);
  if (!display.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR)) {
    Serial.println("OLED not found! Continuing without display.");
  } else {
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(15, 25);
    display.println("Jal-Sathi System");
    display.display();
  }

  sensors.begin();
  randomSeed(analogRead(0));
  connectWiFi();
  delay(1000);
}

// ================= MAIN LOOP =================
void loop() {
  // 1. REAL HARDWARE SENSORS
  float temp = readTemperature();
  float tds = readTDS(temp);

  // 2. MOCK METRICS (Treated pH / Turbidity)
  float ph = 7.1 + (random(-10, 10) / 100.0);
  float turbidity = 0.8 + (random(-2, 5) / 10.0);

  // 3. UPDATE 9-LED STATUS MATRIX
  checkPH(ph);
  checkTDS(tds);
  checkTurbidity(turbidity);

  bool waterSafe = phSafe && tdsSafe && turbSafe;
  bool waterModerate = !waterSafe && ((phModerate || phSafe) && (tdsModerate || tdsSafe) && (turbModerate || turbSafe));
  bool alarm = !waterSafe && !waterModerate;

  digitalWrite(BUZZER_PIN, alarm ? HIGH : LOW);

  // 4. OLED DISPLAY UPDATE
  display.clearDisplay();
  display.setTextSize(1);
  display.setCursor(0, 0);  display.println("JAL-SATHI MONITOR");
  display.setCursor(0, 12); display.print("pH: "); display.print(ph, 2); display.print(" (mock)");
  display.setCursor(0, 23); display.print("TDS: "); display.print(tds, 0); display.println(" ppm");
  display.setCursor(0, 34); display.print("Turb: "); display.print(turbidity, 1); display.print(" NTU (mock)");
  display.setCursor(0, 45); display.print("Temp: "); display.print(temp, 1); display.println(" C");
  display.setCursor(0, 56);
  display.print(waterSafe ? "STATUS: SAFE" : waterModerate ? "STATUS: MODERATE" : "STATUS: UNSAFE");
  display.display();

  // 5. SERIAL MONITOR DIAGNOSTICS
  Serial.println("-------------------------");
  Serial.print("pH (mock): "); Serial.println(ph, 2);
  Serial.print("TDS (REAL): "); Serial.print(tds, 0); Serial.println(" ppm");
  Serial.print("Turbidity (mock): "); Serial.print(turbidity, 1); Serial.println(" NTU");
  Serial.print("Temperature (REAL): "); Serial.print(temp, 1); Serial.println(" C");
  Serial.println(waterSafe ? "STATUS: SAFE" : waterModerate ? "STATUS: MODERATE" : "STATUS: UNSAFE");

  // 6. TRANSMIT DATA TO FLASK BACKEND
  if (millis() - lastSendTime >= SEND_INTERVAL_MS) {
    lastSendTime = millis();
    if (WiFi.status() == WL_CONNECTED) {
      HTTPClient http;
      http.begin(serverEndpoint);
      http.addHeader("Content-Type", "application/json");
      http.setTimeout(5000);

      float raw_ph = 8.3 + (random(-10, 10) / 100.0);
      float raw_tds = 750.0 + (random(-15, 15) / 10.0);
      float raw_turb = 18.2 + (random(-10, 20) / 10.0);

      StaticJsonDocument<384> doc;
      doc["device_id"] = "ESP32_JH01";
      doc["temp"] = temp;
      doc["raw_ph"] = raw_ph;
      doc["raw_tds"] = raw_tds;
      doc["raw_turb"] = raw_turb;
      doc["treated_ph"] = ph;
      doc["treated_tds"] = tds;
      doc["treated_turb"] = turbidity;
      doc["alarm"] = !waterSafe;

      String requestBody;
      serializeJson(doc, requestBody);

      int httpResponseCode = http.POST(requestBody);
      if (httpResponseCode > 0) {
        Serial.print("Server Status: "); Serial.println(httpResponseCode);
      } else {
        Serial.print("POST failed: "); Serial.println(http.errorToString(httpResponseCode));
      }
      http.end();
    } else {
      Serial.println("WiFi Disconnected!");
    }
  }

  delay(500);
}