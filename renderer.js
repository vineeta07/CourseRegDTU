// renderer.js — DTU Seat Monitor (read-only). No auto-registration.

document.addEventListener('DOMContentLoaded', () => {
  const monitorCourseList = document.getElementById('monitor-course-list');
  const monitorAddBtn = document.getElementById('monitor-add-course');
  const monitorStartBtn = document.getElementById('monitor-start-btn');
  const monitorStopBtn = document.getElementById('monitor-stop-btn');
  const monitorStatus = document.getElementById('monitor-status');
  const monitorStateList = document.getElementById('monitor-state-list');

  function addMonitorRow(code = '') {
    const row = document.createElement('div');
    row.className = 'course-row';
    const codeInput = document.createElement('input');
    codeInput.type = 'text';
    codeInput.placeholder = 'Course Code, optionally :Slot (e.g. HU426:E4)';
    codeInput.value = code;
    codeInput.setAttribute('aria-label', 'Course code');
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'remove-course';
    removeBtn.type = 'button';
    removeBtn.setAttribute('aria-label', 'Remove course');
    removeBtn.addEventListener('click', () => { monitorCourseList.removeChild(row); saveMonitorCodes(); });
    codeInput.addEventListener('input', saveMonitorCodes);
    codeInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') addMonitorRow();
    });
    row.appendChild(codeInput);
    row.appendChild(removeBtn);
    monitorCourseList.appendChild(row);
    if (!code) codeInput.focus();
  }

  // Entries may be "HU426" or "HU426:E4" (slot is just a display label; matching is by code).
  function getMonitorEntries() {
    return [...monitorCourseList.querySelectorAll('input')]
      .map(i => {
        const parts = i.value.trim().toUpperCase().split(':');
        return { code: (parts[0] || '').trim(), slot: (parts[1] || '').trim() };
      })
      .filter(e => e.code);
  }
  function getMonitorCodes() { return getMonitorEntries().map(e => e.code); }
  function slotLabelFor(code) {
    const e = getMonitorEntries().find(x => x.code === code);
    return (e && e.slot) || '';
  }

  function saveMonitorCodes() {
    try {
      const raw = [...monitorCourseList.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
      localStorage.setItem('monitorCodes', JSON.stringify(raw));
    } catch (_) {}
  }

  (function loadMonitorCodes() {
    let codes = [];
    try { codes = JSON.parse(localStorage.getItem('monitorCodes') || 'null') || []; } catch (_) {}
    if (codes.length) {
      codes.forEach(c => addMonitorRow(c));
    } else {
      addMonitorRow();
    }
  })();

  monitorAddBtn.addEventListener('click', () => addMonitorRow());

  function setMonitorUI(running) {
    monitorStartBtn.classList.toggle('hidden', running);
    monitorStopBtn.classList.toggle('hidden', !running);
    monitorAddBtn.disabled = running;
    monitorCourseList.querySelectorAll('input, button').forEach(el => { el.disabled = running; });
  }

  function setMonitorStatus(message, kind = 'info') {
    monitorStatus.textContent = message;
    monitorStatus.className = `status-${kind}`;
  }

  // A loud, repeating two-tone siren for ~5 seconds when a seat opens.
  let alarmCtx = null;
  function loudAlarm() {
    try {
      alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = alarmCtx;
      if (ctx.state === 'suspended') ctx.resume();
      for (let i = 0; i < 10; i++) {
        const t = ctx.currentTime + i * 0.5;
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.type = 'square';
        o.frequency.setValueAtTime(i % 2 ? 1046 : 784, t);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.5, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.45);
        o.connect(g); g.connect(ctx.destination);
        o.start(t); o.stop(t + 0.5);
      }
    } catch (_) {}
  }

  monitorStartBtn.addEventListener('click', async () => {
    const codes = getMonitorCodes();
    if (!codes.length) { setMonitorStatus('Add at least one course code first.', 'warn'); return; }
    // Unlock audio so the alarm can play later (browsers need a user gesture first).
    try { alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)(); if (alarmCtx.state === 'suspended') alarmCtx.resume(); } catch (_) {}
    const r = await window.electronAPI.startMonitor({ codes });
    if (r && r.success) { setMonitorUI(true); setMonitorStatus('Starting… a portal window is opening. Log in there and keep it open.'); }
    else { setMonitorStatus((r && r.error) || 'Could not start monitoring.', 'error'); }
  });

  monitorStopBtn.addEventListener('click', async () => {
    await window.electronAPI.stopMonitor();
    setMonitorUI(false);
  });

  window.electronAPI.onMonitorStatus((event, s) => setMonitorStatus(s.message, s.type || 'info'));
  window.electronAPI.onMonitorStopped(() => setMonitorUI(false));

  window.electronAPI.onMonitorState((event, data) => {
    monitorStateList.innerHTML = '';
    const order = getMonitorCodes();
    const state = data.state || {};
    (order.length ? order : Object.keys(state)).forEach(code => {
      const s = state[code];
      if (!s) return;
      const li = document.createElement('li');
      let label, kind;
      if (s.status === 'available') { label = `${s.seats} seat(s) LEFT`; kind = 'good'; }
      else if (s.status === 'full') { label = 'Full'; kind = 'warn'; }
      else { label = 'waiting…'; kind = 'info'; }
      li.className = `log-${kind}`;
      const slot = slotLabelFor(code) || s.slot || '';
      li.textContent = `${code}${slot ? ` [${slot}]` : ''}${s.name ? ' — ' + s.name : ''}: ${label}`;
      monitorStateList.appendChild(li);
    });
    const checked = new Date(data.ts || Date.now()).toLocaleTimeString('en-IN');
    setMonitorStatus(`Watching ${data.found}/${data.total} course(s) on the page. Last checked ${checked}.`,
      data.found === 0 ? 'warn' : 'info');
  });

  window.electronAPI.onMonitorAlert((event, a) => {
    loudAlarm();
    const li = document.createElement('li');
    li.className = 'log-good';
    const slot = slotLabelFor(a.code) || a.slot || '';
    li.textContent = `🔔 SEAT OPEN: ${a.code}${slot ? ` [${slot}]` : ''}${a.name ? ' — ' + a.name : ''} — ${a.seats} left! Attempting to add. Do NOT click Submit.`;
    monitorStateList.prepend(li);
  });
});
