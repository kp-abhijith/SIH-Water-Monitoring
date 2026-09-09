// ================= CONFIGURATION & GLOBAL STATE =================
const API_BASE_URL = "http://127.0.0.1:5000/api";

const state = {
  currentUser: null,
  currentMetricView: 'tds',
  liveChartInstance: null,
  reportChartInstance: null,
  mapInstance: null,
  mapInitialized: false,
  mapMarkers: [],
  pollingTimers: [],
  selectedDeviceId: '',   // '' = latest from any station (Feature 3)
  stations: [],
  historyPage: 1,
  historyPageSize: 10,
  thresholds: {
    minPh: 6.5, maxPh: 8.5,
    minTds: 50, maxTds: 500,
    minTurb: 0.0, maxTurb: 5.0,
    minTemp: 10.0, maxTemp: 38.0
  }
};

// ================= DOM ELEMENT REFERENCES =================
const DOM = {
  navDashboard: document.getElementById('nav-dashboard'),
  navMap: document.getElementById('nav-map'),
  navReports: document.getElementById('nav-reports'),
  navThresholds: document.getElementById('nav-thresholds'),
  navHistory: document.getElementById('nav-history'),

  viewDashboard: document.getElementById('view-dashboard'),
  viewMap: document.getElementById('view-map'),
  viewReports: document.getElementById('view-reports'),
  viewThresholds: document.getElementById('view-thresholds'),
  viewHistory: document.getElementById('view-history'),

  loginModal: document.getElementById('login-modal'),
  loginForm: document.getElementById('login-form'),
  loginError: document.getElementById('login-error'),
  logoutBtn: document.getElementById('logout-btn'),
  userDisplay: document.getElementById('user-display'),
  roleDisplay: document.getElementById('role-display'),

  rawPh: document.getElementById('raw-ph'),
  rawTds: document.getElementById('raw-tds'),
  rawTurb: document.getElementById('raw-turb'),
  treatPh: document.getElementById('treat-ph'),
  treatTds: document.getElementById('treat-tds'),
  treatTurb: document.getElementById('treat-turb'),
  systemTemp: document.getElementById('system-temp'),
  alarmBanner: document.getElementById('alarm-banner'),
  connectionBadge: document.getElementById('connection-badge'),
  lastSync: document.getElementById('last-sync'),
  treatmentStatus: document.getElementById('treatment-status'),
  stationNameHeader: document.querySelector('header h2 span'),

  reportMonthPicker: document.getElementById('report-month-picker'),
  btnFetchReport: document.getElementById('btn-fetch-report'),
  btnExportCsv: document.getElementById('btn-export-csv'),
  thresholdForm: document.getElementById('threshold-form'),

  histStation: document.getElementById('hist-station'),
  histStart: document.getElementById('hist-start'),
  histEnd: document.getElementById('hist-end'),
  btnFetchHistory: document.getElementById('btn-fetch-history'),
  historyTableBody: document.getElementById('history-table-body'),
  histPageCurrent: document.getElementById('hist-page-current'),
  histPageTotal: document.getElementById('hist-page-total'),
  btnPrevPage: document.getElementById('btn-prev-page'),
  btnNextPage: document.getElementById('btn-next-page'),
};

// ================= UTILITIES =================
function parseUTCDate(dbTimeString) {
  if (!dbTimeString) return new Date();
  const isoString = dbTimeString.replace(' ', 'T') + (dbTimeString.endsWith('Z') ? '' : 'Z');
  return new Date(isoString);
}

function statusEndpoint() {
  return state.selectedDeviceId
    ? `${API_BASE_URL}/status?device_id=${encodeURIComponent(state.selectedDeviceId)}`
    : `${API_BASE_URL}/status`;
}

// ================= NAVIGATION =================
function switchTab(tabName) {
  const tabs = [
    { name: 'dashboard', view: DOM.viewDashboard, nav: DOM.navDashboard },
    { name: 'map', view: DOM.viewMap, nav: DOM.navMap },
    { name: 'reports', view: DOM.viewReports, nav: DOM.navReports },
    { name: 'thresholds', view: DOM.viewThresholds, nav: DOM.navThresholds },
    { name: 'history', view: DOM.viewHistory, nav: DOM.navHistory },
  ];

  tabs.forEach(tab => {
    if (!tab.view || !tab.nav) return;
    if (tab.name === tabName) {
      tab.view.classList.remove('hidden');
      tab.nav.className = "w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-semibold rounded-xl bg-sky-500 text-white shadow-md shadow-sky-500/20 transition-all";
    } else {
      tab.view.classList.add('hidden');
      tab.nav.className = "w-full flex items-center gap-3 px-3.5 py-2.5 text-xs font-semibold rounded-xl text-slate-600 hover:bg-slate-100 transition-all";
    }
  });

  if (tabName === 'map') {
    if (!state.mapInitialized) {
      initRegionalMap();
      state.mapInitialized = true;
    } else {
      loadStationsOntoMap();
    }
    setTimeout(() => { if (state.mapInstance) state.mapInstance.invalidateSize(); }, 200);
  }
  if (tabName === 'history') {
    populateStationFilterDropdown();
    fetchHistoryPage(1);
  }
}

// ================= AUTH =================
async function checkAuthSession() {
  try {
    const res = await fetch(`${API_BASE_URL}/me`, { credentials: 'include' });
    const data = await res.json();
    updateAuthUI(!!data.authenticated, data.user);
  } catch (err) {
    updateAuthUI(false);
  }
}

function updateAuthUI(isAuthenticated, user) {
  if (isAuthenticated && user) {
    state.currentUser = user;
    if (DOM.userDisplay) DOM.userDisplay.innerText = user.username;
    if (DOM.roleDisplay) DOM.roleDisplay.innerText = user.role;
    if (DOM.loginModal) DOM.loginModal.classList.add('hidden');
  } else {
    if (DOM.loginModal) DOM.loginModal.classList.remove('hidden');
  }
}

async function handleLogin(e) {
  e.preventDefault();
  const username = e.target.username.value;
  const password = e.target.password.value;
  try {
    const res = await fetch(`${API_BASE_URL}/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      credentials: 'include', body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.status === 'success') {
      updateAuthUI(true, data.user);
      if (DOM.loginError) DOM.loginError.classList.add('hidden');
    } else {
      if (DOM.loginError) { DOM.loginError.innerText = data.message || "Invalid credentials"; DOM.loginError.classList.remove('hidden'); }
    }
  } catch (err) {
    if (DOM.loginError) { DOM.loginError.innerText = "Server unreachable. Start Flask on port 5000."; DOM.loginError.classList.remove('hidden'); }
  }
}

async function handleLogout() {
  try {
    await fetch(`${API_BASE_URL}/logout`, { method: 'POST', credentials: 'include' });
    state.currentUser = null;
    updateAuthUI(false);
  } catch (err) { console.error(err); }
}

// ================= Feature 5: THRESHOLDS persisted in DB =================
async function loadThresholdsFromServer() {
  try {
    const res = await fetch(`${API_BASE_URL}/thresholds`, { credentials: 'include' });
    const data = await res.json();
    if (data.ph) { state.thresholds.minPh = data.ph.min; state.thresholds.maxPh = data.ph.max; }
    if (data.tds) { state.thresholds.minTds = data.tds.min; state.thresholds.maxTds = data.tds.max; }
    if (data.turb) { state.thresholds.minTurb = data.turb.min; state.thresholds.maxTurb = data.turb.max; }
    if (data.temp) { state.thresholds.minTemp = data.temp.min; state.thresholds.maxTemp = data.temp.max; }
    reflectThresholdsInForm();
  } catch (err) { console.warn("Could not load thresholds from server:", err); }
}

function reflectThresholdsInForm() {
  const map = {
    'min-ph': state.thresholds.minPh, 'max-ph': state.thresholds.maxPh,
    'min-tds': state.thresholds.minTds, 'max-tds': state.thresholds.maxTds,
    'min-turb': state.thresholds.minTurb, 'max-turb': state.thresholds.maxTurb,
    'min-temp': state.thresholds.minTemp, 'max-temp': state.thresholds.maxTemp,
  };
  Object.entries(map).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
}

async function handleThresholdSave(e) {
  if (e) e.preventDefault();
  const g = (id) => document.getElementById(id);
  state.thresholds.minPh = parseFloat(g('min-ph')?.value) || 6.5;
  state.thresholds.maxPh = parseFloat(g('max-ph')?.value) || 8.5;
  state.thresholds.minTds = parseFloat(g('min-tds')?.value) || 50;
  state.thresholds.maxTds = parseFloat(g('max-tds')?.value) || 500;
  state.thresholds.minTurb = parseFloat(g('min-turb')?.value) || 0.0;
  state.thresholds.maxTurb = parseFloat(g('max-turb')?.value) || 5.0;
  state.thresholds.minTemp = parseFloat(g('min-temp')?.value) || 10.0;
  state.thresholds.maxTemp = parseFloat(g('max-temp')?.value) || 38.0;

  try {
    const res = await fetch(`${API_BASE_URL}/thresholds`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({
        ph: { min: state.thresholds.minPh, max: state.thresholds.maxPh },
        tds: { min: state.thresholds.minTds, max: state.thresholds.maxTds },
        turb: { min: state.thresholds.minTurb, max: state.thresholds.maxTurb },
        temp: { min: state.thresholds.minTemp, max: state.thresholds.maxTemp },
      })
    });
    if (res.ok) {
      alert("Threshold limits saved — they'll persist across refreshes and restarts.");
    } else {
      alert("Failed to save thresholds to server (saved locally only this session).");
    }
  } catch (err) {
    alert("Server unreachable — thresholds saved locally only for this session.");
  }
  fetchLatestData();
}

function evaluateThresholds(treated, temp, serverAlarm) {
  if (!treated) return;
  const phExceeded = treated.ph < state.thresholds.minPh || treated.ph > state.thresholds.maxPh;
  const tdsExceeded = treated.tds < state.thresholds.minTds || treated.tds > state.thresholds.maxTds;
  const turbExceeded = treated.turb < state.thresholds.minTurb || treated.turb > state.thresholds.maxTurb;
  const tempExceeded = temp < state.thresholds.minTemp || temp > state.thresholds.maxTemp;
  const isUnsafe = phExceeded || tdsExceeded || turbExceeded || tempExceeded || serverAlarm;

  if (isUnsafe) {
    if (DOM.alarmBanner) DOM.alarmBanner.classList.remove('hidden');
    if (DOM.treatmentStatus) {
      DOM.treatmentStatus.className = "text-xs bg-red-50 text-red-600 px-2.5 py-1 rounded-full border border-red-200 font-medium";
      DOM.treatmentStatus.innerText = "THRESHOLD BREACH DETECTED";
    }
  } else {
    if (DOM.alarmBanner) DOM.alarmBanner.classList.add('hidden');
    if (DOM.treatmentStatus) {
      DOM.treatmentStatus.className = "text-xs bg-emerald-50 text-emerald-700 px-2.5 py-1 rounded-full border border-emerald-200 font-medium";
      DOM.treatmentStatus.innerText = "Safe (BIS 10500)";
    }
  }
}

// ================= Feature 2 & 5: MAP with dynamic stations + alarm-colored markers =================
function initRegionalMap() {
  const mapContainer = document.getElementById('map');
  if (!mapContainer || typeof L === 'undefined') return;

  state.mapInstance = L.map('map').setView([23.6102, 85.2799], 8);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors'
  }).addTo(state.mapInstance);

  loadStationsOntoMap();
}

async function loadStationsOntoMap() {
  try {
    const res = await fetch(`${API_BASE_URL}/stations`, { credentials: 'include' });
    const stations = await res.json();
    state.stations = stations;

    // clear old markers
    state.mapMarkers.forEach(m => state.mapInstance.removeLayer(m));
    state.mapMarkers = [];

    stations.forEach(s => {
      const color = s.alarm === true ? '#ef4444' : (s.alarm === false ? '#10b981' : '#94a3b8');
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:${color};width:16px;height:16px;border-radius:50%;border:2px solid white;box-shadow:0 0 4px rgba(0,0,0,0.4)"></div>`,
        iconSize: [16, 16]
      });
      const marker = L.marker([s.lat, s.lng], { icon }).addTo(state.mapInstance);
      const statusText = s.alarm === true ? 'ALARM — unsafe reading' : (s.alarm === false ? 'Normal operating range' : 'No data yet');
      marker.bindPopup(`
        <b>${s.name}</b><br>
        Device: ${s.device_id}<br>
        Status: ${statusText}<br>
        <button onclick="selectStationFromMap('${s.device_id}')" style="margin-top:6px;padding:4px 8px;background:#0284c7;color:white;border:none;border-radius:6px;cursor:pointer;font-size:11px;">View live data</button>
        <button onclick="removeStation(${s.id})" style="margin-top:6px;margin-left:4px;padding:4px 8px;background:#ef4444;color:white;border:none;border-radius:6px;cursor:pointer;font-size:11px;">Remove</button>
      `);
      state.mapMarkers.push(marker);
    });

    populateStationFilterDropdown();
    populateDashboardStationSelector();
  } catch (err) {
    console.error("Failed to load stations:", err);
  }
}

async function handleAddStation(e) {
  e.preventDefault();
  const name = document.getElementById('new-station-name').value.trim();
  const deviceId = document.getElementById('new-station-device').value.trim();
  const lat = document.getElementById('new-station-lat').value;
  const lng = document.getElementById('new-station-lng').value;
  const notes = document.getElementById('new-station-notes').value.trim();

  if (!name || !deviceId || !lat || !lng) {
    alert("Name, Device ID, latitude and longitude are all required.");
    return;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/stations`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
      body: JSON.stringify({ name, device_id: deviceId, lat: parseFloat(lat), lng: parseFloat(lng), notes })
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('add-station-form').reset();
      loadStationsOntoMap();
    } else {
      alert(data.message || "Failed to add station");
    }
  } catch (err) {
    alert("Server unreachable — could not add station.");
  }
}

async function removeStation(stationId) {
  if (!confirm("Remove this station? Historical readings are kept, only the map entry is deleted.")) return;
  try {
    await fetch(`${API_BASE_URL}/stations/${stationId}`, { method: 'DELETE', credentials: 'include' });
    loadStationsOntoMap();
  } catch (err) {
    alert("Server unreachable — could not remove station.");
  }
}

function selectStationFromMap(deviceId) {
  state.selectedDeviceId = deviceId;
  const sel = document.getElementById('dashboard-station-select');
  if (sel) sel.value = deviceId;
  switchTab('dashboard');
  fetchLatestData();
  updateChartData();
}

// ================= Feature 3: DASHBOARD station selector =================
function populateDashboardStationSelector() {
  const sel = document.getElementById('dashboard-station-select');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = `<option value="">Latest from any station</option>` +
    state.stations.map(s => `<option value="${s.device_id}">${s.name} (${s.device_id})</option>`).join('');
  sel.value = current || '';
}

function handleDashboardStationChange(e) {
  state.selectedDeviceId = e.target.value;
  fetchLatestData();
  updateChartData();
}

// ================= CHART =================
function initLiveChart() {
  const canvas = document.getElementById('metricsChart');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  state.liveChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [
        { label: 'Raw Inlet', borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.08)', data: [], borderWidth: 2, tension: 0.3, fill: true },
        { label: 'Treated Outlet', borderColor: '#0288d1', backgroundColor: 'rgba(2,136,209,0.08)', data: [], borderWidth: 2, tension: 0.3, fill: true }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#334155', font: { family: 'sans-serif', weight: '500' } } } },
      scales: {
        x: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' } },
        y: { grid: { color: '#e2e8f0' }, ticks: { color: '#64748b' } }
      }
    }
  });
}

// ================= REALTIME POLLING (Feature 3: per-station) =================
async function fetchLatestData() {
  try {
    const response = await fetch(statusEndpoint(), { credentials: 'include' });
    if (!response.ok) throw new Error("Backend offline");
    const data = await response.json();
    if (data.status === 'no_data') return;

    const raw = data.raw || { ph: data.raw_ph, tds: data.raw_tds, turb: data.raw_turb };
    const treated = data.treated || { ph: data.treated_ph, tds: data.treated_tds, turb: data.treated_turb };
    const tempVal = data.temp ?? 25.0;

    if (DOM.rawPh) DOM.rawPh.innerText = Number(raw.ph).toFixed(2);
    if (DOM.rawTds) DOM.rawTds.innerText = Math.round(raw.tds);
    if (DOM.rawTurb) DOM.rawTurb.innerText = Number(raw.turb).toFixed(1);
    if (DOM.treatPh) DOM.treatPh.innerText = Number(treated.ph).toFixed(2);
    if (DOM.treatTds) DOM.treatTds.innerText = Math.round(treated.tds);
    if (DOM.treatTurb) DOM.treatTurb.innerText = Number(treated.turb).toFixed(1);
    if (DOM.systemTemp) DOM.systemTemp.innerText = `${Number(tempVal).toFixed(1)} °C`;
    if (DOM.stationNameHeader) DOM.stationNameHeader.innerText = data.device_id || 'ESP32_JH01';

    if (DOM.lastSync) {
      DOM.lastSync.innerText = parseUTCDate(data.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    if (DOM.connectionBadge) {
      DOM.connectionBadge.className = "flex items-center gap-2 px-3 py-1 bg-emerald-50 text-emerald-700 text-xs font-semibold rounded-full border border-emerald-200";
      DOM.connectionBadge.innerHTML = `<span class="h-2 w-2 bg-emerald-500 rounded-full animate-pulse"></span> Station Active`;
    }
    evaluateThresholds(treated, tempVal, data.alarm);
  } catch (error) {
    if (DOM.connectionBadge) {
      DOM.connectionBadge.className = "flex items-center gap-2 px-3 py-1 bg-red-50 text-red-600 text-xs font-semibold rounded-full border border-red-200";
      DOM.connectionBadge.innerHTML = `<span class="h-2 w-2 bg-red-500 rounded-full"></span> Offline`;
    }
  }
}

async function updateChartData() {
  if (!state.liveChartInstance) return;
  try {
    const deviceParam = state.selectedDeviceId ? `&device_id=${encodeURIComponent(state.selectedDeviceId)}` : '';
    const response = await fetch(`${API_BASE_URL}/history?limit=10${deviceParam}`, { credentials: 'include' });
    if (!response.ok) return;
    const data = await response.json();
    const logs = Array.isArray(data) ? data : (data.logs || []);
    if (logs.length === 0) return;
    const sortedData = [...logs].reverse();

    const labels = sortedData.map(log => parseUTCDate(log.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
    let rawValues = [], treatedValues = [];
    if (state.currentMetricView === 'tds') {
      rawValues = sortedData.map(log => log.raw.tds);
      treatedValues = sortedData.map(log => log.treated.tds);
    } else {
      rawValues = sortedData.map(log => log.raw.turb);
      treatedValues = sortedData.map(log => log.treated.turb);
    }
    state.liveChartInstance.data.labels = labels;
    state.liveChartInstance.data.datasets[0].data = rawValues;
    state.liveChartInstance.data.datasets[1].data = treatedValues;
    state.liveChartInstance.update();
  } catch (e) { console.error("Chart update error:", e); }
}

function switchMetricView(metric) {
  state.currentMetricView = metric;
  document.querySelectorAll('#view-dashboard button[onclick^="switchMetricView"]').forEach((btn) => {
    const isActive = btn.getAttribute('onclick').includes(`'${metric}'`);
    btn.className = isActive ? "px-2.5 py-1 bg-white text-sky-700 text-xs font-semibold rounded shadow-sm"
                              : "px-2.5 py-1 text-slate-600 hover:text-slate-900 text-xs font-semibold rounded";
  });
  updateChartData();
}

function dismissAlarm() { if (DOM.alarmBanner) DOM.alarmBanner.classList.add('hidden'); }

// ================= Feature 1: HISTORY table with filters + pagination =================
function populateStationFilterDropdown() {
  if (!DOM.histStation) return;
  const current = DOM.histStation.value;
  DOM.histStation.innerHTML = `<option value="">All Stations</option>` +
    state.stations.map(s => `<option value="${s.device_id}">${s.name} (${s.device_id})</option>`).join('');
  DOM.histStation.value = current || '';
}

async function fetchHistoryPage(page) {
  state.historyPage = page;
  const deviceId = DOM.histStation ? DOM.histStation.value : '';
  const startDate = DOM.histStart ? DOM.histStart.value : '';
  const endDate = DOM.histEnd ? DOM.histEnd.value : '';

  const params = new URLSearchParams({ page: String(page), page_size: String(state.historyPageSize) });
  if (deviceId) params.set('device_id', deviceId);
  if (startDate) params.set('start_date', startDate);
  if (endDate) params.set('end_date', endDate);

  if (DOM.historyTableBody) {
    DOM.historyTableBody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-slate-500">Loading data...</td></tr>`;
  }

  try {
    const res = await fetch(`${API_BASE_URL}/history?${params.toString()}`, { credentials: 'include' });
    const data = await res.json();
    renderHistoryTable(data.logs || []);
    if (DOM.histPageCurrent) DOM.histPageCurrent.innerText = data.page;
    if (DOM.histPageTotal) DOM.histPageTotal.innerText = data.total_pages;
    if (DOM.btnPrevPage) DOM.btnPrevPage.disabled = data.page <= 1;
    if (DOM.btnNextPage) DOM.btnNextPage.disabled = data.page >= data.total_pages;
  } catch (err) {
    if (DOM.historyTableBody) {
      DOM.historyTableBody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-red-500">Server unreachable</td></tr>`;
    }
  }
}

function renderHistoryTable(logs) {
  if (!DOM.historyTableBody) return;
  if (logs.length === 0) {
    DOM.historyTableBody.innerHTML = `<tr><td colspan="9" class="px-4 py-8 text-center text-slate-500">No records match these filters</td></tr>`;
    return;
  }
  DOM.historyTableBody.innerHTML = logs.map(log => {
    const rowClass = log.alarm ? 'bg-red-50' : '';
    const time = parseUTCDate(log.timestamp).toLocaleString([], { dateStyle: 'short', timeStyle: 'medium' });
    return `<tr class="${rowClass}">
      <td class="px-4 py-3">${time}</td>
      <td class="px-4 py-3 font-semibold">${log.device_id}</td>
      <td class="px-4 py-3">${Number(log.raw.ph).toFixed(2)}</td>
      <td class="px-4 py-3">${Math.round(log.raw.tds)}</td>
      <td class="px-4 py-3">${Number(log.raw.turb).toFixed(1)}</td>
      <td class="px-4 py-3">${Number(log.treated.ph).toFixed(2)}</td>
      <td class="px-4 py-3">${Math.round(log.treated.tds)}</td>
      <td class="px-4 py-3">${Number(log.treated.turb).toFixed(1)}</td>
      <td class="px-4 py-3">${Number(log.temp).toFixed(1)}${log.alarm ? ' <span class="text-red-600 font-bold">⚠ ALARM</span>' : ''}</td>
    </tr>`;
  }).join('');
}

// ================= MONTHLY REPORTS (Feature 5: filterable by station) =================
async function fetchMonthlyReport() {
  const monthVal = DOM.reportMonthPicker ? DOM.reportMonthPicker.value : null;
  if (!monthVal) { alert("Please select a month first."); return; }
  const deviceId = state.selectedDeviceId ? `&device_id=${encodeURIComponent(state.selectedDeviceId)}` : '';
  try {
    const response = await fetch(`${API_BASE_URL}/reports/monthly?month=${monthVal}${deviceId}`, { credentials: 'include' });
    const data = await response.json();
    renderMonthlyChart(data.daily_summary);
  } catch (err) { console.error("Failed to load monthly report:", err); }
}

function renderMonthlyChart(summaryData) {
  const canvas = document.getElementById('monthlyReportChart');
  if (!canvas || !summaryData) return;
  const ctx = canvas.getContext('2d');
  if (state.reportChartInstance) state.reportChartInstance.destroy();

  const labels = summaryData.map(item => item.date);
  const tdsData = summaryData.map(item => item.avg_tds);
  const phData = summaryData.map(item => item.avg_ph);

  // Feature 5: TDS and pH on separate axes — very different scales otherwise flatten the pH line
  state.reportChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [
        { label: 'Avg TDS (ppm)', data: tdsData, backgroundColor: '#0288d1', borderRadius: 4, yAxisID: 'yTds' },
        { label: 'Avg pH', data: phData, backgroundColor: '#10b981', borderRadius: 4, yAxisID: 'yPh', type: 'line', borderColor: '#059669', tension: 0.3 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        x: { grid: { color: '#f1f5f9' }, ticks: { color: '#64748b' } },
        yTds: { type: 'linear', position: 'left', grid: { color: '#f1f5f9' }, ticks: { color: '#0288d1' }, title: { display: true, text: 'TDS (ppm)', color: '#0288d1' } },
        yPh: { type: 'linear', position: 'right', min: 0, max: 14, grid: { drawOnChartArea: false }, ticks: { color: '#10b981' }, title: { display: true, text: 'pH', color: '#10b981' } }
      }
    }
  });
}

function triggerCsvExport() {
  const monthVal = DOM.reportMonthPicker ? DOM.reportMonthPicker.value : null;
  if (!monthVal) { alert("Please select a month first."); return; }
  const deviceId = state.selectedDeviceId ? `&device_id=${encodeURIComponent(state.selectedDeviceId)}` : '';
  window.location.href = `${API_BASE_URL}/reports/export/csv?month=${monthVal}${deviceId}`;
}

// ================= INIT =================
document.addEventListener('DOMContentLoaded', () => {
  initLiveChart();
  checkAuthSession();
  loadThresholdsFromServer();

  if (DOM.navDashboard) DOM.navDashboard.addEventListener('click', () => switchTab('dashboard'));
  if (DOM.navMap) DOM.navMap.addEventListener('click', () => switchTab('map'));
  if (DOM.navReports) DOM.navReports.addEventListener('click', () => switchTab('reports'));
  if (DOM.navThresholds) DOM.navThresholds.addEventListener('click', () => switchTab('thresholds'));
  if (DOM.navHistory) DOM.navHistory.addEventListener('click', () => switchTab('history'));

  if (DOM.loginForm) DOM.loginForm.addEventListener('submit', handleLogin);
  if (DOM.logoutBtn) DOM.logoutBtn.addEventListener('click', handleLogout);
  if (DOM.btnFetchReport) DOM.btnFetchReport.addEventListener('click', fetchMonthlyReport);
  if (DOM.btnExportCsv) DOM.btnExportCsv.addEventListener('click', triggerCsvExport);
  if (DOM.thresholdForm) DOM.thresholdForm.addEventListener('submit', handleThresholdSave);

  const addStationForm = document.getElementById('add-station-form');
  if (addStationForm) addStationForm.addEventListener('submit', handleAddStation);

  const dashSel = document.getElementById('dashboard-station-select');
  if (dashSel) dashSel.addEventListener('change', handleDashboardStationChange);

  if (DOM.btnFetchHistory) DOM.btnFetchHistory.addEventListener('click', () => fetchHistoryPage(1));
  if (DOM.btnPrevPage) DOM.btnPrevPage.addEventListener('click', () => fetchHistoryPage(state.historyPage - 1));
  if (DOM.btnNextPage) DOM.btnNextPage.addEventListener('click', () => fetchHistoryPage(state.historyPage + 1));

  if (DOM.reportMonthPicker && !DOM.reportMonthPicker.value) {
    const now = new Date();
    DOM.reportMonthPicker.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  fetchLatestData();
  updateChartData();

  state.pollingTimers.push(setInterval(fetchLatestData, 3000));
  state.pollingTimers.push(setInterval(updateChartData, 5000));
});