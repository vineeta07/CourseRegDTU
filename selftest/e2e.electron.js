// selftest/e2e.electron.js
//
// End-to-end: runs the REAL main.js + UI against a mock portal page.
//  1. Start Monitoring through the app's own button API.
//  2. The portal page breaks for ~2 s (reads fail, like a slow reload / offline):
//     monitoring must NOT stop, and must say it is reloading.
//  3. The page recovers and a seat opens: the course must be added.
//  4. Hide the portal, close the app window: the app must fully quit.
//
// Run:  npm run selftest:e2e

const { app, BrowserWindow } = require('electron');

const PORTAL = `<!doctype html><html><body><ul class="f-list">
  <li class="f-slat"><div class="f-meta"><span class="f-code">EV302</span><span>4 credits</span><span class="left">0left</span></div>
  <span class="f-name">Power Electronics</span><button class="f-btn">Waiting</button></li></ul>
<script>
  window.clicks = 0;
  document.addEventListener('click', e => {
    const b = e.target.closest('.f-btn'); if (!b || b.textContent !== 'Add') return;
    window.clicks++; b.textContent = 'Adding'; setTimeout(() => { b.textContent = 'Drop'; }, 50);
  });
  // ~1.5 s after load: page "breaks" (no <body>, every read throws) for 2 s,
  // then comes back with a seat open.
  setTimeout(() => {
    const body = document.body; document.documentElement.removeChild(body);
    setTimeout(() => {
      document.documentElement.appendChild(body);
      body.querySelector('.left').textContent = '5left'; body.querySelector('.f-btn').textContent = 'Add';
    }, 2000);
  }, 1500);
</script></body></html>`;
process.env.DTU_TEST_PORTAL_URL = 'data:text/html;charset=utf-8,' + encodeURIComponent(PORTAL);

let passed = 0, failed = 0, finished = false;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n        -> ' + JSON.stringify(detail) : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));

require('../main.js');
if (process.env.E2E_TRACE) {
  ['window-all-closed', 'before-quit', 'will-quit', 'quit'].forEach(ev => app.on(ev, () => console.log('EVENT', ev)));
  setInterval(() => console.log('TICK', BrowserWindow.getAllWindows().map(w => w.isDestroyed() ? 'destroyed' : (w.isVisible() ? 'visible' : 'hidden')).join(',')), 1000).unref();
}

app.on('will-quit', () => {
  if (finished) return;
  finished = true;
  ok(true, 'app quit by itself after closing the window (hidden portal did not keep it alive)');
  console.log(`\n${passed}/${passed + failed} end-to-end checks passed.`);
  process.exitCode = failed ? 1 : 0;
});

app.whenReady().then(async () => {
  await wait(1000);
  const main = BrowserWindow.getAllWindows()[0];
  const ui = s => main.webContents.executeJavaScript(s, true);
  const start = await ui('window.electronAPI.startMonitor({ entries: [{ code: "EV302", slot: "" }] })');
  ok(start && start.success, 'Start Monitoring succeeds', start);
  await ui('document.getElementById("monitor-start-btn").classList.add("hidden");document.getElementById("monitor-stop-btn").classList.remove("hidden");');

  await wait(2800); // page is broken now
  const during = await ui('({ hb: document.getElementById("monitor-heartbeat").textContent, log: document.getElementById("monitor-log").textContent })');
  ok(/reloading/i.test(during.hb), 'while the portal is broken the heartbeat says it is reloading', during);
  ok(!/stopped/i.test(during.log), 'monitoring did NOT stop itself during the outage', during.log);

  await wait(2500); // page back, seat opened
  const portal = BrowserWindow.getAllWindows().find(w => w !== main);
  const clicks = await portal.webContents.executeJavaScript('window.clicks', true);
  const after = await ui('document.getElementById("monitor-log").textContent');
  ok(clicks === 1, 'after recovery the course is clicked exactly once', clicks);
  ok(/ADDED ✓/.test(after), 'app log shows ADDED ✓', after);
  ok(/Portal back/.test(after), 'app log shows the portal came back', after);

  const t = await ui('window.electronAPI.togglePortal()');
  ok(t && t.visible === false, 'portal window hidden', t);
  setTimeout(() => {
    if (finished) return;
    finished = true;
    ok(false, 'app should have quit within 5 s of closing its window', BrowserWindow.getAllWindows().length + ' window(s) still open');
    console.log(`\n${passed}/${passed + failed} end-to-end checks passed.`);
    app.exit(1);
  }, 5000);
  main.close();
});
