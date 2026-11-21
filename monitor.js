// monitor.js
//
// Read-only seat monitor for the NEW DTU registration portal (/register/).
//
// What it does:
//   * Watches specific course codes for a change from "Full" to "Available".
//   * Keeps independent state per course and de-duplicates notifications.
//   * Produces alert objects (code, name, seats) that the app turns into a
//     desktop notification + sound.
//
// What it deliberately does NOT do:
//   * It never clicks Add / Register / Submit and never writes to the portal.
//     It only OBSERVES the page the user has already opened and verified.
//     The final registration click is always left to the user.
//
// The core logic here is pure and unit-tested (see selftest/monitor.run.js).
// The DOM reader (buildReaderScript) is executed inside the user's own
// authenticated browser window; it is read-only.

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
  var seats = m ? parseInt(m[1], 10) : 0;
  var added = /Added/i.test(t) || /Drop/i.test(t);
  var full = !m && !added && (/Notif/i.test(t) || /Full/i.test(t));
  var name = t
    .replace(code, '')
    .replace(/\d+\s*left/ig, '')
    .replace(/\d+\s*credits?/ig, '')
    .replace(/Notifying you/ig, '')
    .replace(/Notify me/ig, '')
    .replace(/Full/ig, '')
    .replace(/Added/ig, '')
    .replace(/Drop/ig, '')
    .replace(/Add/ig, '')
    .replace(/\s+/g, ' ')
    .trim();
  return { code: code, name: name, seats: seats, full: full, added: added };
}

// Turn a reading into a status: 'available' | 'full' | 'unknown'.
function classify(reading) {
  if (!reading) return 'unknown';
  if (Number.isFinite(reading.seats) && reading.seats > 0) return 'available';
  if (reading.full) return 'full';
  return 'unknown';
}

// Creates an independent, de-duplicating monitor for the given course codes.
function createMonitor(courseCodes) {
  const codes = (courseCodes || []).map(c => String(c).trim().toUpperCase()).filter(Boolean);
  const state = new Map(); // code -> { status, name, seats, notified }
  codes.forEach(c => state.set(c, { status: 'init', name: '', seats: 0, notified: false }));

  return {
    codes,
    getState() {
      const out = {};
      for (const c of codes) out[c] = { ...state.get(c) };
      return out;
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

        if (status === 'available') {
          // Fire only when the course was previously KNOWN to be not-available
          // (full/unknown) and we have not already notified for this opening.
          // A course that is available on the very first sighting is treated as
          // a baseline (no alert) - that is not a Full->Available change.
          const wasKnownNotAvailable = prev.status === 'full' || prev.status === 'unknown';
          if (wasKnownNotAvailable && !prev.notified) {
            alerts.push({ code, name, seats });
            state.set(code, { status, name, seats, notified: true });
          } else {
            state.set(code, { status, name, seats, notified: prev.notified });
          }
        } else {
          // full / unknown: reset de-dup so a future re-opening alerts again.
          state.set(code, { status, name, seats, notified: false });
        }
      }
      return alerts;
    },
  };
}

// Builds the read-only script that runs INSIDE the user's authenticated portal
// window. It finds each course row by its visible code, reads the row text, and
// returns one reading per code. It clicks nothing and changes nothing.
function buildReaderScript(courseCodes) {
  const codes = (courseCodes || []).map(c => String(c).trim().toUpperCase());
  return (
    '(function(codes){' +
    'var parseRowText=' + parseRowText.toString() + ';' +
    'function rowFor(code){' +
    '  var all=document.querySelectorAll("*");' +
    '  var leaf=null;' +
    '  for(var i=0;i<all.length;i++){var n=all[i];if(n.children.length===0&&n.textContent.trim()===code){leaf=n;break;}}' +
    '  if(!leaf)return null;' +
    '  var el=leaf;' +
    '  for(var d=0;d<8&&el;d++){' +
    '    var t=el.textContent;' +
    '    if(/\\bleft\\b/i.test(t)||/\\bFull\\b/i.test(t)||/\\bAdd\\b/i.test(t)||/Notif/i.test(t))return el;' +
    '    el=el.parentElement;' +
    '  }' +
    '  return leaf.closest("div,li,tr")||leaf.parentElement;' +
    '}' +
    'return codes.map(function(code){' +
    '  var row=rowFor(code);' +
    '  if(!row)return {code:code,found:false};' +
    '  var r=parseRowText(code,row.textContent);' +
    '  r.found=true;return r;' +
    '});' +
    '})(' + JSON.stringify(codes) + ')'
  );
}

module.exports = { PORTAL_URL, parseRowText, classify, createMonitor, buildReaderScript };
