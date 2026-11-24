// main.js — DTU Seat Monitor. Adds configured courses; never clicks final Submit.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const {
  createMonitor, buildReaderScript, buildAddCourseScript, buildFastWatcherScript,
  classify, PORTAL_URL, FAST_ADD_PREFIX, STOP_FAST_WATCHER_SCRIPT, KEEP_VISIBLE_SCRIPT,
} = require('./monitor');

if (!app) {
  // ELECTRON_RUN_AS_NODE is set (VS Code sets it for its child processes).
  console.error('Electron is running as plain Node. Start with `npm start` (scripts/start.js clears ELECTRON_RUN_AS_NODE).');
  process.exit(1);
}

let win;

let monitorWin = null;     // the real browser window the USER logs into
let monitorTimer = null;
let monitor = null;        // monitor.js state machine
let monitorFails = 0;
let monitorCheckInProgress = false;
let activeEntries = [];
let activeCodes = [];
let activeReader = null;
let configurationGeneration = 0;
let monitorSessionId = 0;
let tickCount = 0;

// Primary add path: the in-page watcher (DOM click inside the page the moment
// the Add button renders). The poll below drives the UI and only clicks itself
// when the watcher is not running (e.g. mid-reload).
const MONITOR_INTERVAL_MS = 150;
const MONITOR_MAX_FAILS = 5;
// If a course still shows "+ Add" this long after a click, the click was
// ignored: click again, alternating DOM click <-> real mouse click.
const ADD_RETRY_MS = 300;
// After the first DOM click, how long to wait for ANY reaction (Adding/Drop)
// before firing the real-mouse fallback.
const FIRST_FALLBACK_MS = 60;
let watcherAlive = false;
let clickedCodes = new Set(); // courses we clicked Add for, awaiting "Added"
let lastClickLog = new Map(); // code -> ts, to keep the log short
// Isolated JS world for the watcher: the portal cannot override its console
// or globals, and it cannot see ours.
const WATCHER_WORLD_ID = 1717;
let addAttempts = new Map(); // code -> { count, lastAt, lastWarn }

function monitorStatus(type, message) {
  if (win && !win.isDestroyed()) win.webContents.send('monitor-status', { type, message, ts: Date.now() });
}

function liveWebContents() {
  return monitorWin && !monitorWin.isDestroyed() ? monitorWin.webContents : null;
}

function trustedClick(wc, x, y) {
  const zoom = wc.getZoomFactor(); // CSS px -> DIP
  const px = Math.round(x * zoom), py = Math.round(y * zoom);
  wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
}

function logClick(code, n) {
  clickedCodes.add(code);
  const now = Date.now();
  if (n === 1) monitorStatus('action', `${code}: Add clicked`);
  else if (now - (lastClickLog.get(code) || 0) > 3000) monitorStatus('action', `${code}: retrying Add (try ${n})`);
  else return;
  lastClickLog.set(code, now);
}

// Fallback clicker, used by the poll only while the in-page watcher is not
// running (e.g. right after a reload). DOM click only: it acts on the exact
// Add element, so it can never land on a different button. Real mouse clicks
// are only sent by the watcher, which guards them (see fastWatcherInPage).
async function attemptAdd(code, slot) {
  const wc = liveWebContents();
  if (!wc) return;
  const rec = addAttempts.get(code) || { count: 0, lastAt: 0, lastWarn: 0 };
  if (Date.now() - rec.lastAt < ADD_RETRY_MS) return;
  rec.count++; rec.lastAt = Date.now();
  addAttempts.set(code, rec);

  const res = await wc.executeJavaScript(buildAddCourseScript(code, slot, 'domclick'), true);

  if (!res || !res.found) {
    rec.lastAt = 0; rec.count--; // nothing was clicked, so retry on the next tick
    if (res && res.added) return;
    if (Date.now() - rec.lastWarn < 10000) return;
    rec.lastWarn = Date.now();
    monitorStatus('warn', `${code}: seat open but Add button not found - retrying`);
    console.log(`[${code}] Add not found`, JSON.stringify(res)); // details in the terminal only
    return;
  }
  if (res.disabled) return;
  logClick(code, rec.count);
}

function configuredFor(code) {
  return activeEntries.find(e => e.code === code);
}

async function installFastWatcher() {
  const wc = liveWebContents();
  if (!wc || !monitor) return false;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID,
      [{ code: buildFastWatcherScript(activeEntries, monitorSessionId, ADD_RETRY_MS, FIRST_FALLBACK_MS) }], true);
    watcherAlive = !!(r && r.installed);
  } catch (_) { watcherAlive = false; }
  return watcherAlive;
}

async function fastWatcherAlive() {
  const wc = liveWebContents();
  if (!wc) return false;
  try {
    return !!(await wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID,
      [{ code: '!!(window.__dtuFast&&window.__dtuFast.sid===' + monitorSessionId + ')' }], true));
  } catch (_) { return false; }
}

function onConsoleMessage(event, level, message) {
  // Electron <=34 passes (event, level, message, ...); newer versions put it on event.
  const msg = typeof message === 'string' ? message : (event && event.message) || '';
  if (!msg.startsWith(FAST_ADD_PREFIX) || !monitor) return;
  let r;
  try { r = JSON.parse(msg.slice(FAST_ADD_PREFIX.length)); } catch (_) { return; }
  if (!r || r.sid !== monitorSessionId) return;
  const configured = configuredFor(r.code);
  if (!configured) return; // allowlist: only courses the user entered
  const wc = liveWebContents();
  if (r.kind === 'added') {
    if (clickedCodes.delete(r.code)) monitorStatus('good', `${r.code}: ADDED ✓`);
    return;
  }
  if (r.kind === 'blocked') {
    monitorStatus('warn', `${r.code}: page moved during click - blocked it, retrying`);
    return;
  }
  if (r.kind === 'trusted') {
    if (!wc) return;
    if (monitorWin.isMinimized() || !monitorWin.isVisible()) {
      // No on-screen target for a real mouse event: DOM click instead.
      wc.executeJavaScript(buildAddCourseScript(configured.code, configured.slot, 'domclick'), true).catch(() => {});
    } else {
      trustedClick(wc, r.x, r.y);
    }
  }
  logClick(r.code, r.n); // 'dom': the watcher already clicked inside the page
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
  win.loadFile(path.join(__dirname, 'index.html'));
  // Closing the app window must also close the portal, even when it is hidden,
  // or an invisible window would keep the app running.
  // Done in 'close' (before teardown): destroying the child from the parent's
  // 'closed' handler races Electron's own child teardown and can hang the app.
  win.on('close', () => {
    if (monitorTimer) stopMonitor();
    if (monitorWin && !monitorWin.isDestroyed()) monitorWin.destroy();
  });
  win.on('closed', () => { win = null; });
}

function createMonitorWindow() {
  monitorWin = new BrowserWindow({
    width: 1150, height: 880, parent: win,
    title: 'DTU Seat Monitor - log in here and KEEP THIS WINDOW OPEN',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // Keep timers, rendering and the watcher at full speed even when this
      // window is behind the app window.
      backgroundThrottling: false,
    },
  });
  const wc = monitorWin.webContents;
  wc.on('console-message', onConsoleMessage);
  // A full reload wipes the watcher; put it back as soon as the DOM exists.
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    // Only a full main-frame navigation wipes the watcher. Iframe and in-page
    // (SPA) navigations must not, or the poll would click alongside it.
    const mainFrame = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame === true;
    const sameDoc = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace === true;
    if (mainFrame && !sameDoc) watcherAlive = false;
  });
  wc.on('dom-ready', () => {
    wc.executeJavaScript(KEEP_VISIBLE_SCRIPT, true).catch(() => {});
    if (monitor) installFastWatcher();
  });
  monitorWin.on('closed', () => {
    monitorWin = null;
    if (monitorTimer) {
      stopMonitor();
      monitorStatus('warn', 'Monitor window closed - monitoring stopped.');
    }
  });
  // Test hook only (selftest/e2e.electron.js); normal runs always use the real portal.
  monitorWin.loadURL(process.env.DTU_TEST_PORTAL_URL || PORTAL_URL);
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
  monitorSessionId++;
  const wc = liveWebContents();
  if (wc) wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID, [{ code: STOP_FAST_WATCHER_SCRIPT }]).catch(() => {});
  if (wc && !monitorWin.isVisible()) monitorWin.show(); // never leave it stranded hidden
  monitor = null;
  monitorCheckInProgress = false;
  activeEntries = [];
  activeCodes = [];
  activeReader = null;
  configurationGeneration++;
  addAttempts = new Map();
  clickedCodes = new Set();
  lastClickLog = new Map();
  watcherAlive = false;
  if (win && !win.isDestroyed()) win.webContents.send('monitor-stopped');
  return { success: true };
}

async function monitorTick() {
  if (monitorCheckInProgress || !liveWebContents()) return;
  const checkMonitor = monitor;
  if (!checkMonitor || !activeReader) return;
  monitorCheckInProgress = true;
  const currentGeneration = configurationGeneration;
  try {
    // Every ~1.5 s make sure the fast watcher is still installed.
    if (tickCount++ % 10 === 0) {
      watcherAlive = await fastWatcherAlive();
      if (!watcherAlive) await installFastWatcher();
    }

    let readings;
    const wasDown = monitorFails >= MONITOR_MAX_FAILS;
    try {
      readings = await monitorWin.webContents.executeJavaScript(activeReader, true);
      monitorFails = 0;
    } catch (e) {
      // Page reloading / navigating / network blip. Never give up on our own:
      // a slow reload must not silently end monitoring. Keep retrying and say so.
      monitorFails++;
      if (monitorFails === MONITOR_MAX_FAILS) monitorStatus('warn', 'Portal is reloading or offline - still watching, will resume automatically');
      if (win && !win.isDestroyed()) win.webContents.send('monitor-state', { state: checkMonitor.getState(), found: 0, total: activeCodes.length, ts: Date.now(), reloading: true });
      return;
    }
    if (wasDown) monitorStatus('info', 'Portal back - watching');
    if (monitor !== checkMonitor || configurationGeneration !== currentGeneration) return;

    const alerts = checkMonitor.update(readings);
    const found = (readings || []).filter(r => r && r.found).length;
    if (win && !win.isDestroyed()) {
      win.webContents.send('monitor-state', { state: checkMonitor.getState(), found, total: activeCodes.length, ts: Date.now() });
    }
    for (const a of alerts) monitorStatus('info', `${a.code}: seat open (${a.seats} left)`);

    for (const reading of (readings || [])) {
      if (configurationGeneration !== currentGeneration) break;
      if (!reading || reading.found === false) continue;
      if (classify(reading) !== 'available') {
        if (reading.added && clickedCodes.delete(reading.code)) monitorStatus('good', `${reading.code}: ADDED ✓`);
        if (reading.added) addAttempts.delete(reading.code);
        if (reading.full || reading.added) checkMonitor.resetCode(reading.code);
        continue;
      }
      // The watcher already clicks within ~1 ms of the button appearing; the
      // poll only clicks when the watcher is missing (page mid-reload).
      if (watcherAlive) continue;
      const configured = configuredFor(reading.code);
      if (!configured) continue;
      const readSlot = String(reading.slot || '').trim().toUpperCase();
      if (configured.slot && readSlot && configured.slot !== readSlot) continue;
      if (!liveWebContents()) break;
      try {
        await attemptAdd(configured.code, configured.slot);
      } catch (e) {
        monitorStatus('warn', `${reading.code}: add attempt failed: ${e && e.message}`);
      }
    }
  } finally {
    monitorCheckInProgress = false;
  }
}

ipcMain.handle('start-monitor', async (event, data) => {
  const entries = ((data && data.entries) || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter((e, index, all) => e.code && all.findIndex(x => x.code === e.code) === index);
  const codes = entries.map(e => e.code);
  if (codes.length === 0) return { success: false, error: 'Add at least one course code to monitor.' };
  if (monitorTimer) return { success: false, error: 'Monitor is already running.' };

  monitor = createMonitor(codes);
  monitorSessionId++;
  configurationGeneration++;
  activeEntries = entries;
  activeCodes = codes;
  activeReader = buildReaderScript(codes);
  monitorFails = 0;
  monitorCheckInProgress = false;
  addAttempts = new Map();
  clickedCodes = new Set();
  lastClickLog = new Map();
  watcherAlive = false;
  tickCount = 0;

  // Open a real browser window and let the USER log in and pass any security
  // check themselves.
  if (!monitorWin || monitorWin.isDestroyed()) {
    createMonitorWindow();
  } else {
    monitorWin.show();
    monitorWin.focus();
    installFastWatcher();
  }

  monitorTimer = setInterval(monitorTick, MONITOR_INTERVAL_MS);
  monitorStatus('info', `Watching ${codes.join(', ')}`);
  return { success: true };
});

// Hide / show the portal window. Hidden, it keeps running at full speed and
// the in-page DOM click still fires instantly; only the real-mouse fallback is
// skipped (DOM click is used instead).
ipcMain.handle('toggle-portal', async () => {
  if (!monitorWin || monitorWin.isDestroyed()) return { open: false, visible: false };
  if (monitorWin.isVisible() && !monitorWin.isMinimized()) {
    monitorWin.hide();
    monitorStatus('info', 'Portal hidden - still watching and adding');
  } else {
    if (monitorWin.isMinimized()) monitorWin.restore();
    monitorWin.show();
  }
  return { open: true, visible: monitorWin.isVisible() };
});

ipcMain.handle('stop-monitor', async () => {
  stopMonitor();
  monitorStatus('info', 'Monitoring stopped by you.');
  return { success: true };
});
