// monitor.js
//
// Seat monitor + auto-Register for the DTU course registration page
// (/student/courseRegistration): a table of
//   Name | Code | Credits | Slot | Seats | [Register] [Drop]
//
// What it does:
//   * Reads each configured course's table row (name, slot, seats, Register).
//   * The in-page watcher clicks that row's own "Register" button the moment it
//     is enabled with seats > 0, and only for courses the user entered.
//
// What it deliberately does NOT do:
//   * It never clicks Drop. The only button it will ever click is one whose
//     text is exactly "Register", in the row of a listed course. Real-mouse
//     clicks are guarded: if anything other than that exact button would
//     receive the click, the click is cancelled before the page sees it.
//   * It never clicks another course's button.
//
// Tests: selftest/monitor.run.js (pure logic) and selftest/dom.electron.js
// (real scripts in Electron against mock portal pages).

const PORTAL_URL = 'https://exam-setu.dtu.ac.in/student/courseRegistration';

// At most this many clicks per seat opening; then wait until the row changes.
const MAX_CLICKS_PER_OPENING = 4;

// Pure: read a row from its cell texts, e.g.
// ['Public Finance And Policy', 'HU404', '4', 'E4', '0', 'Register', 'Drop'].
// Embedded into the page via .toString(), so keep it self-contained ES5.
function parseCells(code, cells) {
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  var ME = String(code).toUpperCase();
  var t = [];
  for (var i = 0; i < cells.length; i++) t.push(norm(cells[i]));
  var ci = -1;
  for (var k = 0; k < t.length; k++) if (t[k].toUpperCase() === ME) { ci = k; break; }
  var name = '', slot = '', seats = null, nums = [];
  for (var a = 0; a < (ci < 0 ? 0 : ci); a++) {
    if (t[a] && !/^\d+$/.test(t[a]) && t[a].length > name.length) name = t[a];
  }
  for (var j = ci + 1; ci >= 0 && j < t.length; j++) {
    if (!slot && /^E\d+$/i.test(t[j])) { slot = t[j].toUpperCase(); continue; }
    if (/^\d+$/.test(t[j])) {
      nums.push(parseInt(t[j], 10));
      if (slot && seats === null) seats = parseInt(t[j], 10);
    }
  }
  // No slot column: Credits | Seats -> seats is the last number.
  if (seats === null && nums.length >= 2) seats = nums[nums.length - 1];
  return { code: ME, name: name, slot: slot, seats: seats };
}

// Turn a reading into a status: 'registered' | 'available' | 'full' | 'unknown'.
function classify(reading) {
  if (!reading) return 'unknown';
  if (reading.added) return 'registered';
  if (Number.isFinite(reading.seats) && reading.seats > 0 && !reading.registerOff) return 'available';
  if (reading.full) return 'full';
  return 'unknown';
}

// Creates an independent, de-duplicating monitor for the given course codes.
function createMonitor(courseCodes) {
  const codes = (courseCodes || []).map(c => String(c).trim().toUpperCase()).filter(Boolean);
  const state = new Map(); // code -> { status, name, seats, notified }
  codes.forEach(c => state.set(c, { status: 'init', name: '', seats: 0, slot: '', notified: false }));

  return {
    codes,
    getState() {
      const out = {};
      for (const c of codes) out[c] = { ...state.get(c) };
      return out;
    },
    resetCode(code) {
      const c = String(code).trim().toUpperCase();
      if (state.has(c)) {
        const current = state.get(c);
        state.set(c, { ...current, notified: false });
      }
    },
    // readings: array of { code, name, seats, full, added } read from the page.
    // Returns alerts { code, name, seats } when a course becomes available,
    // de-duplicated, with independent per-course state.
    update(readings) {
      const byCode = new Map();
      (readings || []).forEach(r => {
        if (r && r.code) byCode.set(String(r.code).trim().toUpperCase(), r);
      });

      const alerts = [];
      for (const code of codes) {
        const prev = state.get(code);
        const reading = byCode.get(code);

        // Not seen this cycle (page reloading, slot collapsed, scrolled away):
        // keep the last known state, never fire, never reset de-dup.
        if (!reading || reading.found === false) continue;

        const status = classify(reading);
        const name = reading.name || prev.name;
        const seats = Number.isFinite(reading.seats) ? reading.seats : prev.seats;
        const slot = reading.slot || prev.slot;
        const button = reading.button || '';

        if (status === 'available') {
          if (!prev.notified) alerts.push({ code, name, seats, slot });
          state.set(code, { status, name, seats, slot, button, notified: true });
        } else {
          // full / unknown / registered: reset de-dup so a re-opening alerts again.
          state.set(code, { status, name, seats, slot, button, notified: false });
        }
      }
      return alerts;
    },
  };
}

// In-page: find the table row for `code` and describe it. Read-only.
// Returns null, or { row, cells, reg, regCount, labels, rowText }.
// `parse` is parseCells and `isOff` is isOffInPage (passed in so the page uses the same code).
function findCourseRowInPage(code, parse, isOff) {
  function norm(s) { return String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
  function label(b) { return norm(b.textContent || b.value || b.getAttribute('aria-label')); }
  var SEL = 'button,a,[role=button],input[type=button]';
  var ME = String(code).toUpperCase();
  function regButtonsIn(el) {
    var out = [], bs = el.querySelectorAll(SEL);
    for (var i = 0; i < bs.length; i++) if (/^Register$/i.test(label(bs[i]))) out.push(bs[i]);
    return out;
  }
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    if (norm(tn.nodeValue).toUpperCase() !== ME) continue;
    var holder = tn.parentElement;
    if (!holder) continue;
    var row = holder.closest('tr,[role=row]');
    if (!row) {
      // Not a table: climb to the largest ancestor holding at most one Register button.
      row = holder;
      for (var d = 0; d < 8 && row.parentElement && row.parentElement !== document.body; d++) {
        if (regButtonsIn(row.parentElement).length > 1) break;
        row = row.parentElement;
      }
    }
    var cellEls = row.querySelectorAll('td,th,[role=cell],[role=gridcell]');
    if (!cellEls.length) cellEls = row.children;
    var cells = [];
    for (var c = 0; c < cellEls.length; c++) cells.push(norm(cellEls[c].textContent));
    var regs = regButtonsIn(row);
    var labels = [], bs = row.querySelectorAll(SEL);
    for (var b = 0; b < bs.length; b++) { var l = label(bs[b]); if (l) labels.push(l); }
    // Registered, as the portal shows it: Register greyed out and the row's
    // OTHER button switched on (it is only clickable for a course you hold).
    // This only reads that button's state; it is never clicked.
    var reg1 = regs.length === 1 ? regs[0] : null, otherOn = false;
    for (var q = 0; q < bs.length; q++) {
      var ql = label(bs[q]);
      if (ql && !/^Register/i.test(ql) && !/^(Processing|Please wait|Loading)|\.\.\.|…/i.test(ql) && !isOff(bs[q])) otherOn = true;
    }
    // Needs a real, greyed-out "Register" button: a button that says
    // "Registering..." mid-request must never count as registered.
    var added = !!reg1 && isOff(reg1) && otherOn;
    // Or a badge/cell saying so. Cells and labels are checked separately
    // because the row's full text is glued together with no spaces.
    var parts = cells.concat(labels);
    for (var p = 0; p < parts.length && !added; p++) added = /\b(Registered|Enrolled)\b|✓|✔/i.test(parts[p]);
    return { row: row, cells: cells, info: parse(code, cells), reg: regs.length === 1 ? regs[0] : null,
      regCount: regs.length, labels: labels, added: added, rowText: norm(row.textContent) };
  }
  return null;
}

// In-page: is this button switched off (disabled, aria-disabled, or greyed)?
function isOffInPage(btn) {
  if (!btn) return true;
  if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return true;
  if (/(^|\s)disabled(\s|$)/i.test(String(btn.className || ''))) return true;
  var cs = getComputedStyle(btn);
  if (cs.pointerEvents === 'none') return true;
  if (parseFloat(cs.opacity) < 0.75) return true;
  return false;
}

// In-page, read-only: read each course's row. Clicks nothing.
function readRowsInPage(codes, find, parse, isOff) {
  return codes.map(function (code) {
    var f = find(code, parse, isOff);
    if (!f) return { code: code, found: false };
    var r = f.info;
    r.found = true;
    var others = f.labels.filter(function (l) { return !/^Drop$/i.test(l); });
    r.added = f.added;
    r.pending = !r.added && others.some(function (l) { return /^(Registering|Processing|Please wait|Loading)/i.test(l); });
    r.registerOff = !f.reg || isOff(f.reg);
    var seats = Number.isFinite(r.seats) ? r.seats : null;
    r.seats = seats === null ? 0 : seats;
    r.full = !r.added && seats === 0;
    if (r.added) r.button = others[0] || 'Registered';
    else if (f.reg) r.button = r.registerOff ? 'Register off' : 'Register';
    else r.button = others[0] || (f.labels.length ? f.labels.join('/') : 'no button');
    if (f.regCount > 1) { r.button = 'several Register buttons'; r.registerOff = true; }
    r.button = String(r.button).slice(0, 30);
    return r;
  });
}

function buildReaderScript(courseCodes) {
  const codes = (courseCodes || []).map(c => String(c).trim().toUpperCase());
  return '(' + readRowsInPage.toString() + ')(' + JSON.stringify(codes) + ',' +
    findCourseRowInPage.toString() + ',' + parseCells.toString() + ',' + isOffInPage.toString() + ')';
}

// In-page: find the "Register" button of the row for `code`.
//
// mode "locate":   scroll it into view and return its centre in CSS px, so
//                  main.js can send a real (trusted) mouse click there.
// mode "domclick": call button.click() directly.
// Only a button whose text is exactly "Register" is ever returned or clicked.
function locateRegisterInPage(code, slot, mode, find, parse, isOff) {
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  var f = find(code, parse, isOff);
  if (!f) return { found: false, reason: 'row not on page' };
  var rowText = f.rowText.slice(0, 160);
  if (f.added) return { found: false, added: true, rowText: rowText };
  if (f.regCount !== 1) return { found: false, reason: f.regCount + ' Register buttons in row', rowText: rowText };
  if (slot && f.info.slot && f.info.slot !== slot) return { found: false, reason: 'slot ' + f.info.slot + ' != ' + slot, rowText: rowText };
  if (Number.isFinite(f.info.seats) && f.info.seats <= 0) return { found: false, reason: 'no seats', rowText: rowText };
  var btn = f.reg;
  // Last line of defence: never anything but the exact word "Register".
  if (!/^Register$/i.test(norm(btn.textContent || btn.value))) return { found: false, reason: 'not a Register button' };
  var disabled = isOff(btn);
  if (mode === 'peek') return { found: true, disabled: disabled, rowText: rowText };
  if (mode === 'domclick') {
    if (!disabled) btn.click();
    return { found: true, method: 'dom', disabled: disabled, rowText: rowText };
  }
  window.__dtuLastLocated = btn; // lets the watcher guard the real-mouse click
  var r = btn.getBoundingClientRect();
  var vw = window.innerWidth, vh = window.innerHeight;
  if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw || !r.width) {
    btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = btn.getBoundingClientRect();
  }
  var x = r.left + r.width / 2, y = r.top + r.height / 2;
  var hit = document.elementFromPoint(x, y);
  var covered = !(hit && (hit === btn || btn.contains(hit)));
  return { found: true, method: 'trusted', x: x, y: y, w: r.width, h: r.height, disabled: disabled,
    covered: covered, rowText: rowText };
}

function locateArgs() {
  return findCourseRowInPage.toString() + ',' + parseCells.toString() + ',' + isOffInPage.toString();
}

function buildAddCourseScript(code, slot, mode) {
  return '(' + locateRegisterInPage.toString() + ')(' +
    JSON.stringify(String(code).trim().toUpperCase()) + ',' +
    JSON.stringify(String(slot || '').trim().toUpperCase()) + ',' +
    JSON.stringify(mode === 'domclick' ? 'domclick' : 'locate') + ',' + locateArgs() + ')';
}

// Marker prefix for messages from the in-page watcher to main.js.
const FAST_ADD_PREFIX = '__DTU_FAST_ADD__';

// In-page watcher: the PRIMARY, fastest path. Runs in an isolated world.
//
// A MutationObserver fires the moment the portal re-renders. If a listed
// course's Register button is enabled with seats > 0, the watcher clicks it
// right there (element.click()). If it is still clickable `quick` ms later,
// it asks main.js for a real mouse click, then alternates every `gap` ms, at
// most `maxClicks` times per opening.
//
// Reports go to main.js via console.debug in the isolated world:
// {kind:'dom'|'trusted'|'added'|'blocked'|'capped', code, n, ...}.
function fastWatcherInPage(list, sid, gap, prefix, locate, quick, maxClicks, find, parse, isOff) {
  if (window.__dtuFast && window.__dtuFast.obs) window.__dtuFast.obs.disconnect();
  var st = { sid: sid, last: {}, n: {}, capped: {}, timers: {}, pending: false, obs: null, armed: null };
  window.__dtuFast = st;
  function report(o) { o.sid = sid; console.debug(prefix + JSON.stringify(o)); }
  function loc(code, slot, mode) { return locate(code, slot, mode, find, parse, isOff); }

  // Real-mouse click guard. While a real click is pending, any real mouse
  // event that is NOT on the exact Register button we aimed at (for example a
  // Drop button that moved under the pointer) is cancelled before the portal
  // sees it.
  function isRegisterEl(b) {
    return /^Register$/i.test(String(b.textContent || b.value || '').replace(/\s+/g, ' ').trim());
  }
  function guard(ev) {
    var a = st.armed;
    if (window.__dtuFast !== st || !a || !ev.isTrusted) return;
    if (Date.now() > a.until) { st.armed = null; return; }
    var onTarget = a.btn && a.btn.isConnected && a.btn.contains(ev.target) && isRegisterEl(a.btn);
    if (!onTarget) {
      ev.stopImmediatePropagation(); ev.preventDefault();
      if (ev.type === 'click') { st.armed = null; report({ kind: 'blocked', code: a.code }); }
    } else if (ev.type === 'click') {
      st.armed = null;
    }
  }
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (t) {
    window.addEventListener(t, guard, true);
  });
  function later(code, ms) {
    if (st.timers[code]) return;
    st.timers[code] = setTimeout(function () { st.timers[code] = 0; scan(); }, ms);
  }
  function scan() {
    st.pending = false;
    if (window.__dtuFast !== st) return;
    var now = Date.now();
    for (var i = 0; i < list.length; i++) {
      var e = list[i], code = e.code, n = st.n[code] || 0;
      var r;
      if (n >= maxClicks) {
        // Out of clicks for this opening. Start again only once it is over:
        // registered, seats back to 0, or 30 s passed. A button that flips to
        // "Registering..." and back does NOT reset it (no endless clicking).
        try { r = loc(code, e.slot, 'peek'); } catch (_) { continue; }
        var over = r && (r.added || r.reason === 'no seats');
        if (over || now - (st.last[code] || 0) > 30000) {
          st.n[code] = 0; st.capped[code] = false;
          if (r && r.added) report({ kind: 'added', code: code });
          if (!over) later(code, 5);
        } else if (!st.capped[code]) {
          st.capped[code] = true; report({ kind: 'capped', code: code, n: n });
          later(code, 30005 - (now - (st.last[code] || 0)));
        }
        continue;
      }
      var wait = (n === 1 ? quick : gap) - (now - (st.last[code] || 0));
      if (n > 0 && wait > 0) { later(code, wait + 5); continue; }
      var useDom = n % 2 === 0;
      try { r = loc(code, e.slot, useDom ? 'domclick' : 'locate'); } catch (_) { continue; }
      if (r && r.found) {
        if (r.disabled) continue; // an attribute mutation will wake us when it enables
        st.last[code] = now; st.n[code] = n + 1;
        if (useDom || r.covered) {
          if (!useDom) loc(code, e.slot, 'domclick'); // covered: real mouse would miss
          report({ kind: 'dom', code: code, n: n + 1 });
        } else {
          st.armed = { btn: window.__dtuLastLocated, code: code, until: Date.now() + 250 };
          report({ kind: 'trusted', code: code, n: n + 1, x: r.x, y: r.y });
        }
        later(code, (n === 0 ? quick : gap) + 2); // re-check even if the click is silently ignored
      } else if (n > 0 && r && (r.added || r.reason === 'no seats')) {
        st.n[code] = 0;
        if (r.added) report({ kind: 'added', code: code });
      }
    }
  }
  function kick() { if (st.pending) return; st.pending = true; Promise.resolve().then(scan); }
  st.obs = new MutationObserver(kick);
  st.obs.observe(document.documentElement, {
    subtree: true, childList: true, characterData: true,
    attributes: true, attributeFilter: ['disabled', 'class', 'aria-disabled', 'style', 'hidden'],
  });
  scan();
  return { installed: true };
}

function buildFastWatcherScript(entries, sessionId, gapMs, quickMs) {
  const list = (entries || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter(e => e.code);
  return '(' + fastWatcherInPage.toString() + ')(' +
    JSON.stringify(list) + ',' + JSON.stringify(Number(sessionId) || 0) + ',' +
    JSON.stringify(Number(gapMs) || 300) + ',' + JSON.stringify(FAST_ADD_PREFIX) + ',' +
    locateRegisterInPage.toString() + ',' + JSON.stringify(Number(quickMs) || 60) + ',' +
    JSON.stringify(MAX_CLICKS_PER_OPENING) + ',' + locateArgs() + ')';
}

// Make the portal page believe it is always visible, so a covered portal
// window does not pause its own seat refresh. Runs in the page's main world.
const KEEP_VISIBLE_SCRIPT =
  '(function(){if(window.__dtuVis)return;window.__dtuVis=1;' +
  'try{Object.defineProperty(Document.prototype,"hidden",{configurable:true,get:function(){return false;}});' +
  'Object.defineProperty(Document.prototype,"visibilityState",{configurable:true,get:function(){return "visible";}});}catch(e){}' +
  'var stop=function(e){e.stopImmediatePropagation();};' +
  'document.addEventListener("visibilitychange",stop,true);window.addEventListener("visibilitychange",stop,true);' +
  'return true;})()';

const STOP_FAST_WATCHER_SCRIPT =
  'if(window.__dtuFast){if(window.__dtuFast.obs)window.__dtuFast.obs.disconnect();window.__dtuFast=null;}';

module.exports = {
  PORTAL_URL, FAST_ADD_PREFIX, STOP_FAST_WATCHER_SCRIPT, KEEP_VISIBLE_SCRIPT, MAX_CLICKS_PER_OPENING,
  parseCells, classify, createMonitor, buildReaderScript, buildAddCourseScript, buildFastWatcherScript,
};
