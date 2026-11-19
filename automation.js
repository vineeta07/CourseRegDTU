// automation.js
//
// Course registration helper for DTU ExamSetu (exam-setu.dtu.ac.in).
//
// Design goals (to avoid tripping the portal's "multiple altering requests" block):
//   * Log in as few times as possible: reuse a saved session (cookies + student id)
//     across runs, or use a session cookie copied from your own browser.
//   * Never loop on login. Re-login is capped and backed off.
//   * Send each register (POST) request at most a few times per course, and only
//     when the page actually shows free seats. Stop retrying a course that keeps failing.
//   * Stop immediately if the portal shows the "Access Suspended" page.

const fs = require('fs');
const querystring = require('querystring');
const cheerio = require('cheerio');

// ---------------- Configuration ----------------
const BASE_HOST = 'exam-setu.dtu.ac.in';
const BASE_URL = `https://${BASE_HOST}`;

const POLL_INTERVAL_MS = 2000;      // how often the registration page is checked
const AFTER_POST_DELAY_MS = 2500;   // wait after a register request before re-checking
const MAX_POSTS_PER_COURSE = 3;     // give up on a course after this many failed register attempts
const MAX_RELOGINS = 3;             // max automatic re-logins per run
const RELOGIN_BACKOFF_MS = [15000, 45000, 120000];
const MAX_CONSECUTIVE_ERRORS = 10;  // network/5xx errors in a row before slowing down

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let isRunning = false;

class SuspendedError extends Error {}
class SessionExpiredError extends Error {}

// ---------------- Helpers ----------------
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function commonHeaders(extra = {}) {
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
    ...extra,
  };
}

function mergeCookies(headers, currentCookies) {
  const setCookies = headers['set-cookie'];
  if (!setCookies) return currentCookies || '';
  const map = new Map();
  (currentCookies || '').split(';').map(s => s.trim()).filter(Boolean).forEach(c => {
    const i = c.indexOf('=');
    if (i > 0) map.set(c.slice(0, i), c.slice(i + 1));
  });
  setCookies.forEach(raw => {
    const c = raw.split(';')[0];
    const i = c.indexOf('=');
    if (i > 0) map.set(c.slice(0, i), c.slice(i + 1));
  });
  return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Detects the "DEVICE ACCESS SUSPENDED" page or a redirect to it.
function checkSuspended(response) {
  const location = response.headers.location || '';
  const body = typeof response.body === 'string' ? response.body : '';
  if (
    location.includes('/department/login') ||
    /DEVICE ACCESS SUSPENDED|Access Suspended/i.test(body)
  ) {
    const ref = body.match(/Unique Reference Identifier[\s\S]{0,200}?([A-Z0-9]{8})/);
    throw new SuspendedError(
      'The portal has suspended access for this device. Stopping now. ' +
      'Visit the Examination Department with your ID card' +
      (ref ? ` and reference code ${ref[1]}` : '') + ' to get it unblocked.'
    );
  }
}

function isLoginRedirect(response) {
  const location = response.headers.location || '';
  if (response.statusCode >= 300 && response.statusCode < 400 && /\/student\/login|^\/$|\/login/.test(location)) {
    return true;
  }
  const body = typeof response.body === 'string' ? response.body : '';
  return body.length < 18000 && /Redirecting to \/student\/login/.test(body);
}

async function request(url, options) {
  const { default: got } = await import('got');
  const response = await got(url, {
    responseType: 'text',
    followRedirect: false,
    throwHttpErrors: false,
    timeout: { request: 20000 },
    retry: { limit: 0 },
    ...options,
  });
  checkSuspended(response);
  return response;
}

// ---------------- Session persistence ----------------
function loadSavedSession(sessionFile, rollNo) {
  try {
    if (!sessionFile || !fs.existsSync(sessionFile)) return null;
    const data = JSON.parse(fs.readFileSync(sessionFile, 'utf8'));
    if (data && data.cookies && data.studentHash && (!rollNo || data.rollNo === rollNo)) return data;
  } catch (_) { /* ignore corrupt file */ }
  return null;
}

function saveSession(sessionFile, rollNo, session) {
  if (!sessionFile) return;
  try {
    fs.writeFileSync(
      sessionFile,
      JSON.stringify({ rollNo, cookies: session.cookies, studentHash: session.studentHash, savedAt: Date.now() }),
      { mode: 0o600 }
    );
  } catch (e) {
    console.warn('Could not save session:', e.message);
  }
}

function clearSavedSession(sessionFile) {
  try { if (sessionFile && fs.existsSync(sessionFile)) fs.unlinkSync(sessionFile); } catch (_) {}
}

// ---------------- Login ----------------
async function login({ r, p }) {
  let cookies = '';

  // Get initial cookies (connect.sid etc.)
  let response = await request(`${BASE_URL}/student/login`, { method: 'GET', headers: commonHeaders() });
  cookies = mergeCookies(response.headers, cookies);

  response = await request(`${BASE_URL}/student/login`, {
    method: 'POST',
    body: querystring.stringify({ roll_no: r, password: p }),
    headers: commonHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/student/login`,
      'Cookie': cookies,
    }),
  });
  cookies = mergeCookies(response.headers, cookies);

  const haystack = `${response.headers.location || ''}\n${response.body || ''}`;
  const match = haystack.match(/\/student\/home\/([a-zA-Z0-9]+)/);
  if (match) return { cookies, studentHash: match[1] };

  if (/Invalid Roll No or Password/i.test(response.body || '')) {
    throw new Error('Invalid Roll Number or Password.');
  }
  throw new Error(`Login failed (HTTP ${response.statusCode}). Could not find student id in the response.`);
}

// ---------------- Registration page ----------------
async function fetchRegistrationPage(session) {
  const response = await request(`${BASE_URL}/student/courseRegistration/${session.studentHash}`, {
    method: 'GET',
    headers: commonHeaders({
      'Referer': `${BASE_URL}/student/home/${session.studentHash}`,
      'Cookie': session.cookies,
    }),
  });
  session.cookies = mergeCookies(response.headers, session.cookies);

  if (isLoginRedirect(response)) throw new SessionExpiredError('Session expired.');
  if (response.statusCode !== 200) {
    const err = new Error(`Registration page returned HTTP ${response.statusCode}`);
    err.statusCode = response.statusCode;
    throw err;
  }
  return response.body;
}

function courseHashFromAction(action, studentHash) {
  if (!action) return null;
  const m = action.match(new RegExp(`/student/courseRegister/${studentHash}/([a-zA-Z0-9]+)`)) ||
            action.match(/\/student\/courseRegister\/[a-zA-Z0-9]+\/([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

// Parses the page into rows: { courseCode, courseSlot, seats, courseHash, state }
function parseCourses(html, studentHash) {
  const $ = cheerio.load(html);
  const rows = [];
  let currentSlot = null;

  $('tr').each((_, tr) => {
    const row = $(tr);
    if (row.hasClass('setHeader')) {
      currentSlot = row.text().replace(/\s+/g, ' ').trim();
      return;
    }
    const cells = row.find('td');
    if (cells.length < 6) return;

    const courseCode = $(cells[1]).text().trim();
    const courseSlot = $(cells[3]).text().trim() || currentSlot;
    const seats = parseInt($(cells[4]).text().trim(), 10) || 0;
    const action = row.find("form[action*='/student/courseRegister/']").attr('action');
    const courseHash = courseHashFromAction(action, studentHash);
    const bg = (row.attr('bgcolor') || '').toLowerCase();
    const state = bg === '#0ff288' ? 'registered' : bg === '#d4d3d2' ? 'blocked' : 'open';

    if (courseCode) rows.push({ courseCode, courseSlot, seats, courseHash, state });
  });

  const alert = $('div.alert.alert-danger').first().text().replace(/\s+/g, ' ').trim();
  return { rows, alert };
}

async function sendRegister(session, courseHash) {
  const response = await request(`${BASE_URL}/student/courseRegister/${session.studentHash}/${courseHash}`, {
    method: 'POST',
    body: '',
    headers: commonHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE_URL,
      'Referer': `${BASE_URL}/student/courseRegistration/${session.studentHash}`,
      'Cookie': session.cookies,
    }),
  });
  session.cookies = mergeCookies(response.headers, session.cookies);
  if (isLoginRedirect(response) && !/courseRegistration/.test(response.headers.location || '')) {
    throw new SessionExpiredError('Session expired.');
  }
  return response.statusCode;
}

// ---------------- Main ----------------
async function startAutomation(options, callbacks) {
  const { credentials, courses, autoLogin, manualCookie, manualStudentId, sessionFile } = options;
  const rollNo = credentials && credentials.r;
  isRunning = true;
  let reloginCount = 0;

  const status = msg => { console.log(msg); callbacks.onStatusUpdate(msg); };

  // Get a session without logging in if at all possible.
  async function obtainSession(forceLogin = false) {
    if (!forceLogin) {
      if (manualCookie && manualStudentId) {
        status('Using session cookie from your browser (no login).');
        return { cookies: manualCookie, studentHash: manualStudentId, source: 'manual' };
      }
      const saved = loadSavedSession(sessionFile, rollNo);
      if (saved) {
        status('Reusing saved session (no login).');
        return { cookies: saved.cookies, studentHash: saved.studentHash, source: 'saved' };
      }
    }
    if (!rollNo || !credentials.p) {
      throw new Error('Session is not valid and no roll number/password given. Paste a fresh cookie or enter credentials.');
    }
    status('Logging in...');
    const s = await login(credentials);
    saveSession(sessionFile, rollNo, s);
    status('Login successful. Session saved for reuse.');
    return { ...s, source: 'login' };
  }

  async function relogin(session) {
    if (session.source === 'manual' && !(autoLogin && rollNo && credentials.p)) {
      throw new Error('Your browser session cookie has expired. Log in on the website, copy the new cookie, and start again.');
    }
    if (session.source !== 'login' && session.source !== 'relogin') {
      // Saved/manual session went stale: one fresh login is expected, not counted as a retry.
      clearSavedSession(sessionFile);
      const s = await obtainSession(true);
      return { ...s, source: 'relogin' };
    }
    if (!autoLogin) throw new Error('Session expired. Enable "Auto Login" or start again.');
    if (reloginCount >= MAX_RELOGINS) {
      throw new Error(`Session expired ${MAX_RELOGINS} times. Stopping to avoid getting blocked.`);
    }
    const wait = RELOGIN_BACKOFF_MS[Math.min(reloginCount, RELOGIN_BACKOFF_MS.length - 1)];
    reloginCount++;
    status(`Session expired. Waiting ${Math.round(wait / 1000)}s before re-login (${reloginCount}/${MAX_RELOGINS})...`);
    await delay(wait);
    if (!isRunning) throw new Error('Stopped.');
    const s = await obtainSession(true);
    return { ...s, source: 'relogin' };
  }

  try {
    let session = await obtainSession(false);

    // Initial page load; if saved/manual session is stale, log in exactly once.
    let html;
    try {
      html = await fetchRegistrationPage(session);
    } catch (e) {
      if (!(e instanceof SessionExpiredError)) throw e;
      session = await relogin(session);
      html = await fetchRegistrationPage(session);
    }
    if (session.source === 'manual') {
      saveSession(sessionFile, rollNo || 'manual', session);
    }

    // Build the tracked list.
    const wanted = courses.map(c => {
      const [code, slot] = c.split(':').map(s => s.trim());
      return { code, slot };
    });
    const { rows } = parseCourses(html, session.studentHash);
    const tracked = new Map(); // courseHash -> info
    const missing = [];

    for (const w of wanted) {
      const row = rows.find(r => r.courseCode === w.code && (!w.slot || r.courseSlot === w.slot || (r.courseSlot || '').includes(w.slot)));
      if (!row || !row.courseHash) { missing.push(`${w.code}:${w.slot}`); continue; }
      if (row.state === 'registered') { callbacks.onCourseRegistered({ courseCode: row.courseCode, courseSlot: w.slot }); continue; }
      if (row.state === 'blocked') { callbacks.onCourseBlocked({ courseCode: row.courseCode, courseSlot: w.slot }); continue; }
      tracked.set(row.courseHash, { courseCode: row.courseCode, courseSlot: w.slot, seats: row.seats, posts: 0 });
    }

    if (missing.length) status(`Not found on page (check code/slot): ${missing.join(', ')}`);
    if (tracked.size === 0) {
      status('Nothing left to register.');
      return;
    }

    status(`Tracking ${tracked.size} course(s). Checking every ${POLL_INTERVAL_MS / 1000}s...`);
    let consecutiveErrors = 0;

    while (isRunning && tracked.size > 0) {
      let page;
      try {
        page = parseCourses(await fetchRegistrationPage(session), session.studentHash);
        consecutiveErrors = 0;
      } catch (e) {
        if (e instanceof SuspendedError) throw e;
        if (e instanceof SessionExpiredError) { session = await relogin(session); continue; }
        consecutiveErrors++;
        const wait = consecutiveErrors >= MAX_CONSECUTIVE_ERRORS ? 30000 : POLL_INTERVAL_MS * 2;
        status(`Request failed (${e.message}). Retrying in ${wait / 1000}s...`);
        await delay(wait);
        continue;
      }

      if (page.alert) status(`Portal says: ${page.alert}`);

      // Update state of tracked courses.
      let target = null;
      for (const row of page.rows) {
        const info = row.courseHash && tracked.get(row.courseHash);
        if (!info) continue;
        if (row.state === 'registered') {
          tracked.delete(row.courseHash);
          callbacks.onCourseRegistered(info);
          status(`Registered: ${info.courseCode}`);
          continue;
        }
        if (row.state === 'blocked') {
          tracked.delete(row.courseHash);
          callbacks.onCourseBlocked(info);
          status(`Blocked: ${info.courseCode} - dropped.`);
          continue;
        }
        if (row.seats !== info.seats) {
          status(`Seats ${info.courseCode}: ${info.seats} -> ${row.seats}`);
          info.seats = row.seats;
        }
      }
      // Your list order decides priority when several courses have seats.
      for (const [hash, info] of tracked) {
        if (info.seats > 0) { target = hash; break; }
      }

      if (target) {
        const info = tracked.get(target);
        if (info.posts >= MAX_POSTS_PER_COURSE) {
          tracked.delete(target);
          callbacks.onCourseBlocked(info);
          status(`${info.courseCode}: server refused ${MAX_POSTS_PER_COURSE} times (clash/ineligible?). Dropped so the account isn't flagged.`);
          continue;
        }
        info.posts++;
        status(`Seat open! Registering ${info.courseCode} (attempt ${info.posts}/${MAX_POSTS_PER_COURSE})...`);
        try {
          const code = await sendRegister(session, target);
          status(`Register request for ${info.courseCode} sent (HTTP ${code}). Verifying...`);
        } catch (e) {
          if (e instanceof SuspendedError) throw e;
          if (e instanceof SessionExpiredError) { session = await relogin(session); continue; }
          status(`Register request failed: ${e.message}`);
        }
        await delay(AFTER_POST_DELAY_MS);
        continue;
      }

      await delay(POLL_INTERVAL_MS);
    }

    if (tracked.size === 0) status('All tracked courses handled. Stopping.');
  } catch (error) {
    if (error instanceof SuspendedError) clearSavedSession(sessionFile);
    callbacks.onError(error.message);
  } finally {
    isRunning = false;
    if (callbacks.onStop) callbacks.onStop();
  }
}

function stopAutomation() {
  isRunning = false;
}

module.exports = { startAutomation, stopAutomation };
