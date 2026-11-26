// main.js — DTU Seat Monitor. Registers configured courses; never clicks Drop.
//
// Several student logins can run side by side. Each one is an "account": its
// own portal window, its own cookie store (so logins never mix), its own
// in-page watcher and its own course list.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const {
  createMonitor, buildReaderScript, buildAddCourseScript, buildFastWatcherScript,
  classify, PORTAL_URL, FAST_ADD_PREFIX, STOP_FAST_WATCHER_SCRIPT, KEEP_VISIBLE_SCRIPT, MAX_CLICKS_PER_OPENING,
} = require('./monitor');

if (!app) {
  // ELECTRON_RUN_AS_NODE is set (VS Code sets it for its child processes).
  console.error('Electron is running as plain Node. Start with `npm start` (scripts/start.js clears ELECTRON_RUN_AS_NODE).');
  process.exit(1);
}

let win;

// Primary add path: the in-page watcher (DOM click inside the page the moment
// the Register button is enabled). The poll below drives the UI and only clicks itself
// when the watcher is not running (e.g. mid-reload).
const MONITOR_INTERVAL_MS = 150;
const MONITOR_MAX_FAILS = 5;
// If a course still shows an enabled "Register" this long after a click, it was
// ignored: click again, alternating DOM click <-> real mouse click.
const ADD_RETRY_MS = 300;
// After the first DOM click, how long to wait for ANY reaction
// before firing the real-mouse fallback.
const FIRST_FALLBACK_MS = 60;
// Isolated JS world for the watcher: the portal cannot override its console
// or globals, and it cannot see ours.
const WATCHER_WORLD_ID = 1717;
const MAX_ACCOUNTS = 6;
// After a click, if the row is still not registered (and not in progress) this long
// later, the portal refused it: log what it shows.
const NOT_ADDED_AFTER_MS = 3000;
// Read-only: visible error / toast / alert text on the portal page.
const PAGE_MESSAGES_SCRIPT = `(function(){
  var sel='[role=alert],[role=alertdialog],.toast,.alert,.error,.snackbar,[class*=toast],[class*=Toast],[class*=error],[class*=alert],[class*=snack]';
  var chat='[class*=chat],[class*=Chat],[id*=chat],[class*=bot],[class*=assistant],[class*=Assistant]';
  var out=[],els=document.querySelectorAll(sel);
  for(var i=0;i<els.length&&out.length<3;i++){var e=els[i];if(!e.offsetParent&&getComputedStyle(e).position!=='fixed')continue;
    if(e.closest(chat))continue; // the portal's chat assistant is not an error message
    var t=String(e.textContent||'').replace(/\\s+/g,' ').trim();if(t&&t.length<200&&out.indexOf(t)<0)out.push(t);}
  return out.join(' / ').slice(0,250);})()`;

// Globally unique, so a message from one account's page can never be taken
// for another account's.
let nextSessionId = 0;

const accounts = new Map(); // accountId -> account

function newAccount(id) {
  return {
    id,
    label: `Login ${id}`,
    win: null,              // the real browser window the USER logs into
    timer: null,
    monitor: null,          // monitor.js state machine
    fails: 0,
    checkInProgress: false,
    entries: [],
    codes: [],
    reader: null,
    generation: 0,
    sessionId: 0,
    tickCount: 0,
    watcherAlive: false,
    clickedCodes: new Map(), // code -> { at, reported }: clicked Register, awaiting "Registered"
    lastClickLog: new Map(), // code -> ts, to keep the log short
    addAttempts: new Map(),  // code -> { count, lastAt, lastWarn }
  };
}

function getAccount(id) {
  const n = Number(id) || 1;
  if (!accounts.has(n)) accounts.set(n, newAccount(n));
  return accounts.get(n);
}

// Login 1 keeps the default cookie store (existing logins keep working).
// Every other login gets its own persistent store: separate cookies, separate
// session, remembered across restarts.
function partitionFor(id) {
  return id === 1 ? undefined : `persist:dtu-login-${id}`;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function monitorStatus(acc, type, message) {
  send('monitor-status', { accountId: acc.id, type, message, ts: Date.now() });
}

function liveWebContents(acc) {
  return acc.win && !acc.win.isDestroyed() ? acc.win.webContents : null;
}

function portalTitle(acc) {
  return `${acc.label} - DTU portal - log in as this student and keep this window open`;
}

function trustedClick(wc, x, y) {
  const zoom = wc.getZoomFactor(); // CSS px -> DIP
  const px = Math.round(x * zoom), py = Math.round(y * zoom);
  wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
}

function logClick(acc, code, n) {
  const now = Date.now();
  acc.clickedCodes.set(code, { at: now, reported: false });
  if (n === 1) {
    monitorStatus(acc, 'action', `${code}: Register clicked`);
    reportButtonAfterClick(acc, code, acc.sessionId);
  } else if (now - (acc.lastClickLog.get(code) || 0) > 3000) monitorStatus(acc, 'action', `${code}: retry ${n}`);
  else return;
  acc.lastClickLog.set(code, now);
}

// Diagnostic: 1 s after the first click, log what the row's button says, so
// the log shows whether the portal reacted to the click at all. Read-only.
function reportButtonAfterClick(acc, code, sid) {
  setTimeout(async () => {
    const wc = liveWebContents(acc);
    if (!wc || acc.sessionId !== sid || !acc.reader) return;
    let readings;
    try { readings = await wc.executeJavaScript(acc.reader, true); } catch (_) { return; }
    const r = (readings || []).find(x => x && x.code === code);
    if (!r || r.found === false) { monitorStatus(acc, 'info', `${code}: row not visible`); return; }
    const b = r.button || '?';
    let meaning;
    if (b === 'Register') meaning = 'click ignored';
    else if (r.pending || r.added) meaning = 'click accepted';
    else if (r.full) meaning = 'seat taken';
    else if (b === 'Register off') meaning = 'Register now off';
    else meaning = 'unknown state';
    const hidden = acc.win.isMinimized() || !acc.win.isVisible();
    monitorStatus(acc, 'info', `${code}: ${meaning} (${b})` + (hidden ? ', window hidden' : ''));
  }, 1000);
}

// Fallback clicker, used by the poll only while the in-page watcher is not
// running (e.g. right after a reload). DOM click only: it acts on the exact
// Register element, so it can never land on a different button. Real mouse clicks
// are only sent by the watcher, which guards them (see fastWatcherInPage).
async function attemptAdd(acc, code, slot) {
  const wc = liveWebContents(acc);
  if (!wc) return;
  const rec = acc.addAttempts.get(code) || { count: 0, lastAt: 0, lastWarn: 0 };
  if (Date.now() - rec.lastAt < ADD_RETRY_MS) return;
  // Same limit as the watcher: a few clicks per opening, then wait 30 s.
  if (rec.count >= MAX_CLICKS_PER_OPENING) { if (Date.now() - rec.lastAt < 30000) return; rec.count = 0; }
  rec.count++; rec.lastAt = Date.now();
  acc.addAttempts.set(code, rec);

  const res = await wc.executeJavaScript(buildAddCourseScript(code, slot, 'domclick'), true);

  if (!res || !res.found) {
    rec.lastAt = 0; rec.count--; // nothing was clicked, so retry on the next tick
    if (res && res.added) return;
    if (Date.now() - rec.lastWarn < 10000) return;
    rec.lastWarn = Date.now();
    monitorStatus(acc, 'warn', `${code}: Register button not found`);
    console.log(`[${acc.label}][${code}] Register not found`, JSON.stringify(res)); // details in the terminal only
    return;
  }
  if (res.disabled) return;
  logClick(acc, code, rec.count);
}

function configuredFor(acc, code) {
  return acc.entries.find(e => e.code === code);
}

async function installFastWatcher(acc) {
  const wc = liveWebContents(acc);
  if (!wc || !acc.monitor) return false;
  try {
    const r = await wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID,
      [{ code: buildFastWatcherScript(acc.entries, acc.sessionId, ADD_RETRY_MS, FIRST_FALLBACK_MS) }], true);
    acc.watcherAlive = !!(r && r.installed);
  } catch (_) { acc.watcherAlive = false; }
  return acc.watcherAlive;
}

async function fastWatcherAlive(acc) {
  const wc = liveWebContents(acc);
  if (!wc) return false;
  try {
    return !!(await wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID,
      [{ code: '!!(window.__dtuFast&&window.__dtuFast.sid===' + acc.sessionId + ')' }], true));
  } catch (_) { return false; }
}

function onConsoleMessage(acc, event, level, message) {
  // Electron <=34 passes (event, level, message, ...); newer versions put it on event.
  const msg = typeof message === 'string' ? message : (event && event.message) || '';
  if (!msg.startsWith(FAST_ADD_PREFIX) || !acc.monitor) return;
  let r;
  try { r = JSON.parse(msg.slice(FAST_ADD_PREFIX.length)); } catch (_) { return; }
  if (!r || r.sid !== acc.sessionId) return;
  const configured = configuredFor(acc, r.code);
  if (!configured) return; // allowlist: only courses the user entered for THIS login
  const wc = liveWebContents(acc);
  if (r.kind === 'added') {
    if (acc.clickedCodes.delete(r.code)) monitorStatus(acc, 'good', `${r.code}: ADDED ✓`);
    return;
  }
  if (r.kind === 'capped') {
    monitorStatus(acc, 'warn', `${r.code}: no response after ${r.n} clicks, pausing 30 s`);
    return;
  }
  if (r.kind === 'blocked') {
    monitorStatus(acc, 'warn', `${r.code}: click blocked, retrying`);
    return;
  }
  if (r.kind === 'trusted') {
    if (!wc) return;
    if (acc.win.isMinimized() || !acc.win.isVisible()) {
      // No on-screen target for a real mouse event: DOM click instead.
      wc.executeJavaScript(buildAddCourseScript(configured.code, configured.slot, 'domclick'), true).catch(() => {});
    } else {
      trustedClick(wc, r.x, r.y);
    }
  }
  logClick(acc, r.code, r.n); // 'dom': the watcher already clicked inside the page
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
  // Closing the app window must also close every portal, even hidden ones,
  // or an invisible window would keep the app running.
  // Done in 'close' (before teardown): destroying the child from the parent's
  // 'closed' handler races Electron's own child teardown and can hang the app.
  win.on('close', () => {
    for (const acc of accounts.values()) {
      if (acc.timer) stopMonitor(acc);
      if (acc.win && !acc.win.isDestroyed()) acc.win.destroy();
    }
  });
  win.on('closed', () => { win = null; });
}

function createMonitorWindow(acc) {
  const index = [...accounts.keys()].sort((a, b) => a - b).indexOf(acc.id);
  acc.win = new BrowserWindow({
    // No `parent`: a child window is hidden whenever the app window is
    // minimised, which would disable the real-mouse click. The app window's
    // 'close' handler still closes every portal.
    width: 1150, height: 880,
    // Stagger the windows so several logins do not sit exactly on top of each other.
    x: 60 + 40 * Math.max(0, index), y: 40 + 40 * Math.max(0, index),
    title: portalTitle(acc),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition: partitionFor(acc.id),
      // Keep timers, rendering and the watcher at full speed even when this
      // window is behind the app window.
      backgroundThrottling: false,
    },
  });
  const portal = acc.win;
  const wc = portal.webContents;
  // Keep our title, so it is always clear which student this window belongs to.
  portal.on('page-title-updated', e => { e.preventDefault(); portal.setTitle(portalTitle(acc)); });
  wc.on('console-message', (...args) => onConsoleMessage(acc, ...args));
  // A full reload wipes the watcher; put it back as soon as the DOM exists.
  wc.on('did-start-navigation', (e, url, isInPlace, isMainFrame) => {
    // Only a full main-frame navigation wipes the watcher. Iframe and in-page
    // (SPA) navigations must not, or the poll would click alongside it.
    const mainFrame = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame === true;
    const sameDoc = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace === true;
    if (mainFrame && !sameDoc) acc.watcherAlive = false;
  });
  wc.on('dom-ready', () => {
    wc.executeJavaScript(KEEP_VISIBLE_SCRIPT, true).catch(() => {});
    if (acc.monitor) installFastWatcher(acc);
  });
  portal.on('closed', () => {
    if (acc.win === portal) acc.win = null;
    if (acc.timer) {
      stopMonitor(acc);
      monitorStatus(acc, 'warn', 'Portal closed - stopped');
    }
  });
  // Test hook only (selftest/e2e.electron.js); normal runs always use the real portal.
  portal.loadURL(process.env.DTU_TEST_PORTAL_URL || PORTAL_URL);
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

function stopMonitor(acc) {
  if (acc.timer) { clearInterval(acc.timer); acc.timer = null; }
  acc.sessionId = ++nextSessionId; // invalidates any message still in flight
  const wc = liveWebContents(acc);
  if (wc) wc.executeJavaScriptInIsolatedWorld(WATCHER_WORLD_ID, [{ code: STOP_FAST_WATCHER_SCRIPT }]).catch(() => {});
  if (wc && !acc.win.isVisible()) acc.win.show(); // never leave it stranded hidden
  acc.monitor = null;
  acc.checkInProgress = false;
  acc.entries = [];
  acc.codes = [];
  acc.reader = null;
  acc.generation++;
  acc.addAttempts = new Map();
  acc.clickedCodes = new Map();
  acc.lastClickLog = new Map();
  acc.watcherAlive = false;
  send('monitor-stopped', { accountId: acc.id });
  return { success: true };
}

async function monitorTick(acc) {
  if (acc.checkInProgress || !liveWebContents(acc)) return;
  const checkMonitor = acc.monitor;
  if (!checkMonitor || !acc.reader) return;
  acc.checkInProgress = true;
  const currentGeneration = acc.generation;
  try {
    // Every ~1.5 s make sure the fast watcher is still installed.
    if (acc.tickCount++ % 10 === 0) {
      acc.watcherAlive = await fastWatcherAlive(acc);
      if (!acc.watcherAlive) await installFastWatcher(acc);
    }

    let readings;
    const wasDown = acc.fails >= MONITOR_MAX_FAILS;
    try {
      readings = await acc.win.webContents.executeJavaScript(acc.reader, true);
      acc.fails = 0;
    } catch (e) {
      // Page reloading / navigating / network blip. Never give up on our own:
      // a slow reload must not silently end monitoring. Keep retrying and say so.
      acc.fails++;
      if (acc.fails === MONITOR_MAX_FAILS) monitorStatus(acc, 'warn', 'Portal reloading - waiting');
      send('monitor-state', { accountId: acc.id, state: checkMonitor.getState(), found: 0, total: acc.codes.length, ts: Date.now(), reloading: true });
      return;
    }
    if (wasDown) monitorStatus(acc, 'info', 'Portal back');
    if (acc.monitor !== checkMonitor || acc.generation !== currentGeneration) return;

    const alerts = checkMonitor.update(readings);
    const found = (readings || []).filter(r => r && r.found).length;
    send('monitor-state', { accountId: acc.id, state: checkMonitor.getState(), found, total: acc.codes.length, ts: Date.now() });
    for (const a of alerts) monitorStatus(acc, 'info', `${a.code}: ${a.seats} seat open`);

    for (const reading of (readings || [])) {
      if (acc.generation !== currentGeneration) break;
      if (!reading || reading.found === false) continue;
      if (classify(reading) !== 'available') {
        // Clicked, but a few seconds later the row is neither added nor in
        // flight: the portal refused it. Say what the row and page show.
        const click = acc.clickedCodes.get(reading.code);
        const waited = click ? Date.now() - click.at : 0;
        if (click && !click.reported && !reading.added && (reading.pending ? waited > 15000 : waited > NOT_ADDED_AFTER_MS)) {
          click.reported = true;
          let msg = '';
          try { msg = await acc.win.webContents.executeJavaScript(PAGE_MESSAGES_SCRIPT, true); } catch (_) {}
          monitorStatus(acc, 'warn', `${reading.code}: NOT added (${reading.button || '?'})` + (msg ? ` - ${msg}` : ''));
        }
        if (reading.added && acc.clickedCodes.delete(reading.code)) monitorStatus(acc, 'good', `${reading.code}: ADDED ✓`);
        if (reading.added || reading.full) acc.addAttempts.delete(reading.code); // opening over
        if (reading.full || reading.added) checkMonitor.resetCode(reading.code);
        continue;
      }
      // The watcher already clicks within ~1 ms of the button appearing; the
      // poll only clicks when the watcher is missing (page mid-reload).
      if (acc.watcherAlive) continue;
      const configured = configuredFor(acc, reading.code);
      if (!configured) continue;
      const readSlot = String(reading.slot || '').trim().toUpperCase();
      if (configured.slot && readSlot && configured.slot !== readSlot) continue;
      if (!liveWebContents(acc)) break;
      try {
        await attemptAdd(acc, configured.code, configured.slot);
      } catch (e) {
        monitorStatus(acc, 'warn', `${reading.code}: add error: ${e && e.message}`);
      }
    }
  } finally {
    acc.checkInProgress = false;
  }
}

ipcMain.handle('start-monitor', async (event, data) => {
  const id = Number(data && data.accountId) || 1;
  if (!accounts.has(id) && accounts.size >= MAX_ACCOUNTS) {
    return { success: false, error: `At most ${MAX_ACCOUNTS} logins at once.` };
  }
  const acc = getAccount(id);
  const label = String((data && data.label) || '').trim().slice(0, 40);
  if (label) acc.label = label;

  const entries = ((data && data.entries) || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter((e, index, all) => e.code && all.findIndex(x => x.code === e.code) === index);
  const codes = entries.map(e => e.code);
  if (codes.length === 0) return { success: false, error: 'Add at least one course code to monitor.' };
  if (acc.timer) return { success: false, error: 'This login is already being monitored.' };

  acc.monitor = createMonitor(codes);
  acc.sessionId = ++nextSessionId;
  acc.generation++;
  acc.entries = entries;
  acc.codes = codes;
  acc.reader = buildReaderScript(codes);
  acc.fails = 0;
  acc.checkInProgress = false;
  acc.addAttempts = new Map();
  acc.clickedCodes = new Map();
  acc.lastClickLog = new Map();
  acc.watcherAlive = false;
  acc.tickCount = 0;

  // Open a real browser window and let the USER log in and pass any security
  // check themselves.
  if (!liveWebContents(acc)) {
    createMonitorWindow(acc);
  } else {
    acc.win.setTitle(portalTitle(acc));
    acc.win.show();
    acc.win.focus();
    installFastWatcher(acc);
  }

  acc.timer = setInterval(() => monitorTick(acc), MONITOR_INTERVAL_MS);
  monitorStatus(acc, 'info', `Watching ${codes.join(', ')}`);
  // Two logins on the same course race each other for the same seat.
  for (const other of accounts.values()) {
    if (other === acc || !other.timer) continue;
    const shared = codes.filter(c => other.codes.includes(c));
    if (shared.length) monitorStatus(acc, 'warn', `${shared.join(', ')} also in ${other.label}`);
  }
  return { success: true };
});

ipcMain.handle('stop-monitor', async (event, accountId) => {
  const acc = accounts.get(Number(accountId) || 1);
  if (!acc) return { success: true };
  stopMonitor(acc);
  monitorStatus(acc, 'info', 'Stopped');
  return { success: true };
});

// Removing a login from the app: stop it and close its portal window.
// Its saved cookies stay, so adding it back later keeps the login.
ipcMain.handle('remove-account', async (event, accountId) => {
  const acc = accounts.get(Number(accountId));
  if (!acc) return { success: true };
  if (acc.timer) stopMonitor(acc);
  if (acc.win && !acc.win.isDestroyed()) acc.win.destroy();
  accounts.delete(acc.id);
  return { success: true };
});
