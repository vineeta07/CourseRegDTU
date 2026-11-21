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
const BASE_URL = process.env.EXAMSETU_BASE_URL || `https://${BASE_HOST}`; // override only for local testing

const POLL_SPEEDS = { normal: 3000, fast: 2000 }; // how often the registration page is checked
const AFTER_POST_DELAY_MS = 1200;   // wait after a register request before checking it worked
const MAX_POSTS_PER_COURSE = 2;     // give up on a course after this many failed register attempts
const MAX_POSTS_PER_RUN = 15;       // hard cap on register + captcha submits in one run
const MAX_CAPTCHA_TRIES = 3;        // wrong-captcha retries per register attempt
const CAPTCHA_ANSWER_TIMEOUT_MS = 90000; // how long to wait for you to type the captcha
const MIN_GAP_MS = 1000;            // minimum gap between page loads
const MIN_GAP_REGISTER_MS = 250;    // a register click right after the page showed a free seat
const MAX_REQUESTS_PER_MINUTE = 40; // hard rate limit across all requests
const MAX_RELOGINS = 1;             // max automatic re-logins per run
const RELOGIN_BACKOFF_MS = [0];     // the one re-login happens at once
const MAX_CONSECUTIVE_ERRORS = 2;   // network/5xx errors in a row before the app stops (= 1 retry)
const ERROR_RETRY_WAIT_MS = 5000;   // wait before retrying after a network/5xx error

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

let isRunning = false;
let retryRequested = false; // set by the "Try again now" button
let userAgent = USER_AGENT;
let lastRequestAt = 0;
const recentRequests = [];

// The portal pushed back (bot check, rate limit, warning, block). The app stops at once.
class SuspendedError extends Error {}
class SessionExpiredError extends Error {}
class NotOpenError extends Error {}

// ---------------- Helpers ----------------
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function commonHeaders(extra = {}) {
  return {
    'User-Agent': userAgent,
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

// Rate limiter: keeps a minimum gap between requests and a per-minute cap,
// so the app never sends bursts no matter what the loop does.
async function throttle(minGap = MIN_GAP_MS) {
  for (;;) {
    const now = Date.now();
    while (recentRequests.length && now - recentRequests[0] > 60000) recentRequests.shift();
    const gapWait = lastRequestAt + minGap - now;
    const minuteWait = recentRequests.length >= MAX_REQUESTS_PER_MINUTE ? 60000 - (now - recentRequests[0]) + 50 : 0;
    const wait = Math.max(gapWait, minuteWait);
    if (wait <= 0) break;
    await delay(wait);
  }
  lastRequestAt = Date.now();
  recentRequests.push(lastRequestAt);
}

// Anything that looks like the server pushing back stops the run.
const WARNING_RE = /suspend|blocked due|too many|multiple (altering|attempts|requests)|unusual activity|suspicious|rate limit|try again later/i;

// Bot-protection / "security verification" pages. The portal is screening out automated
// tools, so the app must stop instead of retrying.
const BOT_CHECK_RE = /Performing security verification|verifies you are not a bot|protect against malicious bots|Checking your browser|Just a moment\.\.\.|challenge-platform|cf-challenge|cf-turnstile|ddos protection/i;

function checkPushback(response) {
  const raw = typeof response.body === 'string' ? response.body : '';
  if (BOT_CHECK_RE.test(raw) || response.headers['cf-mitigated']) {
    throw new SuspendedError(
      'The portal is showing a "security verification" (bot check) page. The app has stopped and will not ' +
      'continue, so your device is not flagged. Register by hand in your normal browser instead.'
    );
  }
  if (response.statusCode === 403 || response.statusCode === 429) {
    throw new SuspendedError(`Portal returned HTTP ${response.statusCode} (refused / too many requests). Stopping to protect your account. Wait a while before trying again.`);
  }
  const body = typeof response.body === 'string' ? response.body : '';
  const $ = body.length < 500000 ? cheerio.load(body) : null;
  const alertText = $ ? $('.alert, .swal2-content, .toast, .error, .flash').text().replace(/\s+/g, ' ').trim() : '';
  if (alertText && WARNING_RE.test(alertText)) {
    throw new SuspendedError(`Portal warning: "${alertText.slice(0, 200)}". Stopping to protect your account.`);
  }
}

async function request(url, options) {
  const { default: got } = await import('got');
  if (!isRunning) throw new Error('Stopped.');
  await throttle(options.minGap);
  delete options.minGap;
  const response = await got(url, {
    responseType: 'text',
    followRedirect: false,
    throwHttpErrors: false,
    timeout: { request: 20000 },
    retry: { limit: 0 },
    ...options,
  });
  checkSuspended(response);
  checkPushback(response);
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
  if (response.statusCode >= 300 && response.statusCode < 400) {
    // Logged in, but the portal sends us elsewhere (e.g. home page): registration not open.
    throw new NotOpenError(`Registration page redirects to ${response.headers.location || 'another page'}`);
  }
  if (response.statusCode >= 400 && response.statusCode < 500) {
    throw new Error(`Registration page returned HTTP ${response.statusCode}. Stopping to be safe.`);
  }
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
    const form = row.find("form[action*='/student/courseRegister/']").first();
    const action = form.attr('action');
    const courseHash = courseHashFromAction(action, studentHash);
    // Collect exactly the fields the browser would send (hidden inputs, CSRF tokens, ...).
    const fields = {};
    form.find('input[name], select[name], textarea[name]').each((_, el) => {
      const e = $(el);
      const type = (e.attr('type') || '').toLowerCase();
      if ((type === 'checkbox' || type === 'radio') && e.attr('checked') === undefined) return;
      if (type === 'submit' || type === 'button') return;
      fields[e.attr('name')] = e.attr('value') || '';
    });
    const submit = form.find('button, input[type=submit]').first();
    if (submit.attr('name')) fields[submit.attr('name')] = submit.attr('value') || '';
    const canSubmit = form.length > 0 &&
      submit.attr('disabled') === undefined && form.find('fieldset[disabled]').length === 0;
    const method = (form.attr('method') || 'GET').toUpperCase();
    const bg = (row.attr('bgcolor') || '').toLowerCase();
    const state = bg === '#0ff288' ? 'registered' : bg === '#d4d3d2' ? 'blocked' : 'open';

    if (courseCode) rows.push({ courseCode, courseSlot, seats, courseHash, state, action, method, fields, canSubmit });
  });

  const alert = $('div.alert.alert-danger').first().text().replace(/\s+/g, ' ').trim();
  return { rows, alert };
}

// Submits the course's form exactly as the page defines it (same action, method and fields).
async function sendRegister(session, row) {
  const url = new URL(row.action, `${BASE_URL}/student/courseRegistration/${session.studentHash}`).toString();
  if (!url.startsWith(BASE_URL + '/')) throw new Error('Form points outside the portal; refusing to submit.');
  const body = querystring.stringify(row.fields || {});
  const isGet = row.method === 'GET';
  const response = await request(isGet ? `${url}${body ? (url.includes('?') ? '&' : '?') + body : ''}` : url, {
    method: isGet ? 'GET' : 'POST',
    ...(isGet ? {} : { body }),
    minGap: MIN_GAP_REGISTER_MS,
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
  if (response.statusCode >= 400) throw new Error(`portal answered HTTP ${response.statusCode}`);
  response.requestUrl = url;
  return response;
}

// ---------------- Captcha (you type it, the app submits it) ----------------
const CAPTCHA_RE = /captcha|security.?code|verification.?code|verify.?code/i;

function looksCaptcha($, el) {
  const e = $(el);
  return CAPTCHA_RE.test([e.attr('name'), e.attr('id'), e.attr('placeholder'), e.attr('class'), e.attr('src'), e.attr('alt')].join(' '));
}

// Finds a captcha on a page. If formAction is given, only the form with that action is considered.
// Returns null (no captcha), { kind: 'widget' } (Google/hCaptcha style: needs the real page),
// { kind: 'unknown' } (mentions captcha but layout not understood), or a typed captcha form.
function findCaptcha(html, pageUrl, formAction) {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  if ($('.g-recaptcha, .h-captcha, .cf-turnstile, [data-sitekey], iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="turnstile"]').length) {
    return { kind: 'widget' };
  }
  let forms = $('form');
  if (formAction) forms = forms.filter((_, f) => $(f).attr('action') === formAction);

  let form = null, input = null;
  forms.each((_, f) => {
    if (form) return;
    const fi = $(f).find('input').filter((_, el) => {
      const t = ($(el).attr('type') || 'text').toLowerCase();
      return t !== 'hidden' && $(el).attr('name') && looksCaptcha($, el);
    }).first();
    if (fi.length) { form = $(f); input = fi; }
  });

  // Fallback: a captcha image on the page + a form with exactly one visible text box.
  if (!form && $('img').filter((_, el) => looksCaptcha($, el)).length) {
    forms.each((_, f) => {
      if (form) return;
      const texts = $(f).find('input[name]').filter((_, el) => ['text', ''].includes(($(el).attr('type') || '').toLowerCase()));
      if (texts.length === 1) { form = $(f); input = texts.first(); }
    });
  }

  if (!form) {
    if (formAction) return null;
    return /captcha/i.test($('body').text() + $('img').map((_, el) => $(el).attr('src')).get().join(' ')) ? { kind: 'unknown' } : null;
  }

  const fields = {};
  form.find('input[name], select[name], textarea[name]').each((_, el) => {
    const e = $(el);
    const type = (e.attr('type') || '').toLowerCase();
    if (e.attr('name') === input.attr('name')) return;
    if ((type === 'checkbox' || type === 'radio') && e.attr('checked') === undefined) return;
    if (type === 'submit' || type === 'button') return;
    fields[e.attr('name')] = e.attr('value') || '';
  });
  const submit = form.find('button[type=submit], input[type=submit], button:not([type])').first();
  if (submit.attr('name')) fields[submit.attr('name')] = submit.attr('value') || '';

  // The captcha picture: inside the form first, then anywhere on the page.
  let img = form.find('img').filter((_, el) => looksCaptcha($, el)).first();
  if (!img.length) img = $('img').filter((_, el) => looksCaptcha($, el)).first();
  if (!img.length) img = form.find('img').first();
  let svg = form.find('svg').first();
  if (!svg.length) svg = $('[id*="captcha" i] svg, [class*="captcha" i] svg').first();

  let image = null;
  if (img.length && img.attr('src')) image = { src: img.attr('src').startsWith('data:') ? img.attr('src') : new URL(img.attr('src'), pageUrl).toString() };
  else if (svg.length) image = { svg: $.html(svg) };

  return {
    kind: 'text',
    action: new URL(form.attr('action') || pageUrl, pageUrl).toString(),
    method: (form.attr('method') || 'GET').toUpperCase(),
    fields,
    answerField: input.attr('name'),
    image,
  };
}

// Downloads the captcha picture ONCE with your session (same as the browser loading it).
async function captchaImageDataUri(session, image, referer) {
  if (!image) return null;
  if (image.svg) return 'data:image/svg+xml;base64,' + Buffer.from(image.svg).toString('base64');
  if (image.src.startsWith('data:')) return image.src;
  if (!image.src.startsWith(BASE_URL + '/')) return null;
  const response = await request(image.src, {
    method: 'GET',
    responseType: 'buffer',
    minGap: MIN_GAP_REGISTER_MS,
    headers: commonHeaders({ 'Accept': 'image/avif,image/webp,image/svg+xml,image/*,*/*;q=0.8', 'Referer': referer, 'Cookie': session.cookies }),
  });
  session.cookies = mergeCookies(response.headers, session.cookies);
  const type = (response.headers['content-type'] || 'image/png').split(';')[0];
  return `data:${type};base64,${Buffer.from(response.body).toString('base64')}`;
}

async function submitCaptcha(session, captcha, answer, referer) {
  const body = querystring.stringify({ ...captcha.fields, [captcha.answerField]: answer });
  const isGet = captcha.method === 'GET';
  if (!captcha.action.startsWith(BASE_URL + '/')) throw new Error('Captcha form points outside the portal; refusing to submit.');
  const url = isGet ? `${captcha.action}${captcha.action.includes('?') ? '&' : '?'}${body}` : captcha.action;
  const response = await request(url, {
    method: isGet ? 'GET' : 'POST',
    ...(isGet ? {} : { body }),
    minGap: MIN_GAP_REGISTER_MS,
    headers: commonHeaders({
      'Content-Type': 'application/x-www-form-urlencoded',
      'Origin': BASE_URL,
      'Referer': referer,
      'Cookie': session.cookies,
    }),
  });
  session.cookies = mergeCookies(response.headers, session.cookies);
  if (response.statusCode >= 400) throw new Error(`portal answered HTTP ${response.statusCode}`);
  response.requestUrl = url;
  return response;
}

// After a submit: if the server redirects somewhere other than the registration page
// (e.g. to a captcha page), load that page once. Returns { html, url } or null.
async function followResult(session, response) {
  const regPath = `/student/courseRegistration/${session.studentHash}`;
  if (response.statusCode >= 300 && response.statusCode < 400) {
    const loc = response.headers.location || '';
    const next = new URL(loc, response.requestUrl || BASE_URL).toString();
    if (!next.startsWith(BASE_URL + '/') || next.includes(regPath)) return null;
    if (isLoginRedirect(response)) throw new SessionExpiredError('Session expired.');
    const page = await request(next, {
      method: 'GET',
      minGap: MIN_GAP_REGISTER_MS,
      headers: commonHeaders({ 'Referer': response.requestUrl, 'Cookie': session.cookies }),
    });
    session.cookies = mergeCookies(page.headers, session.cookies);
    if (isLoginRedirect(page)) throw new SessionExpiredError('Session expired.');
    return { html: page.body, url: next, getable: true };
  }
  if (response.statusCode === 200 && typeof response.body === 'string') {
    return { html: response.body, url: response.requestUrl, getable: false };
  }
  return null;
}

// Registers one course, handling a captcha if the portal asks for one.
async function attemptRegister(session, info, regHtml, ctx) {
  const { status, callbacks, countPost } = ctx;
  const regUrl = `${BASE_URL}/student/courseRegistration/${session.studentHash}`;

  // Case A: the captcha box is already part of the course's form on the registration page.
  let captcha = findCaptcha(regHtml, regUrl, info.row.action);
  let pageUrl = regUrl;
  let manualUrl = regUrl; // a page we can open in a window (POST results can't be reopened)

  if (!captcha) {
    // Case B: click Register; the portal may answer with a captcha page.
    countPost();
    const response = await sendRegister(session, info.row);
    status(`Register request for ${info.courseCode} sent (HTTP ${response.statusCode}).`);
    const page = await followResult(session, response);
    if (!page) return;
    captcha = findCaptcha(page.html, page.url);
    pageUrl = page.url;
    if (page.getable) manualUrl = page.url;
    if (!captcha) return;
  }

  for (let tryNo = 1; tryNo <= MAX_CAPTCHA_TRIES && isRunning; tryNo++) {
    if (captcha.kind !== 'text' || !captcha.image) {
      await manualSolve(session, info, manualUrl, ctx,
        captcha.kind === 'widget' ? 'This captcha needs the real page.' : 'Could not read the captcha automatically.');
      return;
    }
    const image = await captchaImageDataUri(session, captcha.image, pageUrl);
    if (!image) { await manualSolve(session, info, manualUrl, ctx, 'Could not load the captcha picture.'); return; }

    status(`CAPTCHA for ${info.courseCode}! Type it in the app now (try ${tryNo}/${MAX_CAPTCHA_TRIES}).`);
    const reply = await callbacks.askCaptcha({ courseCode: info.courseCode, image, tryNo, maxTries: MAX_CAPTCHA_TRIES, timeoutMs: CAPTCHA_ANSWER_TIMEOUT_MS });
    if (!isRunning) return;
    if (reply && reply.manual) { await manualSolve(session, info, manualUrl, ctx, 'You chose to solve it on the page.'); return; }
    if (!reply || !reply.answer) { status(`No captcha answer for ${info.courseCode}. Going back to watching.`); return; }

    countPost();
    const response = await submitCaptcha(session, captcha, reply.answer, pageUrl);
    status(`Captcha submitted for ${info.courseCode} (HTTP ${response.statusCode}). Verifying...`);
    const page = await followResult(session, response);
    const again = page && findCaptcha(page.html, page.url);
    if (!again) return; // accepted (or back on the registration page); the main loop verifies
    status(`Captcha for ${info.courseCode} was not accepted. New captcha...`);
    captcha = again; pageUrl = page.url;
    if (page.getable) manualUrl = page.url;
  }
}

// Opens the real portal page (already logged in with your session) so you can finish by hand.
async function manualSolve(session, info, url, ctx, reason) {
  const { status, callbacks } = ctx;
  if (!callbacks.openManualWindow) { status(`${reason} Open the portal and register ${info.courseCode} yourself.`); return; }
  status(`${reason} Opening the portal page for ${info.courseCode}: solve the captcha and click Verify/Register, then close that window.`);
  const cookies = await callbacks.openManualWindow({ url, cookies: session.cookies, userAgent, courseCode: info.courseCode });
  if (cookies) session.cookies = cookies;
  status('Portal window closed. Checking if the course got registered...');
}

// ---------------- Main ----------------
async function startAutomation(options, callbacks) {
  const { credentials, courses, autoLogin, manualCookie, manualStudentId, sessionFile, watchOnly, browserUserAgent, speed } = options;
  const POLL_INTERVAL_MS = POLL_SPEEDS[speed] || POLL_SPEEDS.normal;
  let lastHtml = '';
  let lastAttempted = null;
  const rollNo = credentials && credentials.r;
  isRunning = true;
  let reloginCount = 0;
  let postsThisRun = 0;
  // If you paste your own browser's User-Agent, requests made with that browser's
  // cookie look the same as the browser that created the session.
  userAgent = (browserUserAgent && browserUserAgent.trim()) || USER_AGENT;

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
    status(wait ? `Session expired. Waiting ${Math.round(wait / 1000)}s before re-login (${reloginCount}/${MAX_RELOGINS})...`
                : `Session expired. Logging in again now (${reloginCount}/${MAX_RELOGINS})...`);
    if (wait) await delay(wait);
    if (!isRunning) throw new Error('Stopped.');
    const s = await obtainSession(true);
    return { ...s, source: 'relogin' };
  }

  try {
    let session = await obtainSession(false);

    const wanted = courses.map(c => {
      const [code, slot] = c.split(':').map(x => x.trim());
      return { code, slot };
    });
    const tracked = new Map(); // courseHash -> info
    let savedManual = false;
    let waitingSince = null;

    // Load the page until the course list is there. If registration isn't open yet,
    // keep waiting (at the normal checking speed) instead of giving up.
    while (isRunning) {
      let html;
      try {
        html = await fetchRegistrationPage(session);
      } catch (e) {
        if (e instanceof SessionExpiredError) { session = await relogin(session); continue; }
        if (e instanceof NotOpenError) {
          if (!waitingSince) waitingSince = Date.now();
          status(`Registration is not open yet (${e.message}). Waiting for it to open... ` +
            `last checked ${new Date().toLocaleTimeString()}`);
          await delay(POLL_INTERVAL_MS);
          continue;
        }
        throw e;
      }
      if (session.source === 'manual' && !savedManual) {
        saveSession(sessionFile, rollNo || 'manual', session);
        savedManual = true;
      }

      const { rows } = parseCourses(html, session.studentHash);
      if (rows.length === 0) {
        if (!waitingSince) waitingSince = Date.now();
        status(`Logged in OK, but there is no course list on the page (registration is probably closed). ` +
          `Waiting for it to open... last checked ${new Date().toLocaleTimeString()}`);
        await delay(POLL_INTERVAL_MS);
        continue;
      }
      if (waitingSince) status('Registration is OPEN - course list found!');

      lastHtml = html;
      const missing = [];
      for (const w of wanted) {
        const row = rows.find(r => r.courseCode === w.code && (!w.slot || r.courseSlot === w.slot || (r.courseSlot || '').includes(w.slot)));
        if (!row || !row.courseHash) { missing.push(`${w.code} (${w.slot})`); continue; }
        if (row.state === 'registered') { callbacks.onCourseRegistered({ courseCode: row.courseCode, courseSlot: w.slot }); status(`${row.courseCode} is already registered.`); continue; }
        if (row.state === 'blocked') { callbacks.onCourseBlocked({ courseCode: row.courseCode, courseSlot: w.slot }); status(`${row.courseCode} is blocked for you on the portal.`); continue; }
        tracked.set(row.courseHash, { courseCode: row.courseCode, courseSlot: w.slot, seats: row.seats, posts: 0, row, lastFailedSeats: null });
      }
      if (missing.length) {
        status(`WARNING - not found on the page, check the code and slot: ${missing.join(', ')}. ` +
          `Courses on the page include: ${rows.slice(0, 8).map(r => `${r.courseCode} (${r.courseSlot})`).join(', ')}${rows.length > 8 ? ', ...' : ''}`);
      }
      break;
    }
    if (!isRunning) return;
    if (tracked.size === 0) {
      status('None of your courses can be registered (all already registered, blocked or not found). Stopping.');
      return;
    }

    status(`${watchOnly ? '[WATCH ONLY - nothing will be submitted] ' : ''}Tracking ${tracked.size} course(s): ` +
      `${Array.from(tracked.values()).map(i => `${i.courseCode}(${i.seats} seats)`).join(', ')}. Checking every ${POLL_INTERVAL_MS / 1000}s...`);
    let consecutiveErrors = 0;

    const dropped = new Map(); // courses given up on after refusals (can be retried)

    while (isRunning && (tracked.size > 0 || (retryRequested && dropped.size > 0))) {
      // "Try again now": give every course fresh tries, including ones given up on.
      if (retryRequested) {
        retryRequested = false;
        for (const [hash, info] of dropped) tracked.set(hash, info);
        dropped.clear();
        for (const info of tracked.values()) { info.posts = 0; info.lastFailedSeats = null; }
        status(`Trying again: ${Array.from(tracked.values()).map(i => i.courseCode).join(', ')} - each gets fresh tries at the next free seat.`);
      }
      let page;
      try {
        lastHtml = await fetchRegistrationPage(session);
        page = parseCourses(lastHtml, session.studentHash);
        consecutiveErrors = 0;
      } catch (e) {
        if (e instanceof SuspendedError) throw e;
        if (e instanceof SessionExpiredError) { session = await relogin(session); continue; }
        if (e instanceof NotOpenError) {
          throw new Error(`The registration page suddenly redirects elsewhere (${e.message}). Stopping to be safe. Check the portal by hand.`);
        }
        consecutiveErrors++;
        if (!e.statusCode && !/timeout|ECONN|ENOTFOUND|EAI_AGAIN|socket|network/i.test(e.message)) throw e;
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`${consecutiveErrors} failed requests in a row (${e.message}). Stopping to be safe. Check the portal by hand.`);
        }
        status(`Request failed (${e.message}). Retrying once in ${ERROR_RETRY_WAIT_MS / 1000}s (${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS - 1})...`);
        await delay(ERROR_RETRY_WAIT_MS);
        continue;
      }
      if (page.rows.length === 0) {
        throw new Error('The course list disappeared from the page (registration closed or the page changed). Stopping to be safe.');
      }

      if (page.alert) status(`Portal says: ${page.alert}`);
      // Wrong captcha that sent us back to the list: allow another try (not counted as a refusal).
      if (page.alert && /captcha/i.test(page.alert) && lastAttempted && tracked.has(lastAttempted)) {
        const info = tracked.get(lastAttempted);
        info.lastFailedSeats = null;
        info.posts = Math.max(0, info.posts - 1);
      }
      lastAttempted = null;

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
        info.row = row;
        if (row.seats !== info.seats) {
          status(`Seats ${info.courseCode}: ${info.seats} -> ${row.seats}`);
          info.seats = row.seats;
        }
      }
      // Your list order decides priority when several courses have seats.
      // After a failed attempt, a course is only retried once its seat count changes,
      // so the same refused request is never repeated.
      for (const [hash, info] of tracked) {
        if (info.seats > 0 && info.row.canSubmit && info.lastFailedSeats !== info.seats) { target = hash; break; }
      }

      if (target && watchOnly) {
        const info = tracked.get(target);
        const cap = findCaptcha(lastHtml, `${BASE_URL}/student/courseRegistration/${session.studentHash}`, info.row.action);
        status(`[WATCH ONLY] ${info.courseCode} has ${info.seats} seat(s) and would be registered now` +
          (cap ? ` (captcha detected on the page: ${cap.kind === 'text' ? 'you will be asked to type it' : 'portal window will open'}).` : '.'));
        info.lastFailedSeats = info.seats; // report once per seat change
        target = null;
      }

      if (target) {
        const info = tracked.get(target);
        if (info.posts >= MAX_POSTS_PER_COURSE) {
          tracked.delete(target);
          dropped.set(target, info);
          callbacks.onCourseBlocked(info);
          status(`${info.courseCode}: server refused ${MAX_POSTS_PER_COURSE} times (clash/ineligible?). Paused this course - press "Try again now" to retry it.`);
          continue;
        }
        info.posts++;
        info.lastFailedSeats = info.seats; // cleared implicitly if the next page shows it registered
        status(`Seat open! Registering ${info.courseCode} (attempt ${info.posts}/${MAX_POSTS_PER_COURSE})...`);
        try {
          lastAttempted = target;
          await attemptRegister(session, info, lastHtml, {
            status,
            callbacks,
            countPost: () => {
              if (postsThisRun >= MAX_POSTS_PER_RUN) {
                throw new Error(`Reached the safety limit of ${MAX_POSTS_PER_RUN} submits in one run. Stopping. Check the portal manually.`);
              }
              postsThisRun++;
            },
          });
        } catch (e) {
          if (e instanceof SuspendedError) throw e;
          if (e instanceof SessionExpiredError) { session = await relogin(session); continue; }
          throw new Error(`Register request for ${info.courseCode} failed (${e.message}). Stopping to be safe. Check the portal by hand.`);
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

function retryNow() {
  if (isRunning) retryRequested = true;
  return isRunning;
}

function stopAutomation() {
  isRunning = false;
}

module.exports = { startAutomation, stopAutomation, retryNow };
