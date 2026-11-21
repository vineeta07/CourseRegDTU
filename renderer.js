// renderer.js

document.addEventListener('DOMContentLoaded', () => {
  const addCourseBtn = document.getElementById('add-course');
  const courseList = document.getElementById('course-list');
  const startBtn = document.getElementById('start-btn');
  const stopBtn = document.getElementById('stop-btn');
  const retryBtn = document.getElementById('retry-btn');
  const statusArea = document.getElementById('status-area');
  const activityLog = document.getElementById('activity-log');

  // Every message goes into the log (newest on top), so nothing is lost.
  function logLine(message, kind = 'info') {
    const li = document.createElement('li');
    li.className = `log-${kind}`;
    const time = document.createElement('span');
    time.className = 'timestamp';
    time.textContent = new Date().toLocaleTimeString('en-IN');
    li.appendChild(time);
    li.appendChild(document.createTextNode(' ' + message));
    activityLog.prepend(li);
    while (activityLog.children.length > 300) activityLog.lastChild.remove();
  }
  let lastLogged = '';
  function setStatus(message, kind = 'info') {
    statusArea.textContent = message;
    statusArea.className = `status-${kind}`;
    // "Waiting..." messages repeat every few seconds; log them once.
    const key = message.replace(/last checked .*$/, '');
    if (key !== lastLogged) { logLine(message, kind); lastLogged = key; }
  }
  document.getElementById('clear-log-btn').addEventListener('click', () => { activityLog.innerHTML = ''; lastLogged = ''; });
  const errorArea = document.getElementById('error-area');
  const registeredList = document.getElementById('registered-list');
  const blockedList = document.getElementById('blocked-list');
  const togglePassword = document.getElementById('toggle-password');
  const passwordInput = document.getElementById('password');
  const eyeOpen = document.getElementById('eye-open');
  const eyeClosed = document.getElementById('eye-closed');

  // JSON Input Modal Elements
  const jsonInputBtn = document.getElementById('json-input-btn');
  const jsonInputModal = document.getElementById('json-input-modal');
  const closeJsonBtn = document.getElementById('close-json-btn');
  const saveJsonBtn = document.getElementById('save-json-btn');
  const resetJsonBtn = document.getElementById('reset-json-btn');
  const jsonInputArea = document.getElementById('json-input-area');

  let isAutomationRunning = false;
  let jsonInputState = '';

  const placeholder = `[
  { "code": "HU317", "slot": "E2" },
  { "code": "SE427", "slot": "E1" }
]`;

  const editor = CodeMirror.fromTextArea(jsonInputArea, {
    mode: { name: 'javascript', json: true },
    theme: 'dracula',
    lineNumbers: true,
    autoCloseBrackets: true,
  });

  editor.setValue(placeholder);
  editor.getWrapperElement().style.opacity = '0.5';

  editor.on('focus', () => {
    if (editor.getValue() === placeholder) {
      editor.setValue('');
      editor.getWrapperElement().style.opacity = '1';
    }
  });

  editor.on('blur', () => {
    if (editor.getValue().trim() === '') {
      editor.setValue(placeholder);
      editor.getWrapperElement().style.opacity = '0.5';
    }
  });

  editor.on('change', () => {
    if (editor.getValue() !== placeholder) {
      jsonInputState = editor.getValue();
    }
  });

  // Toggle password visibility
  togglePassword.addEventListener('click', () => {
    const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
    passwordInput.setAttribute('type', type);
    eyeOpen.classList.toggle('hidden');
    eyeClosed.classList.toggle('hidden');
  });

  // Function to display errors
  function showError(message) {
    errorArea.textContent = message;
    errorArea.classList.remove('hidden');
  }

  // Function to clear errors
  function clearError() {
    errorArea.classList.add('hidden');
  }

  // Function to update UI state
  function setUIState(isAutomationRunning) {
    startBtn.classList.toggle('hidden', isAutomationRunning);
    stopBtn.classList.toggle('hidden', !isAutomationRunning);
    retryBtn.classList.toggle('hidden', !isAutomationRunning);
    addCourseBtn.disabled = isAutomationRunning;
    jsonInputBtn.disabled = isAutomationRunning;

    document.getElementById('roll-no').disabled = isAutomationRunning;
    document.getElementById('password').disabled = isAutomationRunning;
    document.getElementById('auto-login').disabled = isAutomationRunning;
    document.getElementById('manual-cookie').disabled = isAutomationRunning;
    document.getElementById('manual-student-id').disabled = isAutomationRunning;
    document.getElementById('clear-session-btn').disabled = isAutomationRunning;
    document.getElementById('watch-only').disabled = isAutomationRunning;
    document.getElementById('speed').disabled = isAutomationRunning;
    document.getElementById('browser-ua').disabled = isAutomationRunning;

    const courseRows = document.querySelectorAll('.course-row input, .course-row button');
    courseRows.forEach(element => {
      element.disabled = isAutomationRunning;
    });
  }

  // Add a new course input row
  function addCourseRow(courseCode = '', courseSlot = '') {
    const row = document.createElement('div');
    row.className = 'course-row';

    const courseCodeInput = document.createElement('input');
    courseCodeInput.type = 'text';
    courseCodeInput.placeholder = 'Course Code';
    courseCodeInput.value = courseCode;
    courseCodeInput.required = true;

    const courseSlotInput = document.createElement('input');
    courseSlotInput.type = 'text';
    courseSlotInput.placeholder = 'Slot';
    courseSlotInput.value = courseSlot;
    courseSlotInput.required = true;

    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'remove-course';

    removeBtn.addEventListener('click', () => {
      courseList.removeChild(row);
    });

    row.appendChild(courseCodeInput);
    row.appendChild(courseSlotInput);
    row.appendChild(removeBtn);

    courseList.appendChild(row);
  }

  addCourseBtn.addEventListener('click', () => addCourseRow());

  // Accepts the cookie however it was copied: just the value, a "Cookie: ..." line,
  // several header lines, or a whole "Copy as cURL" command. Returns "name=value; name2=value2".
  function cleanCookie(text) {
    let t = (text || '').trim();
    if (!t) return '';
    const curlHeader = t.match(/-H\s+(['"])cookie:\s*([\s\S]*?)\1/i) || t.match(/(?:-b|--cookie)\s+(['"])([\s\S]*?)\1/i);
    if (curlHeader) t = curlHeader[2];
    else {
      const line = t.split(/\r?\n/).find(l => /^\s*cookie\s*:/i.test(l));
      if (line) t = line;
    }
    t = t.replace(/^\s*cookie\s*:\s*/i, '').replace(/\s*\r?\n\s*/g, '').trim();
    return t.split(';').map(p => p.trim()).filter(p => p.includes('=')).join('; ');
  }

  // ---------- Remember what you typed (on this computer only; password is never saved) ----------
  const SETTINGS_KEY = 'courseRegistrarSettings';
  function saveSettings() {
    try {
      const courses = Array.from(document.querySelectorAll('.course-row')).map(row => {
        const inputs = row.querySelectorAll('input');
        return { code: inputs[0].value.trim(), slot: inputs[1].value.trim() };
      }).filter(c => c.code || c.slot);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        rollNo: document.getElementById('roll-no').value.trim(),
        autoLogin: document.getElementById('auto-login').checked,
        manualCookie: document.getElementById('manual-cookie').value.trim(),
        manualStudentId: document.getElementById('manual-student-id').value.trim(),
        browserUA: document.getElementById('browser-ua').value.trim(),
        speed: document.getElementById('speed').value,
        courses,
      }));
    } catch (_) {}
  }
  function loadSettings() {
    try {
      const st = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
      if (!st) return;
      document.getElementById('roll-no').value = st.rollNo || '';
      document.getElementById('auto-login').checked = !!st.autoLogin;
      document.getElementById('manual-cookie').value = st.manualCookie || '';
      document.getElementById('manual-student-id').value = st.manualStudentId || '';
      document.getElementById('browser-ua').value = st.browserUA || '';
      if (st.speed) document.getElementById('speed').value = st.speed;
      (st.courses || []).forEach(c => addCourseRow(c.code, c.slot));
    } catch (_) {}
  }
  loadSettings();
  // Save whenever something is typed or changed.
  document.addEventListener('input', saveSettings);
  document.addEventListener('change', saveSettings);
  document.addEventListener('click', e => { if (e.target.classList && e.target.classList.contains('remove-course')) setTimeout(saveSettings, 0); });

  document.getElementById('clear-session-btn').addEventListener('click', async () => {
    await window.electronAPI.clearSession();
    setStatus('Saved session cleared. Next start will log in once.');
  });

  // Start the automation process
  startBtn.addEventListener('click', async () => {
    clearError();
    const rollNo = document.getElementById('roll-no').value.trim();
    const password = document.getElementById('password').value.trim();
    const autoLogin = document.getElementById('auto-login').checked;
    const cookieInput = document.getElementById('manual-cookie');
    const manualCookie = cleanCookie(cookieInput.value);
    if (manualCookie && manualCookie !== cookieInput.value.trim()) cookieInput.value = manualCookie;
    let manualStudentId = document.getElementById('manual-student-id').value.trim();
    const idMatch = manualStudentId.match(/([a-f0-9]{24})\/?$/i);
    if (idMatch) manualStudentId = idMatch[1];

    if ((manualCookie && !manualStudentId) || (!manualCookie && manualStudentId)) {
      showError('Enter both the Session Cookie and the Student ID, or leave both empty.');
      return;
    }
    if (!document.getElementById('watch-only').checked &&
        !confirm('Watch-only is OFF: the app will submit register requests. Continue?')) {
      return;
    }
    if (!manualCookie && (!rollNo || !password)) {
      showError('Enter Roll Number and Password (or paste a browser session cookie).');
      return;
    }

    const courseRows = document.querySelectorAll('.course-row');
    const courses = [];
    courseRows.forEach(row => {
      const inputs = row.querySelectorAll('input');
      const courseCode = inputs[0].value.trim();
      const courseSlot = inputs[1].value.trim();
      if (courseCode && courseSlot) {
        courses.push(`${courseCode}:${courseSlot}`);
      }
    });

    if (courses.length === 0) {
      showError('Please add at least one course to track.');
      return;
    }

    isAutomationRunning = true;
    setUIState(isAutomationRunning);
    registeredList.innerHTML = '';
    blockedList.innerHTML = '';
    setStatus('Starting automation...');

    saveSettings();
    const response = await window.electronAPI.startAutomation({
      creds: { r: rollNo, p: password },
      courses: courses,
      autoLogin: autoLogin,
      manualCookie,
      manualStudentId,
      watchOnly: document.getElementById('watch-only').checked,
      speed: document.getElementById('speed').value,
      browserUserAgent: document.getElementById('browser-ua').value.trim(),
    });

    if (!response.success) {
      showError(response.error);
      isAutomationRunning = false;
      setUIState(isAutomationRunning);
      setStatus('Automation failed to start: ' + response.error, 'error');
    } else {
      setStatus('Automation is running...');
    }
  });

  // Give every course fresh tries without restarting
  retryBtn.addEventListener('click', async () => {
    const r = await window.electronAPI.retryNow();
    setStatus(r.success ? 'Will try again at the next free seat...' : 'Not running - press Start instead.');
  });

  // Stop the automation process
  stopBtn.addEventListener('click', async () => {
    await window.electronAPI.stopAutomation();
    isAutomationRunning = false;
    setUIState(isAutomationRunning);
    setStatus('Stopped by you.');
  });

  // Listen for status updates
  window.electronAPI.onStatusUpdate((event, message) => {
    const kind = /^WARNING|not found|refused|failed|safety limit/i.test(message) ? 'warn'
      : /Registered:|is OPEN|already registered/i.test(message) ? 'good' : 'info';
    setStatus(message, kind);
  });

  // Automation ended (finished, error or stopped): reset the buttons, keep the last message.
  window.electronAPI.onStopped(() => {
    isAutomationRunning = false;
    setUIState(isAutomationRunning);
    logLine('Automation stopped.');
  });

  // Listen for course registration updates
  window.electronAPI.onCourseRegistered((event, course) => {
    const li = document.createElement('li');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    li.textContent = `${course.courseCode} (Slot: ${course.courseSlot}) - Registered! `;
    const t = document.createElement('span'); t.className = 'timestamp'; t.textContent = timestamp; li.appendChild(t);
    registeredList.appendChild(li);
  });

  window.electronAPI.onCourseBlocked((event, course) => {
    const li = document.createElement('li');
    const timestamp = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
    li.textContent = `${course.courseCode} (Slot: ${course.courseSlot}) - Blocked! `;
    const t = document.createElement('span'); t.className = 'timestamp'; t.textContent = timestamp; li.appendChild(t);
    blockedList.appendChild(li);
  });

  // Listen for error messages
  window.electronAPI.onError((event, errorMessage) => {
    showError(errorMessage);
    isAutomationRunning = false;
    setUIState(isAutomationRunning);
    setStatus('Error: ' + errorMessage, 'error');
  });

  // ---------- Captcha prompt ----------
  const captchaModal = document.getElementById('captcha-modal');
  const captchaImg = document.getElementById('captcha-img');
  const captchaInput = document.getElementById('captcha-input');
  const captchaTitle = document.getElementById('captcha-title');
  const captchaTimer = document.getElementById('captcha-timer');
  let currentCaptchaId = null;
  let captchaCountdown = null;

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.25, 0.5].forEach(t => {
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.3, ctx.currentTime + t);
        o.start(ctx.currentTime + t); o.stop(ctx.currentTime + t + 0.15);
      });
    } catch (_) {}
  }

  function closeCaptcha() {
    captchaModal.classList.add('hidden');
    clearInterval(captchaCountdown);
    currentCaptchaId = null;
  }

  async function answerCaptcha(manual) {
    if (currentCaptchaId === null) return;
    const id = currentCaptchaId;
    const answer = captchaInput.value.trim();
    if (!manual && !answer) { captchaInput.focus(); return; }
    closeCaptcha();
    await window.electronAPI.sendCaptchaAnswer({ id, answer, manual });
  }

  window.electronAPI.onCaptchaRequest((event, data) => {
    currentCaptchaId = data.id;
    captchaTitle.textContent = `Captcha for ${data.courseCode} (try ${data.tryNo}/${data.maxTries})`;
    captchaImg.src = data.image;
    captchaInput.value = '';
    captchaModal.classList.remove('hidden');
    captchaInput.focus();
    beep();
    let left = Math.round(data.timeoutMs / 1000);
    captchaTimer.textContent = `${left}s left`;
    clearInterval(captchaCountdown);
    captchaCountdown = setInterval(() => {
      left--; captchaTimer.textContent = `${Math.max(left, 0)}s left`;
    }, 1000);
  });

  window.electronAPI.onCaptchaCancel((event, id) => {
    if (id === currentCaptchaId) closeCaptcha();
  });

  document.getElementById('captcha-submit').addEventListener('click', () => answerCaptcha(false));
  document.getElementById('captcha-manual').addEventListener('click', () => answerCaptcha(true));
  captchaInput.addEventListener('keydown', e => { if (e.key === 'Enter') answerCaptcha(false); });

  // JSON Input Modal Logic
  jsonInputBtn.addEventListener('click', () => {
    jsonInputModal.classList.remove('hidden');
    jsonInputModal.classList.add('modal-open');
    editor.refresh();
    if (jsonInputState.trim() === '') {
        editor.setValue(placeholder);
        editor.getWrapperElement().style.opacity = '0.5';
    } else {
        editor.setValue(jsonInputState);
    }
  });

  closeJsonBtn.addEventListener('click', () => {
    jsonInputModal.classList.add('modal-close');
    jsonInputModal.addEventListener('animationend', () => {
      jsonInputModal.classList.add('hidden');
      jsonInputModal.classList.remove('modal-close');
    }, { once: true });
  });

  resetJsonBtn.addEventListener('click', () => {
    editor.setValue(placeholder);
    editor.getWrapperElement().style.opacity = '0.5';
    jsonInputState = '';
  });

  saveJsonBtn.addEventListener('click', () => {
    clearError();
    const jsonText = editor.getValue();

    if (jsonText === placeholder || jsonText.trim() === '') {
      courseList.innerHTML = ''; // Clear existing courses
      jsonInputModal.classList.add('hidden');
      return;
    }

    try {
      const parsedCourses = JSON.parse(jsonText);
      if (!Array.isArray(parsedCourses)) {
        throw new Error('Input must be a JSON array.');
      }

      courseList.innerHTML = ''; // Clear existing courses
      parsedCourses.forEach(course => {
        if (course.code && course.slot) {
          addCourseRow(course.code, course.slot);
        }
      });

      jsonInputModal.classList.add('hidden');
    } catch (error) {
      showError(`Invalid JSON format: ${error.message}`);
    }
  });

  // Close modal on Escape key press
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !jsonInputModal.classList.contains('hidden')) {
      closeJsonBtn.click();
    }
  });

  // ================= Seat Monitor (new /register/ portal) =================
  const monitorCourseList = document.getElementById('monitor-course-list');
  const monitorAddBtn = document.getElementById('monitor-add-course');
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
    codeInput.placeholder = 'Course Code (e.g. HU426)';
    codeInput.value = code;
    const removeBtn = document.createElement('button');
    removeBtn.textContent = 'Remove';
    removeBtn.className = 'remove-course';
    removeBtn.addEventListener('click', () => { monitorCourseList.removeChild(row); saveMonitorCodes(); });
    codeInput.addEventListener('input', saveMonitorCodes);
    row.appendChild(codeInput);
    row.appendChild(removeBtn);
    monitorCourseList.appendChild(row);
  }

  function getMonitorCodes() {
    return [...monitorCourseList.querySelectorAll('input')]
      .map(i => i.value.trim().toUpperCase()).filter(Boolean);
  }

  function saveMonitorCodes() {
    try { localStorage.setItem('monitorCodes', JSON.stringify(getMonitorCodes())); } catch (_) {}
  }

  // Load saved codes, defaulting to the three HU courses the user asked about.
  (function loadMonitorCodes() {
    let codes = [];
    try { codes = JSON.parse(localStorage.getItem('monitorCodes') || 'null') || []; } catch (_) {}
    if (!codes.length) codes = ['HU426', 'HU308', 'HU404'];
    codes.forEach(c => addMonitorRow(c));
  })();

  monitorAddBtn.addEventListener('click', () => addMonitorRow());

  function setMonitorUI(running) {
    monitorRunning = running;
    monitorStartBtn.classList.toggle('hidden', running);
    monitorStopBtn.classList.toggle('hidden', !running);
    monitorAddBtn.disabled = running;
    monitorCourseList.querySelectorAll('input, button').forEach(el => { el.disabled = running; });
  }

  function setMonitorStatus(message, kind = 'info') {
    monitorStatus.textContent = message;
    monitorStatus.className = `status-${kind}`;
  }

  // A loud, repeating alarm for when a seat opens (separate from the captcha beep).
  let alarmCtx = null;
  function loudAlarm() {
    try {
      alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = alarmCtx;
      if (ctx.state === 'suspended') ctx.resume();
      // Oscillating two-tone siren for ~5 seconds.
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
    // Unlock audio so the alarm can play later (browsers need a user gesture).
    try { alarmCtx = alarmCtx || new (window.AudioContext || window.webkitAudioContext)(); if (alarmCtx.state === 'suspended') alarmCtx.resume(); } catch (_) {}
    const r = await window.electronAPI.startMonitor({ codes });
    if (r && r.success) { setMonitorUI(true); setMonitorStatus('Starting… a portal window is opening. Log in there and keep it open.'); }
    else { setMonitorStatus((r && r.error) || 'Could not start monitoring.', 'error'); }
  });

  monitorStopBtn.addEventListener('click', async () => {
    await window.electronAPI.stopMonitor();
    setMonitorUI(false);
  });

  window.electronAPI.onMonitorStatus((event, s) => {
    setMonitorStatus(s.message, s.type || 'info');
  });

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
      li.textContent = `${code}${s.name ? ' — ' + s.name : ''}: ${label}`;
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
    li.textContent = `🔔 SEAT OPEN: ${a.code}${a.name ? ' — ' + a.name : ''} — ${a.seats} left! Go click Add in the portal window.`;
    monitorStateList.prepend(li);
  });
});