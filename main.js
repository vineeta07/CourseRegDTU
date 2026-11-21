// main.js — DTU Seat Monitor (read-only). No auto-registration.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const notifier = require('node-notifier');
const { createMonitor, buildReaderScript, buildHighlightScript, PORTAL_URL } = require('./monitor');

let win;

// ---- Read-only seat monitor (new /register/ portal) ----
let monitorWin = null;     // the real browser window the USER logs into
let monitorTimer = null;
let monitor = null;        // monitor.js state machine
let monitorFails = 0;
const MONITOR_INTERVAL_MS = 4000;
const MONITOR_MAX_FAILS = 5;
const PORTAL_REFRESH_MS = 30000; // reload the portal this often so seat numbers are current
let lastReloadAt = 0;

// Bring the app to the front and get attention (a seat just opened).
function grabAttention() {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.flashFrame(true);
  setTimeout(() => { if (win && !win.isDestroyed()) { win.setAlwaysOnTop(false); win.flashFrame(false); } }, 3000);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760,
    height: 760,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets', 'dtulogo.png'),
  });
  win.loadFile('index.html');
}

// Only one copy of the app may run.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function stopMonitor() {
  if (monitorTimer) { clearInterval(monitorTimer); monitorTimer = null; }
  monitor = null;
  return { success: true };
}

function monitorStatus(type, message) {
  if (win && !win.isDestroyed()) win.webContents.send('monitor-status', { type, message });
}

ipcMain.handle('start-monitor', async (event, data) => {
  const codes = ((data && data.codes) || [])
    .map(c => String(c).trim().toUpperCase()).filter(Boolean);
  if (codes.length === 0) return { success: false, error: 'Add at least one course code to monitor.' };
  if (monitorTimer) return { success: false, error: 'Monitor is already running.' };

  monitor = createMonitor(codes);
  monitorFails = 0;
  lastReloadAt = Date.now();
  const reader = buildReaderScript(codes);

  // Open a real browser window and let the USER log in and pass any security
  // check themselves. We only READ the page they loaded; we never click.
  if (!monitorWin || monitorWin.isDestroyed()) {
    monitorWin = new BrowserWindow({
      width: 1150, height: 880, parent: win,
      title: 'DTU Seat Monitor - log in here and KEEP THIS WINDOW OPEN',
      webPreferences: { contextIsolation: true, nodeIntegration: false },
    });
    monitorWin.on('closed', () => {
      monitorWin = null;
      if (monitorTimer) {
        stopMonitor();
        monitorStatus('warn', 'Monitor window closed - monitoring stopped.');
        if (win && !win.isDestroyed()) win.webContents.send('monitor-stopped');
      }
    });
    monitorWin.loadURL(PORTAL_URL);
  } else {
    monitorWin.focus();
  }

  monitorTimer = setInterval(async () => {
    if (!monitorWin || monitorWin.isDestroyed()) return;

    // The portal does NOT update seat numbers on its own, so periodically reload it to
    // pull fresh data. Skip the reload while a tracked course is already open, so we never
    // wipe the highlighted Add button out from under you. A ~30s reload is human-paced.
    const stNow = monitor ? monitor.getState() : {};
    const anyOpen = Object.keys(stNow).some(c => stNow[c].status === 'available');
    if (!anyOpen && Date.now() - lastReloadAt >= PORTAL_REFRESH_MS) {
      lastReloadAt = Date.now();
      try { monitorWin.webContents.reload(); } catch (_) {}
      monitorStatus('info', 'Refreshing the portal for current seats…');
      return; // let the page load; the next tick reads fresh data
    }

    let readings;
    try {
      readings = await monitorWin.webContents.executeJavaScript(reader, true);
      monitorFails = 0;
    } catch (e) {
      // Page reloading / navigating / temporary disconnect: tolerate a few, then stop.
      monitorFails++;
      monitorStatus('warn', `Could not read the page (reloading?) - attempt ${monitorFails}/${MONITOR_MAX_FAILS}.`);
      if (monitorFails >= MONITOR_MAX_FAILS) {
        stopMonitor();
        monitorStatus('error', 'Page unreadable too many times. Monitoring stopped - reload the portal and start again.');
        if (win && !win.isDestroyed()) win.webContents.send('monitor-stopped');
      }
      return;
    }

    const alerts = monitor.update(readings);
    const found = (readings || []).filter(r => r && r.found).length;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monitor-state', { state: monitor.getState(), found, total: codes.length, ts: Date.now() });
    }

    for (const a of alerts) {
      try {
        notifier.notify({
          title: `SEAT OPEN: ${a.code}`,
          message: `${a.name || a.code} - ${a.seats} seat(s) left. Press Enter / click Add in the portal window. Do NOT click Submit.`,
          sound: true,
          wait: false,
        });
      } catch (_) {}
      grabAttention();
      // Bring the course into view and highlight + focus its Add button (read-only; no click).
      if (monitorWin && !monitorWin.isDestroyed()) {
        try { monitorWin.show(); monitorWin.focus(); } catch (_) {}
        try { await monitorWin.webContents.executeJavaScript(buildHighlightScript(a.code, a.seats, a.name), true); } catch (_) {}
      }
      if (win && !win.isDestroyed()) win.webContents.send('monitor-alert', a);
    }
  }, MONITOR_INTERVAL_MS);

  monitorStatus('info', `Monitoring ${codes.join(', ')}. Log in inside the opened window and keep it open.`);
  return { success: true };
});

ipcMain.handle('stop-monitor', async () => {
  stopMonitor();
  monitorStatus('info', 'Monitoring stopped by you.');
  return { success: true };
});
