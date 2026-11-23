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
//   * It never clicks Register / Submit and never completes final submission.
//     It may add a course through the matching row's Add control, but the final
//     registration click always remains a separate action.
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
  var full = !m && !added && (/Notif/i.test(t) || /Full/i.test(t) || /Waiting\s*for\s*a?\s*seat/i.test(t) || /Waiting\s*for\s*seat/i.test(t));
  // Slot like E1/E2/E4 may be glued to the name ("ApplicationsE3"), so no leading \b.
  var slotM = t.match(/E(\d)\b/i);
  var slot = slotM ? ('E' + slotM[1]) : '';
  var namePart = t;
  var statusMarkers = [
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
    .replace(code, '')
    .replace(/\d+\s*left/ig, '')
    .replace(/\d+\s*credits?/ig, '')
    .replace(/\d+\s*cr\b/ig, '')
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
  if (reading.added) return 'unknown';
  if (Number.isFinite(reading.seats) && reading.seats > 0) return 'available';
  if (reading.full) return 'full';
  return 'unknown';
}

// React to portal DOM mutations for the exact courses configured in the UI.
// This runs only inside the authenticated portal window and never targets Submit.
function buildSeatObserverScript(entries) {
  const list = (entries || []).map(e => ({
    code: String((e && e.code) || '').trim().toUpperCase(),
    slot: String((e && e.slot) || '').trim().toUpperCase(),
  })).filter(e => e.code);
  return (
    '(function(list){' +
    'if(window.__dtuExactSeatObserver)return {installed:true};' +
    'window.__dtuExactSeatObserver=true;' +
    'var clicked={};' +
    'function scan(){' +
    '  for(var i=0;i<list.length;i++){var item=list[i],code=item.code,slot=item.slot;' +
    '    var all=document.querySelectorAll("body *"),leaf=null;' +
    '    for(var n=0;n<all.length;n++){var el=all[n];if(el.children.length!==0)continue;' +
    '    var tx=(el.textContent||"").replace(/\\s+/g," ").trim();' +
    '    if(tx.toUpperCase()===code){leaf=el;break;} }' +
    '    if(!leaf){delete clicked[code];continue;}' +
    '    var row=leaf,rowText="",button=null;' +
    '    for(var d=0;d<16&&row;d++){rowText=(row.textContent||"").replace(/\\s+/g," ").trim();' +
    '      if(/\\b(Added|Drop)\\b/i.test(rowText)||/\\bFull\\b/i.test(rowText)||/Waiting\\s*for\\s*(a\\s*)?seat/i.test(rowText)){delete clicked[code];break;}'+
    '      if(slot&&rowText.toUpperCase().indexOf(slot)<0){row=row.parentElement;continue;}'+
    '      var bs=row.querySelectorAll("button,a,[role=button],input[type=button]");' +
    '      for(var b=0;b<bs.length;b++){var ct=(bs[b].textContent||bs[b].value||bs[b].getAttribute("aria-label")||"").replace(/\\s+/g," ").trim();' +
    '      if(/^\\+?\\s*Add$/i.test(ct)&&bs[b].offsetParent!==null){button=bs[b];break;} }' +
    '      if(button)break;row=row.parentElement;' +
    '    }' +
    '    if(!button||clicked[code])continue;' +
    '    clicked[code]=true;' +
    '    try{button.click();}catch(e){delete clicked[code];}' +
    '  }' +
    '}' +
    'var observer=new MutationObserver(function(){scan();});' +
    'observer.observe(document.documentElement||document.body,{subtree:true,childList:true,characterData:true,attributes:true});' +
    'scan();' +
    'return {installed:true};' +
    '})(' + JSON.stringify(list) + ')'
  );
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
            state.set(code, { status, name, seats, slot, notified: true });
          } else {
            state.set(code, { status, name, seats, slot, notified: prev.notified });
          }
        } else {
          // full / unknown: reset de-dup so a future re-opening alerts again.
          state.set(code, { status, name, seats, slot, notified: false });
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
    // Search by course-code text, then ascend to the smallest course-row container.
    // The portal nests the code in spans and may render only one slot at a time.
    'function rowFor(code){' +
    '  var all=document.querySelectorAll("*");' +
    '  var leaf=null,best=null,bestLen=999999;' +
    '  for(var i=0;i<all.length;i++){var n=all[i];var tx=(n.textContent||"").replace(/\\s+/g," ").trim();' +
    '  if(n.children.length===0&&new RegExp("(\\\\b|[^A-Za-z])"+code+"(\\\\b|[^A-Za-z])","i").test(tx)){leaf=n;break;}' +
    '  if(n.children.length>0&&tx.length<=500&&new RegExp("(\\\\b|[^A-Za-z])"+code+"(\\\\b|[^A-Za-z])","i").test(tx)){if(tx.length<bestLen){best=n;bestLen=tx.length;}}}' +
    '  if(!leaf)leaf=best;' +
    '  if(!leaf)return null;' +
    '  var el=leaf;' +
    '  for(var d=0;d<16&&el;d++){' +
    '    var t=(el.textContent||"").replace(/\\s+/g," ").trim();' +
    '    if(t.length<=500&&t.toUpperCase().indexOf(code)>=0&&(/Notif/i.test(t)||/\\bFull\\b/i.test(t)||/\\bleft\\b/i.test(t)||/\\bAdd\\b/i.test(t)||/\\bAdded\\b/i.test(t)||/\\d+\\s*cr/i.test(t)||/\\d+\\s*credits?/i.test(t))){return el;}' +
    '    el=el.parentElement;' +
    '  }' +
    '  return leaf.closest("div,li,tr")||leaf.parentElement||leaf;' +
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

// Builds a script that finds the matching course row and exact + Add button,
// and returns the button's viewport coordinates for one normal mouse click.
// It never searches for or interacts with a Submit control.
function buildAddCourseScript(code, seats, name) {
  const info = JSON.stringify({ code: String(code), seats: Number(seats) || 0, name: String(name || '') });
  return (
    '(function(info){try{' +
    'var code=info.code;' +
    'function findTarget(code){var all=document.querySelectorAll("body *");' +
    'for(var i=0;i<all.length;i++){var leaf=all[i];if(leaf.children.length!==0)continue;' +
    'var tx=(leaf.textContent||"").replace(/\\s+/g," ").trim();if(tx.toUpperCase()!==code)continue;' +
    'var el=leaf;for(var d=0;d<16&&el;d++){var rowText=(el.textContent||"").replace(/\\s+/g," ").trim();' +
    'if(/\\b(Added|Drop)\\b/i.test(rowText)){el=null;break;}'+
    'var cands=el.querySelectorAll("button,a,[role=button],input[type=button]");' +
    'for(var j=0;j<cands.length;j++){var c=cands[j];var ct=(c.textContent||c.value||c.getAttribute("aria-label")||"").replace(/\\s+/g," ").replace(/\\u00a0/g," ").trim();' +
    'if(/^\\+?\\s*Add$/i.test(ct)&&c.offsetParent!==null){return {row:el,button:c};}}el=el.parentElement;}'+
    '}return null;}' +
    'var target=findTarget(code);' +
    'if(!target)return {success:false,found:false,buttonFound:false,changed:false};' +
    'var row=target.row,btn=target.button;' +
    'var r=btn.getBoundingClientRect();' +
    'try{btn.click();}catch(e){return {success:false,found:true,buttonFound:true,changed:false,x:r.left+r.width/2,y:r.top+r.height/2,error:String(e)};}' +
    'return {success:true,found:true,buttonFound:true,changed:false,x:r.left+r.width/2,y:r.top+r.height/2};' +
    '}catch(e){return {success:false,found:false,buttonFound:false,changed:false,error:String(e)}}})(' + info + ')'
  );
}

module.exports = { PORTAL_URL, parseRowText, classify, createMonitor, buildReaderScript, buildSeatObserverScript, buildAddCourseScript };
