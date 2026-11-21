// selftest/run.js
//
// Checks that the app's logic works, WITHOUT touching the real portal.
// It starts a fake ExamSetu portal on your own computer (127.0.0.1) and runs the real
// automation code against it in many situations, then prints PASS / FAIL for each.
//
// Run:  npm run selftest

const http = require('http');

// The app logs every message to the console; keep the test output clean.
const say = (...a) => process.stdout.write(a.join(' ') + '\n');
console.log = () => {};
console.warn = () => {};

const SH = '66b0f2321af8ca2e2591dc58';
const HASH = { A: 'a'.repeat(24), B: 'b'.repeat(24) };

// ---------- Fake portal ----------
let sc = null; // current scenario state

function resetPortal(opts) {
  sc = {
    opts,
    gets: 0,
    seats: { A: 0, B: 0 },
    registered: {},
    alert: '',
    log: [],          // every request the "portal" received
    times: [],        // request timestamps
    captcha: 'X7K9',
  };
}

function courseRow(code, key, slot) {
  const reg = sc.registered[key];
  const inlineCaptcha = sc.opts.captcha === 'inline'
    ? '<img src="/captcha.png"><input name="captcha" type="text">' : '';
  return `<tr ${reg ? 'bgcolor="#0ff288"' : ''}><td>1</td><td>${code}</td><td>Course ${code}</td><td>${slot}</td>` +
    `<td>${sc.seats[key]}</td><td><form method="POST" action="/student/courseRegister/${SH}/${HASH[key]}">` +
    `<input type="hidden" name="_csrf" value="tok">${inlineCaptcha}<button>Register</button></form></td></tr>`;
}

function registrationPage() {
  const alert = sc.alert ? `<div class="alert alert-danger" role="alert">${sc.alert}</div>` : '';
  sc.alert = '';
  return `<html><body>${alert}<div class="elective-subjects table-responsive"><table class="table-hover table-bordered"><tbody>` +
    `<tr class="setHeader"><td colspan="3">E1</td></tr>${courseRow('CS301', 'A', 'E1')}` +
    `<tr class="setHeader"><td colspan="3">E2</td></tr>${courseRow('HU317', 'B', 'E2')}` +
    `</tbody></table></div></body></html>`;
}

const CAPTCHA_PAGE = `<h3>Verify</h3><form method="POST" action="/student/verifyRegister">` +
  `<input type="hidden" name="course" value="x"><img src="/captcha.svg" alt="captcha">` +
  `<input type="text" name="captchaInput" placeholder="Enter captcha"><button type="submit">Verify and Register</button></form>`;
const RECAPTCHA_PAGE = `<form method="POST" action="/verify"><div class="g-recaptcha" data-sitekey="k"></div></form>`;

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', d => { body += d; });
  req.on('end', () => {
    sc.times.push(Date.now());
    const path = req.url.split('?')[0];
    sc.log.push(`${req.method} ${path}${body ? ' [' + body + ']' : ''}`);
    const o = sc.opts;

    if (path.startsWith('/captcha')) { res.setHeader('content-type', 'image/png'); return res.end(Buffer.from('PNG')); }

    if (path.startsWith('/student/courseRegistration')) {
      sc.gets++;
      if (o.sessionExpired) { res.writeHead(302, { location: '/student/login' }); return res.end(); }
      if (o.closedFor && sc.gets <= o.closedFor) return res.end('<h2>Course registration is closed</h2>');
      if (o.botCheckAt && sc.gets >= o.botCheckAt) { res.writeHead(403); return res.end('<title>Just a moment...</title><h1>exam-setu.dtu.ac.in</h1><p>Performing security verification</p><p>This website uses a security service to protect against malicious bots.</p>'); }
      if (o.suspendAt && sc.gets >= o.suspendAt) return res.end('<h1>DEVICE ACCESS SUSPENDED</h1> Unique Reference Identifier <b>PHMCWSZX</b>');
      if (o.warnAt && sc.gets >= o.warnAt) sc.alert = 'Too many requests, try again later';
      if (o.http429At && sc.gets >= o.http429At) { res.writeHead(429); return res.end('slow down'); }
      if (sc.gets === (o.seatsAt || 3)) { sc.seats.A = o.seatsA ?? 1; sc.seats.B = o.seatsB ?? 0; }
      return res.end(registrationPage());
    }

    if (path.startsWith('/student/courseRegister')) {
      const key = path.endsWith(HASH.A) ? 'A' : 'B';
      if (o.captcha === 'inline') {
        if (body.includes('captcha=' + sc.captcha)) sc.registered[key] = true; else sc.alert = 'Invalid captcha';
        res.writeHead(302, { location: `/student/courseRegistration/${SH}` }); return res.end();
      }
      if (o.captcha === 'page' || o.captcha === 'recaptcha') { res.writeHead(302, { location: '/student/captchaPage' }); return res.end(); }
      if (!o.refuse) sc.registered[key] = true; else sc.alert = 'Slot clash with registered course';
      res.writeHead(302, { location: `/student/courseRegistration/${SH}` }); return res.end();
    }

    if (path.startsWith('/student/captchaPage')) return res.end(o.captcha === 'recaptcha' ? RECAPTCHA_PAGE : CAPTCHA_PAGE);

    if (path.startsWith('/student/verifyRegister')) {
      if (body.includes('captchaInput=' + sc.captcha)) {
        sc.registered.A = true;
        res.writeHead(302, { location: `/student/courseRegistration/${SH}` }); return res.end();
      }
      return res.end(CAPTCHA_PAGE);
    }
    res.writeHead(404); res.end('');
  });
});

// ---------- Runner ----------
let automation;

async function run(name, opts, runOpts, check) {
  resetPortal(opts);
  // Fresh copy of the app for each check (so the per-minute limit starts from zero, like a new run).
  delete require.cache[require.resolve('../automation.js')];
  automation = require('../automation.js');
  const out = { status: [], registered: [], blocked: [], errors: [], captchaAsks: 0, manualWindows: 0 };
  const stopTimer = setTimeout(() => automation.stopAutomation(), runOpts.maxMs || 20000);
  await automation.startAutomation({
    credentials: {},
    courses: runOpts.courses || ['CS301:E1'],
    manualCookie: 'connect.sid=test',
    manualStudentId: SH,
    speed: 'fast',
    watchOnly: !!runOpts.watchOnly,
  }, {
    onStatusUpdate: m => out.status.push(m),
    onCourseRegistered: c => out.registered.push(c.courseCode),
    onCourseBlocked: c => out.blocked.push(c.courseCode),
    onError: e => out.errors.push(e),
    onStop: () => {},
    askCaptcha: async () => { out.captchaAsks++; return { answer: out.captchaAsks === 1 && runOpts.firstCaptchaWrong ? 'WRONG' : sc.captcha }; },
    openManualWindow: async d => { out.manualWindows++; sc.registered.A = true; return d.cookies; },
  });
  clearTimeout(stopTimer);
  const posts = sc.log.filter(l => l.startsWith('POST')).length;
  const gaps = sc.times.slice(1).map((t, i) => t - sc.times[i]).filter(g => g >= 0);
  let problem = null;
  try { problem = check({ ...out, posts, log: sc.log, minGap: gaps.length ? Math.min(...gaps) : Infinity }); }
  catch (e) { problem = e.message; }
  const ok = !problem;
  say(`${ok ? '  PASS' : '  FAIL'}  ${name}${ok ? '' : '\n        -> ' + problem}`);
  if (!ok) {
    say('        app said:\n          ' + out.status.concat(out.errors.map(e => 'ERROR: ' + e)).join('\n          '));
  }
  return ok;
}

const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

server.listen(0, '127.0.0.1', async () => {
  process.env.EXAMSETU_BASE_URL = `http://127.0.0.1:${server.address().port}`;
  automation = require('../automation.js');

  say('\nCourse Registrar self-test (fake portal on your computer, the real portal is NOT contacted)\n');
  const results = [];

  results.push(await run('Registers a course by itself when a seat opens (no captcha)',
    {}, {}, r => {
      expect(r.registered.includes('CS301'), 'course was not registered');
      expect(r.posts === 1, `expected 1 register request, got ${r.posts}`);
      expect(r.captchaAsks === 0, 'asked for a captcha that did not exist');
    }));

  results.push(await run('Registers several courses, in your list order',
    { seatsA: 1, seatsB: 2 }, { courses: ['HU317:E2', 'CS301:E1'] }, r => {
      expect(r.registered.join(',') === 'HU317,CS301', `order was ${r.registered.join(',') || 'none'}`);
    }));

  results.push(await run('Watch-only mode sends NO register requests',
    {}, { watchOnly: true, maxMs: 9000 }, r => {
      expect(r.posts === 0, `sent ${r.posts} register request(s) in watch-only mode`);
      expect(r.status.some(s => s.includes('[WATCH ONLY]')), 'did not report the free seat');
    }));

  results.push(await run('Does not repeat a refused request (e.g. slot clash)',
    { refuse: true }, { maxMs: 12000 }, r => {
      expect(r.posts === 1, `sent ${r.posts} register requests for the same refused course`);
      expect(r.registered.length === 0, 'claimed a refused course was registered');
    }));

  results.push(await run('Captcha (separate page): asks you, wrong answer -> asks again, then registers',
    { captcha: 'page' }, { firstCaptchaWrong: true }, r => {
      expect(r.captchaAsks === 2, `asked for captcha ${r.captchaAsks} time(s), expected 2`);
      expect(r.registered.includes('CS301'), 'course was not registered after captcha');
      expect(r.log.some(l => l.includes('captchaInput=X7K9')), 'captcha answer was not submitted');
    }));

  results.push(await run('Captcha (next to the course): asks you and registers',
    { captcha: 'inline' }, { firstCaptchaWrong: true }, r => {
      expect(r.captchaAsks >= 2, `asked for captcha ${r.captchaAsks} time(s)`);
      expect(r.registered.includes('CS301'), 'course was not registered after captcha');
    }));

  results.push(await run('"I\'m not a robot" captcha: opens the logged-in portal window',
    { captcha: 'recaptcha' }, {}, r => {
      expect(r.manualWindows === 1, `opened ${r.manualWindows} portal window(s)`);
      expect(r.registered.includes('CS301'), 'did not detect registration after the window closed');
    }));

  results.push(await run('Registration closed: waits, then registers when it opens',
    { closedFor: 3, seatsAt: 5 }, {}, r => {
      expect(r.status.some(s => /no course list|not open yet/i.test(s)), 'did not say it was waiting');
      expect(r.registered.includes('CS301'), 'did not register after registration opened');
    }));

  results.push(await run('Wrong course code: warns and lists the real codes',
    {}, { courses: ['CS999:E1', 'CS301:E1'] }, r => {
      expect(r.status.some(s => s.includes('CS999') && s.includes('CS301 (E1)')), 'no helpful warning');
      expect(r.registered.includes('CS301'), 'the correct course was not registered');
    }));

  results.push(await run('Portal warning "too many requests": stops immediately',
    { warnAt: 2, seatsAt: 99 }, {}, r => {
      expect(r.errors.some(e => /Portal warning/.test(e)), 'did not stop on the warning');
      expect(r.posts === 0, 'kept sending requests');
    }));

  results.push(await run('HTTP 429 (rate limited): stops immediately',
    { http429At: 2, seatsAt: 99 }, {}, r => {
      expect(r.errors.some(e => /429/.test(e)), 'did not stop on HTTP 429');
    }));

  results.push(await run('"Device Access Suspended" page: stops and shows the reference code',
    { suspendAt: 2, seatsAt: 99 }, {}, r => {
      expect(r.errors.some(e => /suspended/i.test(e) && e.includes('PHMCWSZX')), 'did not stop with the reference code');
    }));

  results.push(await run('"Performing security verification" (bot check) page: stops immediately, no retries',
    { botCheckAt: 2, seatsAt: 99 }, {}, r => {
      expect(r.errors.some(e => /security verification/i.test(e)), 'did not stop on the bot-check page');
      expect(r.log.length === 2, `kept sending requests after the bot check (${r.log.length} requests)`);
    }));

  results.push(await run('Expired cookie (no password given): stops with a clear message, no login spam',
    { sessionExpired: true }, {}, r => {
      expect(r.errors.some(e => /cookie has expired/i.test(e)), 'no clear expired-cookie message');
      expect(!r.log.some(l => l.includes('/student/login')), 'tried to log in');
    }));

  results.push(await run('Speed limit: never two page loads closer than 1 second',
    { seatsAt: 99 }, { maxMs: 9000 }, r => {
      expect(r.minGap >= 200, `two requests only ${r.minGap} ms apart`);
      expect(r.log.length <= 8, `${r.log.length} requests in 9 seconds is too many`);
    }));

  const passed = results.filter(Boolean).length;
  say(`\n${passed}/${results.length} checks passed.`);
  say(passed === results.length
    ? 'Everything works. Next: test with the real portal in Watch-only mode (see README).\n'
    : 'Some checks FAILED. Copy everything above and send it to whoever maintains the app.\n');
  server.close();
  process.exit(passed === results.length ? 0 : 1);
});
