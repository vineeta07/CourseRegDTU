// selftest/monitor.run.js
//
// Tests for the read-only seat monitor (monitor.js). No portal is contacted;
// these exercise the pure parsing + transition + de-duplication logic, using
// the exact row text seen on the real /register/ page.
//
// Run:  npm run selftest:monitor

const { parseRowText, classify, createMonitor, buildReaderScript, buildHighlightScript, PORTAL_URL } = require('../monitor.js');

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

// ---- parseRowText: real row strings from the live page ----
check('parseRowText: full course ("Full" + Notifying you)', () => {
  const r = parseRowText('HU426', 'HU426Language And Social MediaFull Notifying you');
  return expect(r.seats === 0 && r.full === true && r.added === false && /Language And Social Media/.test(r.name),
    `got ${JSON.stringify(r)}`);
});
check('parseRowText: available course ("63 left" + Add)', () => {
  const r = parseRowText('CH314m', 'CH314mCoating and Adhesive4 credits63 left Add');
  return expect(r.seats === 63 && r.full === false && /Coating and Adhesive/.test(r.name),
    `got ${JSON.stringify(r)}`);
});
check('parseRowText: added course ("Added"/"Drop") is not full, not available', () => {
  const r = parseRowText('IT322', 'IT322Computer VisionFull Added Drop');
  return expect(r.added === true && r.full === false && r.seats === 0, `got ${JSON.stringify(r)}`);
});
check('parseRowText: strips credits and status from the name', () => {
  const r = parseRowText('EP210', 'EP210Condensed Matter Physics4 credits72 left Add');
  return expect(r.name === 'Condensed Matter Physics', `name was "${r.name}"`);
});

// ---- classify ----
check('classify: seats>0 is available', () => expect(classify({ seats: 5, full: false }) === 'available', 'not available'));
check('classify: Full with 0 seats is full', () => expect(classify({ seats: 0, full: true }) === 'full', 'not full'));
check('classify: nothing known is unknown', () => expect(classify({ seats: 0, full: false }) === 'unknown', 'not unknown'));

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
check('Available on first sighting is a baseline, not an alert', () => {
  const m = createMonitor(['CH314m']);
  const a = m.update([{ code: 'CH314m', seats: 63, full: false }]);
  return expect(a.length === 0, `wrongly fired ${JSON.stringify(a)}`);
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
check('Full row with "Notifying you" is treated as full, not available', () => {
  const m = createMonitor(['HU426']);
  const reading = { code: 'HU426', ...parseRowText('HU426', 'HU426Language And Social MediaFull Notifying you') };
  const a = m.update([reading]);
  return expect(a.length === 0 && m.getState().HU426.status === 'full', `got ${JSON.stringify(a)} state ${JSON.stringify(m.getState())}`);
});

// ---- the in-page reader must be read-only ----
check('Reader script targets the portal and is READ-ONLY (no click/add/submit)', () => {
  const s = buildReaderScript(['HU426', 'HU308', 'HU404']);
  const badWrites = /\.click\(|courseRegister|\/register\b.*submit|addEventListener|\.submit\(|fetch\(|XMLHttpRequest|location\s*=/i;
  return expect(
    typeof s === 'string' && s.includes('querySelectorAll') && s.includes('HU426') && !badWrites.test(s) && PORTAL_URL.includes('/register/'),
    'reader is not a safe read-only string'
  );
});

// ---- the focus/highlight script must help you click, but NEVER click itself ----
check('Highlight script scrolls to the course and highlights, but does NOT click/submit', () => {
  const s = buildHighlightScript('HU426', 3, 'Language And Social Media');
  const clicks = /\.click\(|\.submit\(|courseRegister|form\.submit|\.requestSubmit\(|dispatchEvent/i;
  return expect(
    typeof s === 'string' &&
    s.includes('HU426') &&
    s.includes('scrollIntoView') &&
    s.includes('seatwatch-banner') &&
    !clicks.test(s),
    'highlight script is not a safe, no-click helper'
  );
});
check('Highlight script finds the "Add" button without matching "Added"', () => {
  const s = buildHighlightScript('HU308', 1, '');
  // It must look for an exact Add label, not merely the substring "Add".
  return expect(/\^\\\+\?\\s\*Add\$/.test(s) || s.includes('Add$'), 'does not anchor the Add match');
});

console.log(`\n${passed}/${passed + failed} checks passed.`);
console.log(failed === 0 ? 'Monitor logic verified.\n' : 'Some monitor checks FAILED.\n');
process.exit(failed === 0 ? 0 : 1);
