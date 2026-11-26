// renderer.js — DTU Seat Monitor. One panel per student login.

document.addEventListener('DOMContentLoaded', () => {
  const accountsEl = document.getElementById('accounts');
  const addAccountBtn = document.getElementById('add-account');
  const template = document.getElementById('account-template');
  const MAX_ACCOUNTS = 6;
  const LOG_KINDS = { action: 'good', good: 'good', warn: 'warn', error: 'error', info: 'info' };
  const panels = new Map(); // accountId -> panel

  // Course watchlists must be intentional for each run. Never restore an old
  // allowlist because a stale saved code could cause an unexpected Add.
  try { localStorage.removeItem('monitorCodes'); } catch (_) {}

  function freeId() {
    for (let i = 1; ; i++) if (!panels.has(i)) return i;
  }

  function createPanel() {
    const id = freeId();
    const root = template.content.firstElementChild.cloneNode(true);
    root.dataset.accountId = String(id);
    const $ = sel => root.querySelector(sel);
    const p = {
      id, root, running: false,
      name: $('.account-name'), removeBtn: $('.remove-account'),
      courseList: $('.course-list'), addBtn: $('.add-course'), clearBtn: $('.clear-courses'),
      startBtn: $('.start-btn'), stopBtn: $('.stop-btn'),
      status: $('.monitor-status'), heartbeat: $('.monitor-heartbeat'),
      log: $('.monitor-log'), stateList: $('.monitor-state-list'),
    };
    p.name.value = `Login ${id}`;
    p.name.placeholder = `Login ${id} (e.g. your name or roll no.)`;
    panels.set(id, p);

    // Keep panels in id order, so "Login 1" stays on top.
    const after = [...accountsEl.children].find(el => Number(el.dataset.accountId) > id);
    accountsEl.insertBefore(root, after || null);

    p.addBtn.addEventListener('click', () => addCourseRow(p));
    p.clearBtn.addEventListener('click', () => {
      p.courseList.innerHTML = '';
      p.stateList.innerHTML = '';
      addCourseRow(p);
      setStatus(p, 'All courses cleared.', 'warn');
    });
    p.startBtn.addEventListener('click', () => start(p));
    p.stopBtn.addEventListener('click', async () => {
      await window.electronAPI.stopMonitor(p.id);
      setRunning(p, false);
      p.stateList.innerHTML = '';
      setStatus(p, 'Stopped', 'info');
    });
    p.removeBtn.addEventListener('click', async () => {
      if (p.running && !confirm(`Stop monitoring and close the portal window for "${label(p)}"?`)) return;
      await window.electronAPI.removeAccount(p.id);
      panels.delete(p.id);
      root.remove();
      refreshButtons();
    });

    addCourseRow(p, '', false);
    refreshButtons();
    return p;
  }

  function label(p) { return p.name.value.trim() || `Login ${p.id}`; }

  function refreshButtons() {
    addAccountBtn.disabled = panels.size >= MAX_ACCOUNTS;
    // Always keep at least one login panel.
    panels.forEach(p => { p.removeBtn.classList.toggle('hidden', panels.size <= 1); });
  }

  function addCourseRow(p, code = '', focus = true) {
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
    removeBtn.addEventListener('click', () => { row.remove(); renumber(p); });
    // Priority = order in the list. ↑ moves a course one place up.
    const rank = document.createElement('span');
    rank.className = 'priority';
    const upBtn = document.createElement('button');
    upBtn.textContent = '↑';
    upBtn.className = 'move-up';
    upBtn.type = 'button';
    upBtn.title = 'Higher priority';
    upBtn.setAttribute('aria-label', 'Move course up (higher priority)');
    upBtn.addEventListener('click', () => {
      if (row.previousElementSibling) p.courseList.insertBefore(row, row.previousElementSibling);
      renumber(p);
    });
    codeInput.addEventListener('keydown', event => {
      if (event.key === 'Enter') addCourseRow(p);
    });
    row.appendChild(rank);
    row.appendChild(codeInput);
    row.appendChild(upBtn);
    row.appendChild(removeBtn);
    p.courseList.appendChild(row);
    renumber(p);
    if (focus) codeInput.focus();
  }

  function renumber(p) {
    [...p.courseList.children].forEach((row, i) => {
      row.querySelector('.priority').textContent = `${i + 1}.`;
      row.querySelector('.move-up').disabled = p.running || i === 0;
    });
  }

  // Entries may be "HU426" or "HU426:E4".
  function getEntries(p) {
    return [...p.courseList.querySelectorAll('input')]
      .map(i => {
        const parts = i.value.trim().toUpperCase().split(':');
        return { code: (parts[0] || '').trim(), slot: (parts[1] || '').trim() };
      })
      .filter(e => e.code);
  }
  function slotLabelFor(p, code) {
    const e = getEntries(p).find(x => x.code === code);
    return (e && e.slot) || '';
  }

  function setRunning(p, running) {
    p.running = running;
    p.startBtn.classList.toggle('hidden', running);
    p.stopBtn.classList.toggle('hidden', !running);
    if (!running) p.heartbeat.textContent = '';
    p.addBtn.disabled = running;
    p.clearBtn.disabled = running;
    p.name.disabled = running;
    p.courseList.querySelectorAll('input, .remove-course').forEach(el => { el.disabled = running; });
    renumber(p); // also locks/unlocks the ↑ buttons
    p.root.classList.toggle('running', running);
  }

  function setStatus(p, message, kind = 'info') {
    p.status.textContent = message;
    p.status.className = `monitor-status status-${kind}`;
  }

  async function start(p) {
    const entries = getEntries(p);
    if (!entries.length) { setStatus(p, 'Add at least one course code first.', 'warn'); return; }
    const r = await window.electronAPI.startMonitor({ accountId: p.id, label: label(p), entries });
    if (r && r.success) {
      setRunning(p, true);
      setStatus(p, `Watching ${entries.length} course(s). Log in as "${label(p)}" in the portal window titled "${label(p)}".`);
    } else {
      setStatus(p, (r && r.error) || 'Could not start monitoring.', 'error');
    }
  }

  function logEvent(p, s) {
    const li = document.createElement('li');
    li.className = `log-${LOG_KINDS[s.type] || 'info'}`;
    const t = new Date(s.ts || Date.now());
    li.textContent = `${t.toLocaleTimeString('en-IN')}  ${s.message}`;
    p.log.prepend(li);
    while (p.log.children.length > 40) p.log.lastChild.remove();
  }

  const panelFor = data => panels.get(Number(data && data.accountId) || 1);

  window.electronAPI.onMonitorStatus((event, s) => {
    const p = panelFor(s); if (!p) return;
    const kind = s.type === 'action' || s.type === 'good' ? 'info' : (s.type || 'info');
    setStatus(p, s.message, kind);
    logEvent(p, s);
  });

  window.electronAPI.onMonitorStopped((event, data) => {
    const p = panelFor(data); if (!p) return;
    setRunning(p, false);
    p.stateList.innerHTML = '';
    setStatus(p, 'Monitoring stopped.', 'info');
  });

  window.electronAPI.onMonitorState((event, data) => {
    const p = panelFor(data); if (!p || !p.running) return;
    p.stateList.innerHTML = '';
    const order = getEntries(p).map(e => e.code);
    const state = data.state || {};
    (order.length ? order : Object.keys(state)).forEach(code => {
      const s = state[code];
      if (!s) return;
      const li = document.createElement('li');
      let text, kind;
      if (s.status === 'registered') { text = 'ADDED ✓'; kind = 'good'; }
      else if (s.status === 'available') { text = `${s.seats} seat(s) left`; kind = 'good'; }
      else if (s.status === 'full') { text = 'Full'; kind = 'warn'; }
      // Unclassified: show the portal's own button word so it is never a mystery.
      else { text = s.button ? `portal shows "${s.button}"` : 'no button in row'; kind = 'info'; }
      li.className = `log-${kind}`;
      const slot = slotLabelFor(p, code) || s.slot || '';
      li.textContent = `${code}${slot ? ` [${slot}]` : ''}${s.name ? ' — ' + s.name : ''}: ${text}`;
      p.stateList.appendChild(li);
    });
    const checked = new Date(data.ts || Date.now()).toLocaleTimeString('en-IN');
    // Separate line, so the 150 ms heartbeat never hides add/click messages.
    p.heartbeat.textContent = data.reloading
      ? `Portal reloading or offline - will resume automatically (${checked})`
      : data.found === 0
      ? `Course not on the page yet - open the course list in the portal. (${checked})`
      : `Live - ${data.found}/${data.total} on page (${checked})`;
    p.heartbeat.className = `monitor-heartbeat ${data.found === 0 ? 'status-warn' : 'status-info'}`;
  });

  addAccountBtn.addEventListener('click', () => {
    if (panels.size >= MAX_ACCOUNTS) return;
    const p = createPanel();
    p.name.focus();
    p.name.select();
  });

  createPanel();
});
