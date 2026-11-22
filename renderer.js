// renderer.js — DTU Seat Monitor (read-only). No auto-registration.

document.addEventListener('DOMContentLoaded', () => {
  const monitorCourseList = document.getElementById('monitor-course-list');
  const monitorAddBtn = document.getElementById('monitor-add-course');
  const monitorClearBtn = document.getElementById('monitor-clear-courses');
  const monitorStartBtn = document.getElementById('monitor-start-btn');
  const monitorStopBtn = document.getElementById('monitor-stop-btn');
  const monitorStatus = document.getElementById('monitor-status');
  const monitorStateList = document.getElementById('monitor-state-list');
  let monitorRunning = false;

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
      if (monitorRunning && window.electronAPI && window.electronAPI.updateMonitor) {
        const entries = getMonitorEntries();
        window.electronAPI.updateMonitor({ entries, codes: entries.map(e => e.code) });
      }
    } catch (_) {}
  }

  (function loadMonitorCodes() {
    // Course watchlists must be intentional for each run. Never restore an old
    // allowlist because a stale saved EP/CH code could cause an unexpected Add.
    try { localStorage.removeItem('monitorCodes'); } catch (_) {}
    addMonitorRow();
  })();

  monitorAddBtn.addEventListener('click', () => addMonitorRow());

  monitorClearBtn.addEventListener('click', async () => {
    monitorCourseList.innerHTML = '';
    try { localStorage.setItem('monitorCodes', '[]'); } catch (_) {}
    if (monitorRunning) await window.electronAPI.updateMonitor({ entries: [], codes: [] });
    addMonitorRow();
    setMonitorStatus('All courses cleared.', 'warn');
  });

  function setMonitorUI(running) {
    monitorRunning = running;
    monitorStartBtn.classList.toggle('hidden', running);
    monitorStopBtn.classList.toggle('hidden', !running);
  }

  function setMonitorStatus(message, kind = 'info') {
    monitorStatus.textContent = message;
    monitorStatus.className = `status-${kind}`;
  }

  monitorStartBtn.addEventListener('click', async () => {
    const entries = getMonitorEntries();
    const codes = entries.map(e => e.code);
    if (!codes.length) { setMonitorStatus('Add at least one course code first.', 'warn'); return; }
    const r = await window.electronAPI.startMonitor({ entries, codes });
    if (r && r.success) { setMonitorUI(true); setMonitorStatus(`Configured ${codes.length} course(s). Starting… a portal window is opening. Log in there and keep it open.`); }
    else { setMonitorStatus((r && r.error) || 'Could not start monitoring.', 'error'); }
  });

  monitorStopBtn.addEventListener('click', async () => {
    await window.electronAPI.stopMonitor();
    monitorRunning = false;
    setMonitorUI(false);
  });

  window.electronAPI.onMonitorStatus((event, s) => setMonitorStatus(s.message, s.type || 'info'));
  window.electronAPI.onMonitorStopped(() => { monitorRunning = false; setMonitorUI(false); });

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
    setMonitorStatus(`Configured ${order.length} course(s); watching ${data.found}/${data.total} course(s) on the page. Last checked ${checked}.`,
      data.found === 0 ? 'warn' : 'info');
  });

  window.electronAPI.onMonitorAlert((event, a) => {
    const li = document.createElement('li');
    li.className = 'log-good';
    const slot = slotLabelFor(a.code) || a.slot || '';
    li.textContent = `SEAT AVAILABLE: ${a.code}${slot ? ` [${slot}]` : ''}${a.name ? ' — ' + a.name : ''} — ${a.seats} left. Add attempt sent. Do NOT click Submit.`;
    monitorStateList.prepend(li);
  });
});
