// selftest/dom.electron.js
//
// Runs the real Register scripts inside Electron against mock copies of the
// /student/courseRegistration table and clicks with sendInputEvent, the same
// way main.js does. Every row has a Register AND a Drop button, like the real
// page. The top safety rule checked throughout: Drop is never clicked.
//
// Run:  npm run selftest:dom

const { app, BrowserWindow } = require('electron');
const {
  buildAddCourseScript, buildReaderScript, buildFastWatcherScript, classify, FAST_ADD_PREFIX, KEEP_VISIBLE_SCRIPT,
  MAX_CLICKS_PER_OPENING,
} = require('../monitor.js');

// One table row, like the real page: Drop is only clickable for a course you hold.
// opts: off (Register disabled), dim (Register greyed via opacity only), slot, mine (registered).
const row = (name, code, seats, opts = {}) =>
  `<tr><td>${name}</td><td>${code}</td><td>4</td><td>${opts.slot || 'E4'}</td><td class="seats">${seats}</td>` +
  `<td><button class="reg"${opts.off ? ' disabled' : ''}${opts.dim ? ' style="opacity:.5"' : ''}>Register</button></td>` +
  `<td><button class="drop"${opts.mine ? '' : ' disabled'}>Drop</button></td></tr>`;

// behaviour: 'trustedOnly' (ignores script clicks), 'any', 'ignore' (never reacts),
// 'reject' (shows Registering... then back to Register, like a refused request).
const page = (rows, behaviour) => `<!doctype html><html><body style="margin:0">
<table><tbody>
  <tr><td colspan="7"><b>Slot E3</b></td></tr>
  ${row('Compact Modelling and Process Simulation of Semiconductor Devices', 'SC302', 58, { slot: 'E3', dim: true })}
  <tr><td colspan="7"><b>Slot E4</b></td></tr>
  ${rows}
  ${Array.from({ length: 25 }, (_, i) => row('Filler ' + i, 'FL' + (100 + i), 0, { off: true })).join('')}
</tbody></table>
<script>
  console.debug = function () {};          // production sites often do this
  window.clicks = [];
  const codeOf = b => b.closest('tr').children[1].textContent;
  document.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    window.clicks.push({ code: codeOf(b), btn: b.textContent, trusted: e.isTrusted, at: performance.timeOrigin + performance.now() });
    if (b.textContent !== 'Register' || b.disabled) return;
    const mode = ${JSON.stringify(behaviour)};
    if (mode === 'ignore' || (mode === 'trustedOnly' && !e.isTrusted)) return;
    if (mode === 'reject') { b.textContent = 'Registering...'; setTimeout(() => { b.textContent = 'Register'; }, 40); return; }
    const s = b.closest('tr').querySelector('.seats'); s.textContent = String(Math.max(0, +s.textContent - 1));
    // Real portal: Register greys out, Drop switches on, and every other
    // Register in the same slot greys out (one course per slot).
    const tr = b.closest('tr'), slot = tr.children[3].textContent;
    b.disabled = true; tr.querySelector('.drop').disabled = false;
    document.querySelectorAll('tr').forEach(t => { if (t.children[3] && t.children[3].textContent === slot) t.querySelector('.reg').disabled = true; });
  });
  window.openSeat = code => {                // a seat opens on the live page
    const tr = [...document.querySelectorAll('tr')].find(t => t.children[1] && t.children[1].textContent === code);
    tr.querySelector('.seats').textContent = '1';
    const b = tr.querySelector('.reg'); b.disabled = false; b.style.opacity = '';
    return performance.timeOrigin + performance.now();
  };
</script></body></html>`;

const SCREENSHOT_ROWS =
  row('Polymer Processing Technique', 'CH310n', 53) +
  row('Machine Learning', 'MC310', 0, { off: true }) +
  row('Applied Entrepreneurship and Venturing', 'CD302', 0, { off: true }) +
  row('Power Electronics Converters and Drives for Electric Vehicles', 'EV302', 72) +
  row('Public Finance And Policy', 'HU404', 0, { off: true }) +
  row('cyclonic risk and management', 'CE328', 48, { dim: true }) +
  row('Deep Learning', 'CS318', 99, { off: true }) +
  row('Information Theory and Coding', 'EC328', 0, { off: true, slot: 'E2' }) +
  row('Pattern Recognition and Applications', 'IT308', 0, { off: true, slot: 'E1', mine: true }) +
  row('GAS DYNAMICS & JET PROPULSION', 'ME306n', 293, { off: true, slot: 'E1' });

let passed = 0, failed = 0;
function ok(cond, name, detail) {
  if (cond) { passed++; console.log('  PASS  ' + name); }
  else { failed++; console.log('  FAIL  ' + name + (detail !== undefined ? '\n        -> ' + JSON.stringify(detail) : '')); }
}
const wait = ms => new Promise(r => setTimeout(r, ms));
function trustedClick(wc, x, y) {
  const z = wc.getZoomFactor();
  const px = Math.round(x * z), py = Math.round(y * z);
  wc.sendInputEvent({ type: 'mouseMove', x: px, y: py });
  wc.sendInputEvent({ type: 'mouseDown', x: px, y: py, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', x: px, y: py, button: 'left', clickCount: 1 });
}
const noDrops = clicks => !clicks.some(c => c.btn === 'Drop');

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: true, width: 1100, height: 600, webPreferences: { contextIsolation: true, backgroundThrottling: false } });
  const wc = win.webContents;
  const run = s => wc.executeJavaScript(s, true);
  const load = async html => { await wc.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); };

  // Every watcher report; main.js's job (real mouse click on 'trusted') is
  // replayed here unless a test swaps in its own handler.
  let reports = [], onTrusted = r => trustedClick(wc, r.x, r.y);
  wc.on('console-message', (event, level, message) => {
    const msg = typeof message === 'string' ? message : (event && event.message) || '';
    if (!msg.startsWith(FAST_ADD_PREFIX)) return;
    const r = JSON.parse(msg.slice(FAST_ADD_PREFIX.length));
    reports.push(r);
    if (r.kind === 'trusted') onTrusted(r);
  });
  let sid = 10;
  const watch = entries => wc.executeJavaScriptInIsolatedWorld(1717, [{ code: buildFastWatcherScript(entries, ++sid, 300, 60) }], true);

  // ---- 1. reading the table, exactly as in the screenshot ----
  await load(page(SCREENSHOT_ROWS, 'trustedOnly'));
  const rd = await run(buildReaderScript(['HU404', 'EV302', 'CE328', 'CH310N', 'CS318', 'SC302', 'ZZ999']));
  const by = Object.fromEntries(rd.map(r => [r.code, r]));
  ok(classify(by.HU404) === 'full' && by.HU404.seats === 0 && by.HU404.slot === 'E4' && by.HU404.name === 'Public Finance And Policy',
    'HU404: 0 seats -> Full, name + slot read', by.HU404);
  ok(classify(by.EV302) === 'available' && by.EV302.seats === 72, 'EV302: 72 seats + Register on -> available', by.EV302);
  ok(classify(by.CE328) === 'unknown' && by.CE328.button === 'Register off', 'CE328: 48 seats but greyed Register -> not clickable', by.CE328);
  ok(classify(by.CS318) === 'unknown' && by.CS318.registerOff, 'CS318: 99 seats but disabled Register -> not clickable', by.CS318);
  ok(classify(by.CH310N) === 'available' && by.CH310N.seats === 53, 'CH310n (lowercase on page) found as CH310N', by.CH310N);
  ok(classify(by.SC302) === 'unknown' && by.SC302.slot === 'E3', 'SC302 in slot E3 read correctly', by.SC302);
  ok(by.ZZ999.found === false, 'course not on page -> not found', by.ZZ999);
  ok(!rd.some(r => r.added), 'dim Drop buttons on every row do NOT make a course read as registered', rd.map(r => r.code + ':' + r.added));
  const e1 = await run(buildReaderScript(['IT308', 'ME306N']));
  ok(classify(e1[0]) === 'registered', 'IT308 (green row: Register grey, Drop live) reads REGISTERED', e1[0]);
  ok(classify(e1[1]) !== 'available' && !e1[1].added, 'ME306n (293 seats, Register grey: slot taken) is not clickable and not registered', e1[1]);
  ok(!(await run(buildAddCourseScript('IT308', '', 'locate'))).found, 'registered IT308: nothing to click');

  // ---- 2. locate + real mouse click hits EV302's Register only ----
  const loc = await run(buildAddCourseScript('EV302', 'E4', 'locate'));
  ok(loc.found && /EV302/.test(loc.rowText) && !/CH310n|HU404/.test(loc.rowText) && !loc.covered, 'locates EV302 Register, on screen', loc);
  trustedClick(wc, loc.x, loc.y);
  await wait(200);
  let clicks = await run('window.clicks');
  ok(clicks.length === 1 && clicks[0].code === 'EV302' && clicks[0].btn === 'Register' && clicks[0].trusted, 'real click lands on EV302 Register only', clicks);
  const ev = (await run(buildReaderScript(['EV302'])))[0];
  ok(classify(ev) === 'registered', 'EV302 reads REGISTERED after the click', ev);
  const again = await run(buildAddCourseScript('EV302', 'E4', 'locate'));
  ok(!again.found && again.added, 'no second click once registered', again);
  ok(!(await run(buildAddCourseScript('CH310N', 'E3', 'locate'))).found, 'slot mismatch (CH310n is E4, asked E3) refused');
  ok(!(await run(buildAddCourseScript('HU404', '', 'locate'))).found, 'HU404 with 0 seats: nothing to click');
  await run(buildAddCourseScript('CE328', '', 'domclick'));
  clicks = await run('window.clicks');
  ok(!clicks.some(c => c.code === 'CE328'), 'greyed Register (CE328) is never clicked', clicks);

  // ---- 3. watcher: page ignores script clicks -> DOM click, then ONE real click ----
  await load(page(SCREENSHOT_ROWS, 'trustedOnly'));
  reports = [];
  ok((await watch([{ code: 'HU404', slot: 'E4' }])).installed, 'watcher installs in isolated world');
  await wait(150);
  ok(reports.length === 0, 'watcher quiet while HU404 has 0 seats', reports);
  const openedAt = await run("window.openSeat('HU404')");
  await wait(900);
  clicks = await run('window.clicks');
  const hu = clicks.filter(c => c.code === 'HU404');
  ok(hu.length === 2 && !hu[0].trusted && hu[1].trusted, 'DOM click first, then one real-mouse click', { hu, reports });
  if (hu.length) ok(hu[0].at - openedAt < 20, `seat-open -> first click ${(hu[0].at - openedAt).toFixed(1)} ms`);
  ok(classify((await run(buildReaderScript(['HU404'])))[0]) === 'registered', 'HU404 registered');
  ok(reports.some(r => r.kind === 'added' && r.code === 'HU404'), 'watcher reports added', reports);
  ok(noDrops(clicks) && clicks.every(c => c.code === 'HU404'), 'nothing else clicked: no Drop, no other course', clicks);
  const huRow = await run(buildAddCourseScript('HU404', '', 'locate'));
  ok(!huRow.found && huRow.added, 'HU404 now has a LIVE Drop button: still never clicked, read as registered', huRow);
  await wait(400);
  ok(noDrops(await run('window.clicks')), 'live Drop left alone after registering');

  // ---- 4. click limit: page never reacts -> at most MAX clicks, then pause ----
  await load(page(SCREENSHOT_ROWS, 'ignore'));
  reports = [];
  await watch([{ code: 'MC310', slot: '' }]);
  await run("window.openSeat('MC310')");
  await wait(2500);
  clicks = await run('window.clicks');
  const mc = clicks.filter(c => c.code === 'MC310');
  ok(mc.length === MAX_CLICKS_PER_OPENING, `ignored clicks stop at ${MAX_CLICKS_PER_OPENING} (got ${mc.length})`, mc.length);
  ok(reports.some(r => r.kind === 'capped' && r.code === 'MC310'), 'watcher reports the pause', reports);
  ok(noDrops(clicks), 'no Drop clicked', clicks);

  // ---- 5. refused request: "Registering..." then back to Register -> no endless loop ----
  await load(page(SCREENSHOT_ROWS, 'reject'));
  reports = [];
  await watch([{ code: 'CD302', slot: '' }]);
  await run("window.openSeat('CD302')");
  await wait(3000);
  clicks = await run('window.clicks');
  const cd = clicks.filter(c => c.code === 'CD302');
  ok(cd.length <= MAX_CLICKS_PER_OPENING && cd.length >= 1, `refused request is not retried forever (${cd.length} clicks in 3 s)`, cd.length);
  ok(noDrops(clicks), 'no Drop clicked', clicks);

  // ---- 6. several listed courses open at once; unlisted course and Drop untouched ----
  await load(page(SCREENSHOT_ROWS, 'any'));
  reports = [];
  await watch([{ code: 'EC328', slot: '' }, { code: 'CD302', slot: 'E4' }]);
  await run("window.openSeat('EC328'); window.openSeat('CD302'); window.openSeat('MC310')");
  await wait(1200);
  clicks = await run('window.clicks');
  ok(clicks.filter(c => c.code === 'EC328').length === 1 && clicks.filter(c => c.code === 'CD302').length === 1,
    'both listed courses registered, each exactly once', clicks);
  ok(!clicks.some(c => c.code === 'MC310'), 'unlisted MC310 (also open) never clicked', clicks);
  ok(noDrops(clicks), 'no Drop clicked', clicks);

  // ---- 6b. PRIORITY: two courses in the SAME slot open together ----
  // trustedOnly page: the first (DOM) click is ignored, so priority 1 stays
  // "in flight" for a while; priority 2 must wait, never jump in.
  for (const [first, second] of [['HU404', 'CD302'], ['CD302', 'HU404']]) {
    await load(page(SCREENSHOT_ROWS, 'trustedOnly'));
    reports = [];
    await watch([{ code: first, slot: '' }, { code: second, slot: '' }]);
    await run(`window.openSeat('${first}'); window.openSeat('${second}')`);
    await wait(1200);
    clicks = await run('window.clicks');
    const ra = await run(buildReaderScript([first, second]));
    ok(classify(ra[0]) === 'registered' && !ra[1].added, `same slot: priority 1 (${first}) registered, not ${second}`, { ra, clicks });
    ok(!clicks.some(c => c.code === second), `same slot: ${second} (priority 2) never clicked`, clicks);
    ok(reports.some(r => r.kind === 'waiting' && r.code === second && r.behind === first), `log says ${second} waits for ${first}`, reports);
    ok(noDrops(clicks), 'no Drop clicked', clicks);
  }

  // ---- 6c. PRIORITY: different slots open together -> both, priority 1 first ----
  await load(page(SCREENSHOT_ROWS, 'any'));
  reports = [];
  await watch([{ code: 'EC328', slot: '' }, { code: 'HU404', slot: '' }]); // EC328 is E2, HU404 is E4
  await run("window.openSeat('HU404'); window.openSeat('EC328')");
  await wait(800);
  clicks = await run('window.clicks');
  ok(clicks.length === 2 && clicks[0].code === 'EC328' && clicks[1].code === 'HU404', 'different slots: both registered, priority 1 clicked first', clicks);

  // ---- 7. race: Drop slides under the real mouse click -> blocked ----
  await load(page(SCREENSHOT_ROWS, 'trustedOnly'));
  reports = [];
  onTrusted = async r => {
    await run(`(() => { const tr = [...document.querySelectorAll('tr')].find(t => t.children[1] && t.children[1].textContent === 'HU404');
      const reg = tr.querySelector('.reg'), drop = tr.querySelector('.drop');
      drop.disabled = false; // worst case: a LIVE Drop (a course you hold)
      reg.parentElement.appendChild(drop); reg.remove(); })()`); // Drop now sits where Register was
    trustedClick(wc, r.x, r.y);
  };
  await watch([{ code: 'HU404', slot: '' }]);
  await run("window.openSeat('HU404')");
  await wait(800);
  clicks = await run('window.clicks');
  ok(noDrops(clicks), 'real click landing on Drop is cancelled (Drop never fires)', clicks);
  ok(reports.some(r => r.kind === 'blocked'), 'watcher reports the blocked click', reports);
  onTrusted = r => trustedClick(wc, r.x, r.y);

  // ---- 8. minimised/hidden window: page timers keep running, DOM click still instant ----
  await load(page(SCREENSHOT_ROWS, 'any').replace('</script>',
    "window.ticks=0;setInterval(()=>{window.ticks++;if(window.ticks===5)window.openedAt=window.openSeat('HU404');},100);</script>"));
  await run(KEEP_VISIBLE_SCRIPT);
  win.hide();
  reports = [];
  await watch([{ code: 'HU404', slot: '' }]);
  await wait(1200);
  const h = await run('({ ticks: window.ticks, clicks: window.clicks, openedAt: window.openedAt, vis: document.visibilityState })');
  ok(!win.isVisible() && h.ticks >= 9, `hidden window: page timers keep running (${h.ticks} ticks/1.2 s)`, h);
  ok(h.vis === 'visible', 'hidden window: page still believes it is visible', h);
  ok(h.clicks.length === 1 && h.clicks[0].code === 'HU404' && h.clicks[0].btn === 'Register', 'hidden window: exactly one Register click', h.clicks);
  if (h.clicks.length) ok(h.clicks[0].at - h.openedAt < 20, `hidden window: seat-open -> click ${(h.clicks[0].at - h.openedAt).toFixed(1)} ms`);
  win.show();

  console.log(`\n${passed}/${passed + failed} DOM checks passed.`);
  app.exit(failed ? 1 : 0);
});
