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
let activeEntries = [];
let activeCodes = [];
let activeReader = null;
let configurationGeneration = 0;
let seatObserverActive = false;
let currentSeatObserver = null;
const MONITOR_INTERVAL_MS = 10;
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
  activeEntries = [];
  activeCodes = [];
  activeReader = null;
  configurationGeneration++;
  seatObserverActive = false;
  currentSeatObserver = null;
  return { success: true };
}

function monitorStatus(type, message) {
  if (win && !win.isDestroyed()) win.webContents.send('monitor-status', { type, message });
}

ipcMain.handle('start-monitor', async (event, data) => {
  const entries = ((data && data.entries) || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter((e, index, all) =>
    e.code && all.findIndex(x => x.code === e.code && x.slot === e.slot) === index
  );
  const codes = entries.map(e => e.code);
  if (codes.length === 0) return { success: false, error: 'Add at least one course code to monitor.' };
  if (monitorTimer) return { success: false, error: 'Monitor is already running.' };

  monitor = createMonitor(codes);
  configurationGeneration++;
  activeEntries = entries;
  activeCodes = codes;
  activeReader = buildReaderScript(codes);
  currentSeatObserver = buildSeatObserverScript(entries);
  seatObserverActive = false;
  configurationGeneration++;
  monitorFails = 0;
  attemptedSlots = new Set();
  monitorCheckInProgress = false;
  monitorAlertedCodes = new Set();
  lastReloadAt = Date.now();
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
    const checkMonitor = monitor;
    if (!checkMonitor || !activeReader) {
      monitorCheckInProgress = false;
      return;
    }
    const currentGeneration = configurationGeneration;

    let readings;
    try {
      if (!seatObserverActive) {
        try {
          const observerResult = await monitorWin.webContents.executeJavaScript(currentSeatObserver, true);
          seatObserverActive = !!(observerResult && observerResult.installed);
        } catch (_) {}
      }
      readings = await monitorWin.webContents.executeJavaScript(activeReader, true);
      monitorFails = 0;
    } catch (e) {
      // Page reloading / navigating / temporary disconnect: tolerate a few, then stop.
      seatObserverActive = false;
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

    if (monitor !== checkMonitor) {
      monitorCheckInProgress = false;
      return;
    }
    const alerts = checkMonitor.update(readings);
    const found = (readings || []).filter(r => r && r.found).length;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monitor-state', { state: checkMonitor.getState(), found, total: activeCodes.length, ts: Date.now() });
    }

    for (const reading of (readings || [])) {
      if (!reading || reading.found === false) continue;
      if (reading.full || reading.added) {
        monitorAlertedCodes.delete(reading.code);
        const releasedSlot = String(reading.slot || '').trim().toUpperCase();
        if (releasedSlot) attemptedSlots.delete(releasedSlot);
        checkMonitor.resetCode(reading.code);
      }
    }

    for (const a of alerts) {
      if (configurationGeneration !== currentGeneration) continue;
      const configured = activeEntries.find(e => e.code === a.code);
      if (!configured) continue;
      const stillConfiguredByUI = activeEntries.some(e =>
        e.code === a.code &&
        (!e.slot || !a.slot || e.slot === String(a.slot).trim().toUpperCase())
      );
      if (!stillConfiguredByUI) continue;
      const configuredSlot = configured ? configured.slot : '';
      if (configuredSlot && String(a.slot || '').trim().toUpperCase() &&
          configuredSlot !== String(a.slot || '').trim().toUpperCase()) continue;
      const slot = String(a.slot || '').trim().toUpperCase();
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
      if (!seatObserverActive && monitorWin && !monitorWin.isDestroyed()) {
        if (configurationGeneration !== currentGeneration ||
            !activeEntries.some(e => e.code === a.code)) continue;
        let actionResult = null;
        try { actionResult = await monitorWin.webContents.executeJavaScript(buildAddCourseScript(a.code, a.seats, a.name), true); } catch (_) {}
        if (actionResult && actionResult.buttonFound) {
          buttonFound = true;
          addSucceeded = true;
          monitorStatus('info', `${a.code} Add request sent. Do not click the final Submit button.`);
        }
      }
      if (!seatObserverActive && !addSucceeded) {
        if (slot) attemptedSlots.delete(slot);
        checkMonitor.resetCode(a.code);
        if (!buttonFound) monitorStatus('warn', `${a.code} Add button not found yet. Retrying automatically.`);
      }
      if (firstAlert && win && !win.isDestroyed()) win.webContents.send('monitor-alert', a);
    }
    monitorCheckInProgress = false;
  }, MONITOR_INTERVAL_MS);

  monitorStatus('info', `Allowlist active: ${codes.join(', ')}. Only these courses can be added.`);
  return { success: true };
});

ipcMain.handle('stop-monitor', async () => {
  stopMonitor();
  monitorStatus('info', 'Monitoring stopped by you.');
  return { success: true };
});

ipcMain.handle('update-monitor', async (event, data) => {
  if (!monitorTimer) return { success: true, updated: false };
  const entries = ((data && data.entries) || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter((e, index, all) =>
    e.code && all.findIndex(x => x.code === e.code && x.slot === e.slot) === index
  );
  const codes = entries.map(e => e.code);
  if (!codes.length) {
    stopMonitor();
    monitorStatus('warn', 'All courses removed. Monitoring stopped.');
    if (win && !win.isDestroyed()) win.webContents.send('monitor-stopped');
    return { success: true, updated: true };
  }
  activeEntries = entries;
  activeCodes = codes;
  activeReader = buildReaderScript(codes);
  if (monitorWin && !monitorWin.isDestroyed()) {
    try { await monitorWin.webContents.executeJavaScript('window.__dtuExactSeatObserver=false', true); } catch (_) {}
  }
  currentSeatObserver = buildSeatObserverScript(entries);
  seatObserverActive = false;
  monitor = createMonitor(codes);
  attemptedSlots = new Set();
  monitorAlertedCodes = new Set();
  monitorStatus('info', `Configured courses updated: ${codes.join(', ')}.`);
  return { success: true, updated: true };
});
