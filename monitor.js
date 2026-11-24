// monitor.js
//
// Seat monitor + auto-Add for the DTU registration portal (/register/).
//
// What it does:
//   * Reads each configured course's row (seats, name, button state).
//   * The in-page watcher clicks that row's own "Add" button the moment it
//     appears, and only for courses the user entered (exact code + slot).
//
// What it deliberately does NOT do:
//   * It never clicks Register / Submit: final submission stays with the user.
//   * It never clicks another course's button or a Drop button.
//
// Tests: selftest/monitor.run.js (pure logic) and selftest/dom.electron.js
// (real scripts in Electron against mock portal pages).

const PORTAL_URL = 'https://exam-setu.dtu.ac.in/register/';

// Pure parser: turn a course row's visible text into a reading.
// Kept as a standalone function so it can be BOTH unit-tested here AND
// embedded (via .toString()) into the in-page reader, so there is one
// single source of truth for how a row is read.
function parseRowText(code, text) {
  // Note: on the real page, adjacent cells are concatenated with NO spaces
  // (e.g. "HU426Language And Social MediaFull Notifying you"), so status words
  // are matched as substrings, not whole words. The status tokens only ever
  // appear glued to the end of the row, so this is safe for course names.
  var t = String(text || '').replace(/\s+/g, ' ').trim();
  var m = t.match(/(\d+)\s*left/i);
  var seatCount = m ? parseInt(m[1], 10) : 0;
  var added = /Added/i.test(t) || /Drop/i.test(t);
  var addControl = /\+\s*Add\b/i.test(t) || /^\s*Add\b/i.test(t);
  var seats = seatCount ? seatCount : (addControl && !added ? 1 : 0);
  var full = !seatCount && !addControl && !added && (/Notif/i.test(t) || /Full/i.test(t) || /Waiting/i.test(t));
  // Slot like E1/E2/E4 may be glued to the name ("ApplicationsE3"), so no leading \b.
  var slotM = t.match(/E(\d)\b/i);
  var slot = slotM ? ('E' + slotM[1]) : '';
  // Strip the code, credits and "N left" first: on the portal they come BEFORE
  // the name ("EV3024 credits72leftPower Electronics ... Add").
  var codeEsc = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  var namePart = t
    .replace(new RegExp(codeEsc, 'i'), ' ')
    .replace(/\d+\s*left/ig, ' ')
    .replace(/\d+\s*credits?/ig, ' ')
    .replace(/\d+\s*cr\b/ig, ' ')
    .replace(/\s+/g, ' ').trim();
  var statusMarkers = [
    /Adding/i,
    /Dropping/i,
    /Waiting/i,
    /\+\s*Add\b/i,
    /\bAdd\b/i,
    /Waiting\s*for\s*(a\s*)?seat/i,
    /Notifying\s*you/i,
    /Notify\s*me/i,
    /\d+\s*left/i,
    /\bFull\b/i,
    /\bAdded\b/i,
    /\bDrop\b/i
  ];
  var earliest = namePart.length;
  statusMarkers.forEach(function(marker) {
    var match = namePart.match(marker);
    if (match && typeof match.index === 'number' && match.index < earliest) earliest = match.index;
  });
  namePart = namePart.substring(0, earliest);
  var name = namePart
    .replace(/E\d\b/ig, '')
    .replace(/[·|]/g, ' ')
    .replace(/Notifying you/ig, '')
    .replace(/Notify me/ig, '')
    .replace(/Full/ig, '')
    .replace(/Added/ig, '')
    .replace(/Drop/ig, '')
    .replace(/Add/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { code: code, name: name, seats: seats, full: full, added: added, slot: slot };
}

// Turn a reading into a status: 'available' | 'full' | 'unknown'.
function classify(reading) {
  if (!reading) return 'unknown';
  if (reading.added) return 'registered';
  if (Number.isFinite(reading.seats) && reading.seats > 0) return 'available';
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
    // readings: array of { code, name, seats, full } read from the page.
    // Returns an array of alerts { code, name, seats } for Full->Available
    // transitions only, de-duplicated, with independent per-course state.
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

        if (status === 'available') {
          // Add an opening whether it appears after Full or was already available
          // when monitoring began. De-duplicate until it becomes Full or Added.
          if (!prev.notified) {
            alerts.push({ code, name, seats, slot });
            state.set(code, { status, name, seats, slot, button: reading.button || '', notified: true });
          } else {
            state.set(code, { status, name, seats, slot, button: reading.button || '', notified: prev.notified });
          }
        } else {
          // full / unknown: reset de-dup so a future re-opening alerts again.
          state.set(code, { status, name, seats, slot, button: reading.button || '', notified: false });
        }
      }
      return alerts;
    },
  };
}

// In-page, read-only: find each course's row and parse it. Clicks nothing.
//
// The row is the LARGEST ancestor of the code label that contains no other
// course-code label. On the portal that is li.f-slat (code, credits, seats,
// name and the Add/Drop/Waiting button). The old "smallest container with a
// status word" rule stopped at div.f-meta ("EV3024 credits72left"), which
// never includes the button, so Added/Drop/Waiting were invisible to it.
function readRowsInPage(codes, parseRowText) {
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  var tokenRe = /^([A-Z]{2,4}\d{3}[A-Z]?)(?:\s*[-:|·,(]|$)/i;
  var labels = [], mine = {};
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    var v = tn.nodeValue;
    if (!v || v.length > 60) continue;
    var m = norm(v).match(tokenRe);
    if (!m) continue;
    labels.push(tn.parentElement);
    var c = m[1].toUpperCase();
    if (codes.indexOf(c) >= 0 && !mine[c]) mine[c] = tn.parentElement;
  }
  function labelsIn(el) {
    var n = 0;
    for (var i = 0; i < labels.length && n < 2; i++) if (el.contains(labels[i])) n++;
    return n;
  }
  function legacyLeaf(code) { // code not in its own element: smallest element starting with it
    var all = document.querySelectorAll('body *'), best = null, bestLen = 1e9;
    for (var i = 0; i < all.length; i++) {
      var tx = norm(all[i].textContent);
      if (tx.length <= 500 && tx.length < bestLen && tx.toUpperCase().indexOf(code) === 0) { best = all[i]; bestLen = tx.length; }
    }
    return best;
  }
  return codes.map(function (code) {
    var leaf = mine[code] || legacyLeaf(code);
    if (!leaf) return { code: code, found: false };
    var row = leaf;
    for (var d = 0; d < 16 && row.parentElement && row.parentElement !== document.body; d++) {
      var p = row.parentElement;
      if (labelsIn(p) > 1 || norm(p.textContent).length > 800) break;
      row = p;
    }
    var r = parseRowText(code, row.textContent);
    r.found = true;
    // The row's own button is the most reliable signal; text parsing is the
    // fallback. "Add" (with or without "+") = open, Drop/Added/... = added,
    // Waiting/Notify/Full = full.
    var bs = row.querySelectorAll('button,a,[role=button],input[type=button]'), label = '';
    for (var b = 0; b < bs.length; b++) {
      var bl = norm(bs[b].textContent || bs[b].value || bs[b].getAttribute('aria-label'));
      if (bl) { label = bl; break; }
    }
    r.button = label.slice(0, 30);
    if (/^\+?\s*Add$/i.test(label)) {
      r.added = false; r.full = false;
      if (!(r.seats > 0)) r.seats = 1; // open, count not shown
      r.disabled = !!(bs[b].disabled || bs[b].getAttribute('aria-disabled') === 'true');
    } else if (/Added|Adding|Drop|Remov|Enrol|Regist|Selected|Withdraw|Cancel|Leave|✓|✔/i.test(label)) {
      r.added = true; r.full = false;
    } else if (/Wait|Notif|Full|Closed|Queue/i.test(label)) {
      r.full = true; r.added = false; r.seats = 0;
    }
    return r;
  });
}

function buildReaderScript(courseCodes) {
  const codes = (courseCodes || []).map(c => String(c).trim().toUpperCase());
  return '(' + readRowsInPage.toString() + ')(' + JSON.stringify(codes) + ',' + parseRowText.toString() + ')';
}

// In-page function: find the "+ Add" button that belongs to the row for `code`.
//
// It works from the button outward, not from the course code. For every
// "+ Add" button on the page it climbs to the smallest ancestor whose text
// contains the code. If that climb passes an ancestor holding a second Add
// button first, the button belongs to another row and is skipped. This avoids
// the old bug where the first page-level container holding the code was used
// as the "row" and the first Add button on the whole page was clicked.
//
// mode "locate": scroll the button into view and return its centre in CSS px,
//                so main.js can send a real (trusted) mouse click there.
// mode "domclick": call button.click() directly (fallback).
// It never looks for or touches a Submit control.
function locateAddInPage(code, slot, mode) {
  function norm(s) { return String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }
  function isAdd(b) { return /^\+?\s*Add$/i.test(norm(b.textContent || b.value || b.getAttribute('aria-label'))); }
  var SEL = 'button,a,[role=button],input[type=button]';
  var esc = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // The portal glues cells together ("EV302Environmental Studies"), so the code
  // may be followed by a letter. Accept that only when it looks like the start
  // of a name (letter + lowercase), not a suffix course like "EV302N Sports".
  var codeRe = new RegExp('(^|[^A-Z0-9])' + esc + '(?![0-9])(?![A-Za-z](?:[^a-z]|$))', 'i');
  var ME = code.toUpperCase();
  // A text node that is just a course code, e.g. "EV302" or "EV302 -".
  var codeTokenRe = /^([A-Z]{2,4}\d{3}[A-Z]?)(?:\s*[-:|·,(]|$)/i;

  // Text nodes holding exactly our code (the same rule the reader uses), and
  // text nodes holding any course code. Matching on these instead of a regex
  // over the glued row text works whatever is stuck before or after the code
  // ("3EV302", "EV302ENVIRONMENTAL", "EV3024 credits").
  var myCodeNodes = [], allCodeNodes = [];
  var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (var tn = walker.nextNode(); tn; tn = walker.nextNode()) {
    var tv = norm(tn.nodeValue);
    if (!tv || tv.length > 40) continue;
    var tm = tv.match(codeTokenRe);
    if (!tm) continue;
    var holder = tn.parentElement;
    allCodeNodes.push({ el: holder, code: tm[1].toUpperCase() });
    if (tm[1].toUpperCase() === ME) myCodeNodes.push(holder);
  }
  function hasMyCode(el) {
    for (var q = 0; q < myCodeNodes.length; q++) if (el.contains(myCodeNodes[q])) return true;
    return !myCodeNodes.length && codeRe.test(norm(el.textContent)); // fallback: code not in its own element
  }
  function otherCodesIn(el) {
    var out = [];
    for (var q = 0; q < allCodeNodes.length; q++) {
      var c = allCodeNodes[q];
      if (c.code !== ME && out.indexOf(c.code) < 0 && el.contains(c.el)) out.push(c.code);
    }
    return out;
  }

  var all = document.querySelectorAll(SEL);
  var addButtons = [];
  for (var i = 0; i < all.length; i++) if (isAdd(all[i])) addButtons.push(all[i]);
  function addsIn(el) {
    var n = 0;
    for (var j = 0; j < addButtons.length && n < 2; j++) if (el.contains(addButtons[j])) n++;
    return n;
  }
  var rejected = [];
  for (var k = 0; k < addButtons.length; k++) {
    var btn = addButtons[k], el = btn.parentElement, row = null;
    for (var d = 0; d < 15 && el && el !== document.body; d++) {
      if (addsIn(el) > 1) break; // passed this button's row: it belongs to another course
      if (hasMyCode(el)) { row = el; break; }
      el = el.parentElement;
    }
    if (!row) continue;
    var rowText = norm(row.textContent);
    var others = otherCodesIn(row);
    if (others.length) { rejected.push('row also contains ' + others.join(',')); continue; }
    var slotM = rowText.match(/E(\d)\b/i);
    if (slot && slotM && ('E' + slotM[1]).toUpperCase() !== slot) { rejected.push('slot E' + slotM[1] + ' != ' + slot); continue; }
    var disabled = !!(btn.disabled || btn.getAttribute('aria-disabled') === 'true');
    if (mode === 'domclick') {
      if (!disabled) btn.click();
      return { found: true, method: 'dom', disabled: disabled, rowText: rowText.slice(0, 160) };
    }
    window.__dtuLastLocated = btn; // lets the watcher guard the real-mouse click
    var r = btn.getBoundingClientRect();
    var vw = window.innerWidth, vh = window.innerHeight;
    if (r.top < 0 || r.left < 0 || r.bottom > vh || r.right > vw || !r.width) {
      // 'instant' ignores CSS smooth scrolling, so the rect is final right away.
      btn.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      r = btn.getBoundingClientRect();
    }
    var x = r.left + r.width / 2, y = r.top + r.height / 2;
    var hit = document.elementFromPoint(x, y);
    var covered = !(hit && (hit === btn || btn.contains(hit)));
    return { found: true, method: 'trusted', x: x, y: y, w: r.width, h: r.height, disabled: disabled,
      covered: covered, hitTag: hit ? hit.tagName + '.' + String(hit.className || '').slice(0, 40) : null,
      rowText: rowText.slice(0, 160) };
  }
  // Not found. Work out whether the row is already Added, and describe the
  // structure around the code so a failure on the live portal can be diagnosed.
  var rowAdded = false, chain = [];
  var start = myCodeNodes[0] || null;
  for (var up = start, u = 0; u < 10 && up && up !== document.body; u++, up = up.parentElement) {
    var t = norm(up.textContent);
    var nAdds = addsIn(up), nOther = otherCodesIn(up).length;
    // "Added", "Drop", "Dropping", "Adding…": already added or a request is in flight.
    if (!rowAdded && nOther === 0 && /Added|Adding|Drop|Remov|Enrol|Regist|Selected|Withdraw|✓|✔/i.test(t)) rowAdded = true;
    chain.push(up.tagName.toLowerCase() + (up.className && typeof up.className === 'string' ? '.' + up.className.trim().split(/\s+/).slice(0, 2).join('.') : '') +
      '[adds=' + nAdds + ',codes=' + (nOther + 1) + ',len=' + t.length + ']');
    if (nOther > 0) break;
  }
  return { found: false, added: rowAdded, addButtonsOnPage: addButtons.length, rejected: rejected,
    codeNodes: myCodeNodes.length, chain: chain.join(' > '),
    rowText: start ? norm((start.parentElement && start.parentElement.parentElement || start.parentElement || start).textContent).slice(0, 200) : '' };
}

function buildAddCourseScript(code, slot, mode) {
  return '(' + locateAddInPage.toString() + ')(' +
    JSON.stringify(String(code).trim().toUpperCase()) + ',' +
    JSON.stringify(String(slot || '').trim().toUpperCase()) + ',' +
    JSON.stringify(mode === 'domclick' ? 'domclick' : 'locate') + ')';
}

// Marker prefix for messages from the in-page watcher to main.js.
const FAST_ADD_PREFIX = '__DTU_FAST_ADD__';

// In-page watcher: the PRIMARY, fastest add path. Runs in an isolated world.
//
// A MutationObserver fires the moment the portal re-renders. If a configured
// course's "+ Add" button is present, the watcher clicks it right there
// (element.click(), no round-trip to main.js: well under 1 ms). If the button
// still says "+ Add" `gap` ms later (click ignored), it alternates to asking
// main.js for a trusted mouse click at the button's coordinates, then DOM
// again, and so on, at most one click per `gap` ms per course.
//
// Loop safety: a click is only made when `gap` has passed since the last one,
// and scanning itself never mutates the DOM, so the observer cannot spin.
// Reports to main.js go through console.debug in the isolated world (the
// portal cannot silence it): {kind:'dom'|'trusted'|'added', code, n, ...}.
function fastWatcherInPage(list, sid, gap, prefix, locate, quick) {
  if (window.__dtuFast && window.__dtuFast.obs) window.__dtuFast.obs.disconnect();
  var st = { sid: sid, last: {}, n: {}, timers: {}, pending: false, obs: null, armed: null };
  window.__dtuFast = st;
  function report(o) { o.sid = sid; console.debug(prefix + JSON.stringify(o)); }

  // Click guard for the real-mouse fallback. That click is aimed at screen
  // coordinates; if the page re-laid itself out in the few ms before it lands,
  // it could hit something else (e.g. a Drop button). While a real click is
  // pending, any real mouse event that is NOT on the exact Add button we aimed
  // at is cancelled before the portal sees it.
  function isAddEl(b) {
    var t = String(b.textContent || b.value || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
    return /^\+?\s*Add$/i.test(t);
  }
  function guard(ev) {
    var a = st.armed;
    if (window.__dtuFast !== st || !a || !ev.isTrusted) return;
    if (Date.now() > a.until) { st.armed = null; return; }
    var onTarget = a.btn.isConnected && a.btn.contains(ev.target) && isAddEl(a.btn);
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
      // After the very first (DOM) click, give it only `quick` ms to show any
      // reaction before firing the real-mouse fallback; then alternate every `gap`.
      var wait = (n === 1 ? quick : gap) - (now - (st.last[code] || 0));
      if (wait > 0) { later(code, wait + 5); continue; }
      var useDom = n % 2 === 0;
      var r;
      try { r = locate(code, e.slot, useDom ? 'domclick' : 'locate'); } catch (_) { continue; }
      if (r && r.found) {
        if (r.disabled) continue; // an attribute mutation will wake us when it enables
        st.last[code] = now; st.n[code] = n + 1;
        if (useDom || r.covered) {
          if (!useDom) locate(code, e.slot, 'domclick'); // covered: real mouse would miss
          report({ kind: 'dom', code: code, n: n + 1 });
        } else {
          st.armed = { btn: window.__dtuLastLocated, code: code, until: Date.now() + 250 };
          report({ kind: 'trusted', code: code, n: n + 1, x: r.x, y: r.y });
        }
        later(code, (n === 0 ? quick : gap) + 2); // re-check even if the click is silently ignored
      } else if (r && r.added && n > 0) {
        st.n[code] = 0;
        report({ kind: 'added', code: code });
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
    locateAddInPage.toString() + ',' + JSON.stringify(Number(quickMs) || 60) + ')';
}

// Make the portal page believe it is always visible, so a hidden or minimised
// portal window does not pause its own seat refresh (many sites stop polling
// when document.hidden is true). Runs in the page's main world. Changes
// nothing on the server; it only stops the page from idling itself.
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
  PORTAL_URL, FAST_ADD_PREFIX, STOP_FAST_WATCHER_SCRIPT, KEEP_VISIBLE_SCRIPT,
  parseRowText, classify, createMonitor, buildReaderScript, buildAddCourseScript, buildFastWatcherScript, locateAddInPage,
};
