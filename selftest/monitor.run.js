// selftest/monitor.run.js
//
// Tests for the read-only seat monitor (monitor.js). No portal is contacted;
// these exercise the pure parsing + transition + de-duplication logic, using
// the exact rows seen on the real /student/courseRegistration page.
//
// Run:  npm run selftest:monitor

const { parseCells, classify, blockedByLowerPriority, createMonitor, buildReaderScript, buildAddCourseScript, PORTAL_URL } = require('../monitor.js');

let passed = 0, failed = 0;
function check(name, fn) {
  try {
    const problem = fn();
    if (problem) { console.log(`  FAIL  ${name}\n        -> ${problem}`); failed++; }
    else { console.log(`  PASS  ${name}`); passed++; }
  } catch (e) {
    console.log(`  FAIL  ${name}\n        -> threw: ${e.message}`); failed++;
  }
}
const expect = (cond, msg) => { if (!cond) return msg; };

console.log('\nSeat monitor self-test (no portal contacted)\n');

// ---- parseCells: real rows from /student/courseRegistration ----
// Name | Code | Credits | Slot | Seats | Register | Drop
check('parseCells: full course (0 seats)', () => {
  const r = parseCells('HU404', ['Public Finance And Policy', 'HU404', '4', 'E4', '0', 'Register', 'Drop']);
  return expect(r.seats === 0 && r.slot === 'E4' && r.name === 'Public Finance And Policy', `got ${JSON.stringify(r)}`);
});
check('parseCells: open course (72 seats), seats not confused with credits', () => {
  const r = parseCells('EV302', ['Power Electronics Converters and Drives for Electric Vehicles', 'EV302', '4', 'E4', '72', 'Register', 'Drop']);
  return expect(r.seats === 72 && r.slot === 'E4' && /Power Electronics/.test(r.name), `got ${JSON.stringify(r)}`);
});
check('parseCells: lowercase suffix code (CH310n) matches CH310N', () => {
  const r = parseCells('CH310N', ['Polymer Processing Technique', 'CH310n', '4', 'E4', '53', 'Register', 'Drop']);
  return expect(r.seats === 53 && r.name === 'Polymer Processing Technique', `got ${JSON.stringify(r)}`);
});
check('parseCells: CH310 does not match CH310n', () => {
  const r = parseCells('CH310', ['Polymer Processing Technique', 'CH310n', '4', 'E4', '53']);
  return expect(r.seats === null, `got ${JSON.stringify(r)}`);
});
check('parseCells: no slot column -> seats is the last number', () => {
  const r = parseCells('CS326', ['Some Course', 'CS326', '4', '12', 'Register', 'Drop']);
  return expect(r.seats === 12 && r.slot === '', `got ${JSON.stringify(r)}`);
});check('Monitor carries the slot through to state and alerts', () => {
  const m = createMonitor(['HU426']);
  m.update([{ code: 'HU426', name: 'Language And Social Media', seats: 0, full: true, slot: 'E4' }]);
  const a = m.update([{ code: 'HU426', name: 'Language And Social Media', seats: 2, full: false, slot: 'E4' }]);
  return expect(m.getState().HU426.slot === 'E4' && a[0] && a[0].slot === 'E4',
    `state ${JSON.stringify(m.getState().HU426)} alert ${JSON.stringify(a)}`);
});

// ---- classify ----
check('classify: seats>0 is available', () => expect(classify({ seats: 5, full: false }) === 'available', 'not available'));
check('classify: 1 seat is available immediately', () => expect(classify({ seats: 1, full: false }) === 'available', '1 seat was not available'));
check('classify: Full with 0 seats is full', () => expect(classify({ seats: 0, full: true }) === 'full', 'not full'));
check('classify: nothing known is unknown', () => expect(classify({ seats: 0, full: false }) === 'unknown', 'not unknown'));
check('classify: already-added course is registered', () => expect(classify({ seats: 51, full: false, added: true }) === 'registered', 'added course was not registered'));

// ---- transition + de-duplication ----
check('Full -> Available fires exactly once', () => {
  const m = createMonitor(['HU426']);
  m.update([{ code: 'HU426', name: 'Language And Social Media', seats: 0, full: true }]);
  const a1 = m.update([{ code: 'HU426', name: 'Language And Social Media', seats: 2, full: false }]);
  const a2 = m.update([{ code: 'HU426', name: 'Language And Social Media', seats: 2, full: false }]);
  return expect(a1.length === 1 && a1[0].code === 'HU426' && a1[0].seats === 2 && a2.length === 0,
    `fire1=${JSON.stringify(a1)} fire2=${JSON.stringify(a2)}`);
});
check('Alert carries code, name and seat count', () => {
  const m = createMonitor(['HU308']);
  m.update([{ code: 'HU308', name: 'Mathematical Economics', seats: 0, full: true }]);
  const a = m.update([{ code: 'HU308', name: 'Mathematical Economics', seats: 7, full: false }]);
  return expect(a[0].name === 'Mathematical Economics' && a[0].seats === 7 && a[0].code === 'HU308',
    `got ${JSON.stringify(a)}`);
});
check('Available -> Full -> Available fires again (re-opens)', () => {
  const m = createMonitor(['HU404']);
  m.update([{ code: 'HU404', seats: 0, full: true }]);
  const a1 = m.update([{ code: 'HU404', seats: 1, full: false }]);
  m.update([{ code: 'HU404', seats: 0, full: true }]);
  const a2 = m.update([{ code: 'HU404', seats: 3, full: false }]);
  return expect(a1.length === 1 && a2.length === 1, `fire1=${a1.length} fire2=${a2.length}`);
});
check('Drop -> Available fires again for the configured course', () => {
  const m = createMonitor(['CH314m']);
  m.update([{ code: 'CH314m', seats: 60, full: false }]);
  m.update([{ code: 'CH314m', seats: 0, full: false, added: true }]);
  const a = m.update([{ code: 'CH314m', seats: 61, full: false }]);
  return expect(a.length === 1 && a[0].seats === 61, `got ${JSON.stringify(a)} state ${JSON.stringify(m.getState())}`);
});
check('Available on first sighting is added immediately', () => {
  const m = createMonitor(['CH314m']);
  const a = m.update([{ code: 'CH314m', seats: 63, full: false }]);
  return expect(a.length === 1 && a[0].seats === 63 && m.getState().CH314M.status === 'available', `got ${JSON.stringify(a)} state ${JSON.stringify(m.getState())}`);
});
check('Three courses are tracked independently', () => {
  const m = createMonitor(['HU426', 'HU308', 'HU404']);
  m.update([
    { code: 'HU426', seats: 0, full: true },
    { code: 'HU308', seats: 0, full: true },
    { code: 'HU404', seats: 0, full: true },
  ]);
  const a = m.update([
    { code: 'HU426', seats: 0, full: true },
    { code: 'HU308', seats: 4, full: false },
    { code: 'HU404', seats: 0, full: true },
  ]);
  return expect(a.length === 1 && a[0].code === 'HU308', `got ${JSON.stringify(a)}`);
});
check('A missing reading (page reload) keeps state and never fires', () => {
  const m = createMonitor(['HU426']);
  m.update([{ code: 'HU426', seats: 0, full: true }]);
  const a1 = m.update([]); // page reloading: course not seen
  const a2 = m.update([{ code: 'HU426', found: false }]); // seen but not found
  const st = m.getState().HU426;
  return expect(a1.length === 0 && a2.length === 0 && st.status === 'full', `state ${JSON.stringify(st)}`);
});
check('Seats open but Register switched off is NOT available (no click)', () => {
  const m = createMonitor(['CE328']);
  const a = m.update([{ code: 'CE328', seats: 48, full: false, registerOff: true, button: 'Register off' }]);
  return expect(a.length === 0 && m.getState().CE328.status === 'unknown', `got ${JSON.stringify(a)} state ${JSON.stringify(m.getState())}`);
});
check('Register/locate script never mentions Drop', () => {
  const s = buildAddCourseScript('HU404', 'E4', 'locate') + buildAddCourseScript('HU404', 'E4', 'domclick');
  return expect(!/drop/i.test(s), 'add script contains "Drop"');
});

// ---- priority: higher course open while you hold a lower one in that slot ----
check('Priority: warns when #1 opens but you hold #2 in the same slot', () => {
  const b = blockedByLowerPriority([
    { code: 'HU404', found: true, seats: 3, registerOff: true, slot: 'E4' },
    { code: 'EV302', found: true, seats: 71, registerOff: true, added: true, slot: 'E4' },
  ]);
  return expect(b.length === 1 && b[0].code === 'HU404' && b[0].held === 'EV302', `got ${JSON.stringify(b)}`);
});
check('Priority: no warning when the course you hold is HIGHER priority', () => {
  const b = blockedByLowerPriority([
    { code: 'EV302', found: true, seats: 71, registerOff: true, added: true, slot: 'E4' },
    { code: 'HU404', found: true, seats: 3, registerOff: true, slot: 'E4' },
  ]);
  return expect(b.length === 0, `got ${JSON.stringify(b)}`);
});
check('Priority: no warning across different slots or with 0 seats', () => {
  const b = blockedByLowerPriority([
    { code: 'HU404', found: true, seats: 3, registerOff: true, slot: 'E4' },
    { code: 'IT308', found: true, seats: 0, registerOff: true, added: true, slot: 'E1' },
    { code: 'HU426', found: true, seats: 0, registerOff: true, slot: 'E1' },
  ]);
  return expect(b.length === 0, `got ${JSON.stringify(b)}`);
});

// ---- the in-page reader must be read-only ----
check('Reader script is READ-ONLY (no click/drop/submit)', () => {
  const s = buildReaderScript(['HU426', 'HU308', 'HU404']);
  const badWrites = /\.click\(|\/register\b.*submit|addEventListener|\.submit\(|fetch\(|XMLHttpRequest|location\s*=/i;
  return expect(
    typeof s === 'string' && s.includes('querySelectorAll') && s.includes('HU426') && !badWrites.test(s) && PORTAL_URL.includes('/student/courseRegistration'),
    'reader is not a safe read-only string'
  );
});

check('Add script never targets Submit', () => {
  const s = buildAddCourseScript('HU308', '', 'locate');
  return expect(
    !s.includes('input[type=submit]') &&
    !/querySelector(All)?\([^)]*[Ss]ubmit/i.test(s),
    'add script may contain an unsafe Submit target'
  );
});
// The Add script's real DOM behaviour is tested in Electron against a mock
// portal page: run `npm run selftest:dom`.

console.log(`\n${passed}/${passed + failed} checks passed.`);
console.log(failed === 0 ? 'Monitor logic verified.\n' : 'Some monitor checks FAILED.\n');
process.exit(failed === 0 ? 0 : 1);
