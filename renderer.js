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
  monitorStateList.innerHTML = '';

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
    // Course watchlists must be intentional for each run. Never restore an old
    // allowlist because a stale saved EP/CH code could cause an unexpected Add.
    try { localStorage.removeItem('monitorCodes'); } catch (_) {}
    addMonitorRow();
  })();

  monitorAddBtn.addEventListener('click', () => addMonitorRow());

  monitorClearBtn.addEventListener('click', async () => {
    monitorCourseList.innerHTML = '';
    try { localStorage.setItem('monitorCodes', '[]'); } catch (_) {}
    monitorStateList.innerHTML = '';
    addMonitorRow();
    setMonitorStatus('All courses cleared.', 'warn');
  });

  const portalBtn = document.getElementById('monitor-portal-btn');
  portalBtn.addEventListener('click', async () => {
    const r = await window.electronAPI.togglePortal();
    portalBtn.textContent = r && r.visible ? 'Hide portal window' : 'Show portal window';
  });

  function setMonitorUI(running) {
    monitorRunning = running;
    monitorStartBtn.classList.toggle('hidden', running);
    monitorStopBtn.classList.toggle('hidden', !running);
    portalBtn.classList.toggle('hidden', !running);
    if (!running) portalBtn.textContent = 'Hide portal window';
    monitorAddBtn.disabled = running;
    monitorClearBtn.disabled = running;
    monitorCourseList.querySelectorAll('input, .remove-course').forEach(el => {
      el.disabled = running;
    });
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
    monitorStateList.innerHTML = '';
    setMonitorStatus('Monitoring stopped by you.', 'info');
  });

  const monitorHeartbeat = document.getElementById('monitor-heartbeat');
  const monitorLog = document.getElementById('monitor-log');
  const LOG_KINDS = { action: 'good', good: 'good', warn: 'warn', error: 'error', info: 'info' };
  function logEvent(s) {
    const li = document.createElement('li');
    li.className = `log-${LOG_KINDS[s.type] || 'info'}`;
    const t = new Date(s.ts || Date.now());
    li.textContent = `${t.toLocaleTimeString('en-IN')}  ${s.message}`;
    monitorLog.prepend(li);
    while (monitorLog.children.length > 40) monitorLog.lastChild.remove();
  }

  window.electronAPI.onMonitorStatus((event, s) => {
    const kind = s.type === 'action' || s.type === 'good' ? 'info' : (s.type || 'info');
    setMonitorStatus(s.message, kind);
    logEvent(s);
  });
  window.electronAPI.onMonitorStopped(() => {
    monitorRunning = false;
    setMonitorUI(false);
    monitorStateList.innerHTML = '';
    monitorHeartbeat.textContent = '';
    setMonitorStatus('Monitoring stopped.', 'info');
  });

  window.electronAPI.onMonitorState((event, data) => {
    monitorStateList.innerHTML = '';
    const order = getMonitorCodes();
    const state = data.state || {};
    (order.length ? order : Object.keys(state)).forEach(code => {
      const s = state[code];
      if (!s) return;
      const li = document.createElement('li');
      let label, kind;
      if (s.status === 'registered') { label = 'ADDED ✓'; kind = 'good'; }
      else if (s.status === 'available') { label = `${s.seats} seat(s) left`; kind = 'good'; }
      else if (s.status === 'full') { label = 'Full'; kind = 'warn'; }
      // Unclassified: show the portal's own button word so it is never a mystery.
      else { label = s.button ? `portal shows "${s.button}"` : 'no button in row'; kind = 'info'; }
      li.className = `log-${kind}`;
      const slot = slotLabelFor(code) || s.slot || '';
      li.textContent = `${code}${slot ? ` [${slot}]` : ''}${s.name ? ' — ' + s.name : ''}: ${label}`;
      monitorStateList.appendChild(li);
    });
    const checked = new Date(data.ts || Date.now()).toLocaleTimeString('en-IN');
    // Separate line, so the 150 ms heartbeat never hides add/click messages.
    monitorHeartbeat.textContent = data.reloading
      ? `Portal reloading or offline - will resume automatically (${checked})`
      : data.found === 0
      ? `Course not on the page yet - open the course list in the portal. (${checked})`
      : `Live - ${data.found}/${data.total} on page (${checked})`;
    monitorHeartbeat.className = data.found === 0 ? 'status-warn' : 'status-info';
  });

  window.electronAPI.onMonitorAlert((event, a) => {
    const li = document.createElement('li');
    li.className = 'log-good';
    const slot = slotLabelFor(a.code) || a.slot || '';
    li.textContent = `SEAT AVAILABLE: ${a.code}${slot ? ` [${slot}]` : ''}${a.name ? ' — ' + a.name : ''} — ${a.seats} left. Add attempt sent. Do NOT click Submit.`;
    monitorStateList.prepend(li);
  });
});
