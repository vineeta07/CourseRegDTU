// main.js — DTU Seat Monitor (read-only). No auto-registration.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const notifier = require('node-notifier');
const { createMonitor, buildReaderScript, buildSeatObserverScript, buildAddCourseScript, PORTAL_URL } = require('./monitor');

let win;

// ---- Read-only seat monitor (new /register/ portal) ----
let monitorWin = null;     // the real browser window the USER logs into
let monitorTimer = null;
let monitor = null;        // monitor.js state machine
let monitorFails = 0;
let attemptedSlots = new Set();
let monitorCheckInProgress = false;
let monitorAlertedCodes = new Set();
const MONITOR_INTERVAL_MS = 50;
const MONITOR_MAX_FAILS = 5;

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
  monitorCheckInProgress = false;
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
  attemptedSlots = new Set();
  monitorCheckInProgress = false;
  monitorAlertedCodes = new Set();
  lastReloadAt = Date.now();
  const reader = buildReaderScript(codes);
  const seatObserver = buildSeatObserverScript(codes);

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
    if (monitorCheckInProgress || !monitorWin || monitorWin.isDestroyed()) return;
    monitorCheckInProgress = true;

    let readings;
    try {
      try { await monitorWin.webContents.executeJavaScript(seatObserver, true); } catch (_) {}
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
      monitorCheckInProgress = false;
      return;
    }

    const alerts = monitor.update(readings);
    const found = (readings || []).filter(r => r && r.found).length;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monitor-state', { state: monitor.getState(), found, total: codes.length, ts: Date.now() });
    }

    for (const reading of (readings || [])) {
      if (!reading || reading.found === false) continue;
      if (reading.full || reading.added) monitorAlertedCodes.delete(reading.code);
    }

    for (const a of alerts) {
      // Try at most one open course from each slot. This allows CH310n:E4 and
      // another course in E1/E2/E3, while preventing duplicate requests for
      // courses that share the same slot.
      const slot = String(a.slot || '').trim().toUpperCase();
      if (slot && attemptedSlots.has(slot)) continue;
      if (slot) attemptedSlots.add(slot);
      const firstAlert = !monitorAlertedCodes.has(a.code);
      if (firstAlert) {
        monitorAlertedCodes.add(a.code);
        try {
          notifier.notify({
            title: `SEAT OPEN: ${a.code}`,
            message: `${a.name || a.code} - ${a.seats} seat(s) left. Attempting to add; do NOT click Submit.`,
            sound: false,
            wait: false,
          });
        } catch (_) {}
      }
      // Select the matching course row and click only its Add control.
      let addSucceeded = false;
      let buttonFound = false;
      if (monitorWin && !monitorWin.isDestroyed()) {
        let actionResult = null;
        try { actionResult = await monitorWin.webContents.executeJavaScript(buildAddCourseScript(a.code, a.seats, a.name), true); } catch (_) {}
        if (actionResult && actionResult.buttonFound) {
          buttonFound = true;
          addSucceeded = true;
          monitorStatus('info', `${a.code} Add request sent. Do not click the final Submit button.`);
        }
      }
      if (!addSucceeded) {
        if (slot) attemptedSlots.delete(slot);
        if (monitor) monitor.resetCode(a.code);
        if (!buttonFound) monitorStatus('warn', `${a.code} Add button not found yet. Retrying automatically.`);
      }
      if (firstAlert && win && !win.isDestroyed()) win.webContents.send('monitor-alert', a);
    }
    monitorCheckInProgress = false;
  }, MONITOR_INTERVAL_MS);

  monitorStatus('info', `Monitoring ${codes.join(', ')}. Log in inside the opened window and keep it open.`);
  return { success: true };
});

ipcMain.handle('stop-monitor', async () => {
  stopMonitor();
  monitorStatus('info', 'Monitoring stopped by you.');
  return { success: true };
});
