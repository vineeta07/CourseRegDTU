// selftest/e2e.electron.js
//
// End-to-end: runs the REAL main.js + UI against a mock portal page.
//  1. Two student logins, started through the app's own UI buttons.
//     Login 1 watches EV302 (on the page); Login 2 watches XX999 (not on it).
//  2. The two portal windows have separate cookies.
//  3. The portal page breaks for ~2 s (reads fail, like a slow reload / offline):
//     monitoring must NOT stop, and must say it is reloading.
//  4. The page recovers and a seat opens: Login 1 adds EV302 exactly once;
//     Login 2 clicks nothing (it never touches a course not on ITS list).
//  5. Remove Login 2: its portal closes, Login 1 keeps running.
//  6. Hide the portal, close the app window: the app must fully quit.
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
  const panel = n => `document.querySelector('.account-card[data-account-id="${n}"]')`;
  const portalByTitle = name => BrowserWindow.getAllWindows().find(w => w !== main && !w.isDestroyed() && w.getTitle().startsWith(name));

  // Fill both panels and press Start through the real buttons.
  await ui(`(() => {
    ${panel(1)}.querySelector('.account-name').value = 'Alice';
    ${panel(1)}.querySelector('.course-list input').value = 'EV302';
    document.getElementById('add-account').click();
    ${panel(2)}.querySelector('.account-name').value = 'Bob';
    ${panel(2)}.querySelector('.course-list input').value = 'XX999';
    ${panel(1)}.querySelector('.start-btn').click();
    ${panel(2)}.querySelector('.start-btn').click();
  })()`);
  await wait(400);
  const started = await ui(`[1,2].map(n => document.querySelector('.account-card[data-account-id="'+n+'"] .stop-btn').classList.contains('hidden'))`);
  ok(started[0] === false && started[1] === false, 'both logins started from the UI', started);

  const alice = portalByTitle('Alice'), bob = portalByTitle('Bob');
  ok(!!alice && !!bob && alice !== bob, 'each login has its own portal window, titled with its name',
    BrowserWindow.getAllWindows().map(w => w.getTitle()));
  if (alice && bob) {
    ok(alice.webContents.session !== bob.webContents.session, 'the two portal windows use separate cookie stores');
    await alice.webContents.session.cookies.set({ url: 'https://example.invalid/', name: 'who', value: 'alice' });
    const bobCookies = await bob.webContents.session.cookies.get({ name: 'who' });
    ok(bobCookies.length === 0, "Login 1's cookie is not visible to Login 2", bobCookies);
  }

  await wait(2400); // page is broken now
  const during = await ui(`({ hb: ${panel(1)}.querySelector('.monitor-heartbeat').textContent, log: ${panel(1)}.querySelector('.monitor-log').textContent })`);
  ok(/reloading/i.test(during.hb), 'while the portal is broken the heartbeat says it is reloading', during);
  ok(!/stopped/i.test(during.log), 'monitoring did NOT stop itself during the outage', during.log);

  await wait(2500); // page back, seat opened
  const aliceClicks = alice ? await alice.webContents.executeJavaScript('window.clicks', true) : -1;
  const bobClicks = bob ? await bob.webContents.executeJavaScript('window.clicks', true) : -1;
  const after = await ui(`${panel(1)}.querySelector('.monitor-log').textContent`);
  const bobLog = await ui(`${panel(2)}.querySelector('.monitor-log').textContent`);
  ok(aliceClicks === 1, 'after recovery Login 1 clicks its course exactly once', aliceClicks);
  ok(bobClicks === 0, 'Login 2 clicks nothing (EV302 is not on its list)', bobClicks);
  ok(/ADDED ✓/.test(after), "Login 1's log shows ADDED ✓", after);
  ok(!/ADDED/.test(bobLog), "Login 1's add does not show up in Login 2's log", bobLog);
  ok(/Portal back/.test(after), 'app log shows the portal came back', after);

  // Remove Login 2 (it is running, so the UI asks first: auto-confirm).
  await ui(`window.confirm = () => true; ${panel(2)}.querySelector('.remove-account').click();`);
  await wait(400);
  ok(!bob || bob.isDestroyed(), "removing Login 2 closes its portal window");
  const stillRunning = await ui(`!${panel(1)}.querySelector('.stop-btn').classList.contains('hidden') && !${panel(2)}`);
  ok(stillRunning, 'Login 1 keeps running after Login 2 is removed');

  setTimeout(() => {
    if (finished) return;
    finished = true;
    ok(false, 'app should have quit within 5 s of closing its window', BrowserWindow.getAllWindows().length + ' window(s) still open');
    console.log(`\n${passed}/${passed + failed} end-to-end checks passed.`);
    app.exit(1);
  }, 5000);
  main.close();
});
