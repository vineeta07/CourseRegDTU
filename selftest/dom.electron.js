// selftest/dom.electron.js
//
// Runs the real Add scripts inside Electron against a mock portal page and
// clicks with sendInputEvent, the same way main.js does. The mock's Add
// buttons ignore untrusted clicks, as some real portals do, and the page
// disables console.debug, as many production sites do.
//
// Run:  npm run selftest:dom

const { app, BrowserWindow } = require('electron');
const {
  buildAddCourseScript, buildReaderScript, buildFastWatcherScript, classify, FAST_ADD_PREFIX, KEEP_VISIBLE_SCRIPT,
} = require('../monitor.js');

const PAGE = `<!doctype html><html><body style="margin:0">
<div id="root"><div class="list">
  <div class="row"><span>HU426</span><span>Language And Social Media</span><span> E4 </span><span>5 left</span><button class="add">+ Add</button></div>
  <div class="row"><span>CS318</span><span>Compilers</span><span> E2 </span><span>Added</span><button>Drop</button></div>
  ${Array.from({ length: 30 }, (_, i) => `<div class="row"><span>XX${100 + i}</span><span>Filler</span><span>Full</span></div>`).join('')}
  <div class="row"><span>EV302</span><span>Environmental Studies</span><span> E3 </span><span>2 left</span><button class="add">+ Add</button></div>
  <div class="row"><span>PE306N</span><span>Sports</span><span> E1 </span><span>3 left</span><button class="add">+ Add</button></div>
  <div class="row"><span>12</span><span>CE201</span><span>STRUCTURES</span><span>4</span><span> E2 </span><span>9 left</span><button class="add">+ Add</button></div>
  <div class="card"><div class="hd"><b>7</b><b>ME301</b><i>THERMO</i></div><div class="bd"><p>E2</p><p>4 left</p></div><div class="ft"><div><button class="add"><span>+</span> <span>Add</span></button></div></div></div>
  <div class="row" id="late"><span>MA202</span><span>Probability</span><span> E2 </span><span class="st">Full</span><span class="slotbtn"></span></div>
</div></div>
<script>
  console.debug = function () {};       // production sites often do this
  window.clicks = [];
  document.addEventListener('click', e => {
    const b = e.target.closest('button.add');
    if (!b) return;
    const row = b.closest('.row');
    window.clicks.push({ code: row.firstElementChild.textContent, trusted: e.isTrusted, at: performance.timeOrigin + performance.now() });
    if (!e.isTrusted) return;            // portal ignores synthetic clicks
    row.querySelector('span:nth-child(4)').textContent = 'Added';
    b.textContent = 'Drop'; b.className = '';
  });
  window.openSeat = function () {         // a seat opens on the live page
    const row = document.getElementById('late');
    row.querySelector('.st').textContent = '1 left';
    row.querySelector('.slotbtn').innerHTML = '<button class="add">+ Add</button>';
    return performance.timeOrigin + performance.now();
  };
</script></body></html>`;

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail ? '\n        -> ' + JSON.stringify(detail) : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function trustedClick(wc, x, y) {
  const z = wc.getZoomFactor();
  const px = Math.round(x * z), py = Math.round(y * z);
  wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
}

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 900, height: 500, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const wc = win.webContents;
  const run = s => wc.executeJavaScript(s, true);

  // ---- locate + trusted click ----
  const loc = await run(buildAddCourseScript('EV302', 'E3', 'locate'));
  ok(loc.found && /EV302/.test(loc.rowText) && !/HU426/.test(loc.rowText), 'locates EV302 row, not first Add on page', loc);
  ok(!loc.covered, 'EV302 button is scrolled into view and hit-testable', loc);
  trustedClick(wc, loc.x, loc.y);
  await wait(200);
  const clicks = await run('window.clicks');
  ok(clicks.length === 1 && clicks[0].code === 'EV302' && clicks[0].trusted, 'real click hits EV302 only and is trusted', clicks);

  const readings = await run(buildReaderScript(['EV302']));
  ok(readings[0].found && classify(readings[0]) === 'registered', 'reader sees EV302 as Added after click', readings);
  const after = await run(buildAddCourseScript('EV302', 'E3', 'locate'));
  ok(!after.found && after.added, 'no Add button for EV302 once added (no double click)', after);

  const wrongSlot = await run(buildAddCourseScript('PE306N', 'E4', 'locate'));
  ok(!wrongSlot.found, 'slot mismatch is refused', wrongSlot);

  const dom = await run(buildAddCourseScript('HU426', 'E4', 'domclick'));
  const c2 = await run('window.clicks');
  ok(dom.found && c2.length === 2 && c2[1].code === 'HU426' && c2[1].trusted === false,
    'DOM-click fallback hits HU426 (untrusted, as expected)', c2);

  // Glued text around the code: "12CE201STRUCTURES4 E2 9 left+ Add".
  const glued = await run(buildAddCourseScript('CE201', 'E2', 'locate'));
  ok(glued.found && /CE201/.test(glued.rowText) && !/EV302|MA202/.test(glued.rowText), 'finds Add when code is glued to serial no. / CAPS name / credits', glued);
  const r2 = await run(buildReaderScript(['CE201']));
  ok(classify(r2[0]) === 'available', 'reader sees glued CE201 as available', r2);
  // Card layout: code in header, button nested in footer.
  const card = await run(buildAddCourseScript('ME301', 'E2', 'locate'));
  ok(card.found && /ME301/.test(card.rowText), 'finds Add in card layout (code in header, button in footer)', card);
  const ghost = await run(buildAddCourseScript('ZZ999', '', 'locate'));
  ok(!ghost.found && ghost.codeNodes === 0 && Array.isArray(ghost.rejected), 'unknown course returns diagnostics, no click', ghost);

  // ---- watcher on a page that IGNORES DOM clicks: DOM first, real mouse 400 ms later ----
  const SID = 7;
  const reports = [];
  wc.on('console-message', (event, level, message) => {
    const msg = typeof message === 'string' ? message : (event && event.message) || '';
    if (!msg.startsWith(FAST_ADD_PREFIX)) return;
    const r = JSON.parse(msg.slice(FAST_ADD_PREFIX.length));
    reports.push(r);
    if (r.sid === SID && r.kind === 'trusted') trustedClick(wc, r.x, r.y); // what main.js does
  });
  const inst = await wc.executeJavaScriptInIsolatedWorld(1717,
    [{ code: buildFastWatcherScript([{ code: 'MA202', slot: 'E2' }], SID, 300, 60) }], true);
  ok(inst && inst.installed, 'watcher installs in isolated world', inst);
  await wait(100);
  ok(reports.length === 0, 'watcher stays quiet while MA202 is Full', reports);

  const openedAt = await run('window.openSeat()');
  await wait(800);
  const c3 = (await run('window.clicks')).filter(c => c.code === 'MA202');
  ok(c3.length === 2 && !c3[0].trusted && c3[1].trusted,
    'DOM click first, then ONE real-mouse fallback (page console.debug disabled)', { reports, c3 });
  if (c3.length === 2) {
    const first = c3[0].at - openedAt, fallback = c3[1].at - openedAt;
    ok(first < 20, `seat-open -> DOM click ${first.toFixed(1)} ms`, first);
    ok(fallback < 120, `seat-open -> real-mouse fallback ${fallback.toFixed(0)} ms`, fallback);
  }
  ok(/Added/.test(await run('document.getElementById("late").textContent')), 'MA202 row shows Added', null);
  await wait(500); // the watcher re-checks one retry-gap after its last click
  ok(reports.some(r => r.kind === 'added' && r.code === 'MA202'), 'watcher reports "added"', reports);

  // ---- the real portal's structure (from the live log) ----
  // ul.f-list > li.f-slat > div.f-meta > span.f-code ; button text Add / Adding / Drop / Waiting
  const slat = (code, left, btn, name) =>
    `<li class="f-slat"><div class="f-meta"><span class="f-code">${code}</span><span>4 credits</span><span class="left">${left}</span></div>` +
    `<span class="f-name">${name}</span><button class="f-btn">${btn}</button></li>`;
  const PORTAL = `<!doctype html><html><body><ul class="f-list">
    ${slat('EV301', '12left', 'Add', 'Battery Systems')}
    ${slat('EV302', '0left', 'Waiting', 'Power Electronics Converters and Drives for Electric Vehicles')}
    ${slat('EV303', '72left', 'Add', 'Charging Infrastructure')}
    <li class="f-slat"><div class="f-meta"><span class="f-code">EE316n</span><span>4 credits</span></div><span class="f-name">Switch Mode Power Supplies</span><button class="f-btn" id="ee">Add</button></li>
    ${Array.from({ length: 22 }, (_, i) => slat('EE' + (400 + i), '3left', 'Add', 'Filler')).join('')}
  </ul><script>
    window.clicks = [];
    document.addEventListener('click', e => {
      const b = e.target.closest('.f-btn'); if (!b || b.textContent !== 'Add') return;
      const li = b.closest('li');
      window.clicks.push({ code: li.querySelector('.f-code').textContent, trusted: e.isTrusted, at: performance.timeOrigin + performance.now() });
      b.textContent = 'Adding'; setTimeout(() => { b.textContent = 'Drop'; }, 60); // accepts DOM clicks
    });
    window.openSeat = () => {
      const li = [...document.querySelectorAll('li')].find(l => l.querySelector('.f-code').textContent === 'EV302');
      li.querySelector('.left').textContent = '72left'; li.querySelector('.f-btn').textContent = 'Add';
      return performance.timeOrigin + performance.now();
    };
  </script></body></html>`;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PORTAL));

  const waiting = (await run(buildReaderScript(['EV302'])))[0];
  ok(classify(waiting) === 'full', 'portal row with "Waiting" reads as Full (not "checking")', waiting);

  reports.length = 0;
  await wc.executeJavaScriptInIsolatedWorld(1717, [{ code: buildFastWatcherScript([{ code: 'EV302', slot: '' }], SID, 300, 60) }], true);
  await wait(50);
  ok(reports.length === 0, 'no click while EV302 is Waiting (other courses\' Add untouched)', reports);
  const open = (await run(buildReaderScript(['EV303'])))[0];
  ok(classify(open) === 'available' && open.seats === 72 && open.name === 'Charging Infrastructure',
    'reader: 72 seats + correct name from the real li.f-slat row', open);
  const ee = (await run(buildReaderScript(['EE316N'])))[0];
  ok(classify(ee) === 'available' && ee.name === 'Switch Mode Power Supplies',
    'EE316n: plain "Add", no seat count -> available (was "checking")', ee);
  await run('document.getElementById("ee").textContent = "Pending"');
  const eeP = (await run(buildReaderScript(['EE316N'])))[0];
  ok(classify(eeP) === 'unknown' && eeP.button === 'Pending', 'unknown portal state exposes its button word', eeP);
  const opened = await run('window.openSeat()');
  await wait(600);
  const pc = await run('window.clicks');
  ok(pc.length === 1 && pc[0].code === 'EV302' && !pc[0].trusted, 'exactly one DOM click, on EV302 only (no retry while "Adding")', pc);
  if (pc.length) ok(pc[0].at - opened < 20, `seat-open -> EV302 DOM click ${(pc[0].at - opened).toFixed(1)} ms`, null);
  const done = (await run(buildReaderScript(['EV302'])))[0];
  ok(classify(done) === 'registered' && done.name === 'Power Electronics Converters and Drives for Electric Vehicles',
    'reader shows EV302 ADDED (with name) once button says Drop', done);
  ok(reports.some(r => r.kind === 'added' && r.code === 'EV302'), 'watcher reports EV302 added', reports);

  // ---- HIDDEN portal window: the portal's own polling timer must keep
  // running and the in-page DOM click must still fire instantly ----
  const HIDDEN = `<!doctype html><html><body><ul class="f-list">
    ${slat('ME318N', '0left', 'Waiting', 'Reliability')}${slat('ME319', '4left', 'Add', 'Other')}
  </ul><script>
    window.ticks = 0; window.clicks = [];
    const li = document.querySelector('li');
    setInterval(() => {                     // the portal polling its server
      window.ticks++;
      if (window.ticks === 5) { li.querySelector('.left').textContent = '1left'; li.querySelector('.f-btn').textContent = 'Add'; window.openedAt = performance.timeOrigin + performance.now(); }
    }, 100);
    document.addEventListener('click', e => {
      const b = e.target.closest('.f-btn'); if (!b || b.textContent !== 'Add') return;
      window.clicks.push({ code: b.closest('li').querySelector('.f-code').textContent, at: performance.timeOrigin + performance.now() });
      b.textContent = 'Adding'; setTimeout(() => { b.textContent = 'Drop'; }, 50);
    });
  </script></body></html>`;
  await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(HIDDEN));
  await run(KEEP_VISIBLE_SCRIPT);
  win.hide();
  reports.length = 0;
  await wc.executeJavaScriptInIsolatedWorld(1717, [{ code: buildFastWatcherScript([{ code: 'ME318N', slot: '' }], SID, 300, 60) }], true);
  await wait(1200);
  const h = await run('({ ticks: window.ticks, clicks: window.clicks, openedAt: window.openedAt, vis: document.visibilityState })');
  ok(!win.isVisible() && h.ticks >= 9, `hidden window: portal timers keep running (${h.ticks} ticks/1.2 s)`, h);
  ok(h.vis === 'visible', 'hidden window: page still believes it is visible (won\'t pause its refresh)', h);
  ok(h.clicks.length === 1 && h.clicks[0].code === 'ME318N', 'hidden window: exactly one click, on ME318N', h);
  if (h.clicks.length) ok(h.clicks[0].at - h.openedAt < 20, `hidden window: seat-open -> DOM click ${(h.clicks[0].at - h.openedAt).toFixed(1)} ms`, h);
  ok(reports.some(r => r.kind === 'added'), 'hidden window: watcher reports added', reports);

  console.log(`\n${passed}/${passed + failed} DOM checks passed.`);
  app.exit(failed ? 1 : 0);
});
