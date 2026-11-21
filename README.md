# Course Registrar (DTU ExamSetu)

A desktop app that watches your course registration page on **https://exam-setu.dtu.ac.in**
and registers your chosen courses **automatically** the moment a seat opens.

- No captcha → it registers the course by itself, nothing for you to do.
- Captcha → it beeps, shows you the captcha, you type it, it submits instantly.
- Built-in safety limits so your device does not get blocked (see [Safety limits](#safety-limits)).

---

## Contents
0. [Download and install (easiest, no setup)](#0-download-and-install-easiest-no-setup)
1. [Or: run from source code (for developers)](#1-or-run-from-source-code-for-developers)
2. [Fill in the app](#2-fill-in-the-app)
3. [Check that all the code works (self-test)](#2-check-that-all-the-code-works-self-test) and [test it before registration opens](#3-test-it-before-registration-opens)
4. [On registration day](#4-on-registration-day)
5. [If a captcha appears](#5-if-a-captcha-appears)
6. [Safety limits](#safety-limits)
7. [Troubleshooting](#7-troubleshooting)
8. [Updating the app](#8-updating-the-app)

---

## 0. Download and install (easiest, no setup)

No terminal, no Node.js. Just download and open.

1. Go to the **Releases** page: https://github.com/vineeta07/CourseRegDTU/releases/latest
2. Under **Assets**, download the file for your computer:

| Your computer | Download |
|---|---|
| **Windows** | `CourseRegistrar-...-win-x64.exe` (installer) **or** `CourseRegistrar-...-windows-portable.exe` (no install, just double-click) |
| **Mac with Apple chip** (M1/M2/M3/M4) | `CourseRegistrar-...-mac-arm64.dmg` |
| **Mac with Intel chip** | `CourseRegistrar-...-mac-x64.dmg` |
| **Linux** | `.AppImage` (any Linux) or `.deb` (Ubuntu/Debian) |

Not sure which Mac you have? Apple menu  → **About This Mac** → "Chip: Apple M…" = Apple chip, "Processor: Intel" = Intel.

3. **Open it the first time.** The app isn't from an app store, so your computer shows a warning once:
   - **Windows:** "Windows protected your PC" → click **More info** → **Run anyway**.
   - **Mac:** open the `.dmg`, drag **CourseRegistrar** into **Applications**. Open it: if it says it
     "can't be opened" or "is damaged", go to **System Settings → Privacy & Security**, scroll down and
     click **Open Anyway**. If that button isn't there, open **Terminal** and run:
     ```bash
     xattr -cr /Applications/CourseRegistrar.app
     ```
     then open the app again.
   - **Linux (AppImage):** right-click the file → Properties → Permissions → tick **Allow executing as program**,
     then double-click it.

4. Continue with [Fill in the app](#2-fill-in-the-app).

**Updating:** download the newest file from the Releases page again and install it over the old one.

> The app runs on **your own computer** on purpose: it uses *your* login session, and each person's
> requests come from their own device. A shared website running it for everyone would send all
> students' requests from one place, which is exactly what gets blocked.

---

## 1. Or: run from source code (for developers)

Skip this if you used the download above. You only do this once.

### a) Install the tools
- **Node.js** (version 18 or newer): download the **LTS** version from https://nodejs.org and install it
  (just click Next / Continue through the installer).
- **Git**: https://git-scm.com/downloads (Mac users can also run `xcode-select --install`).

Check they work. Open **Terminal** (Mac) or **Command Prompt / PowerShell** (Windows) and run:

```bash
node -v
```
```bash
git --version
```

Both should print a version number.

### b) Download the app

```bash
git clone https://github.com/vineeta07/CourseRegDTU.git
```
```bash
cd CourseRegDTU
```
```bash
git checkout vineeta
```

### c) Install its parts (takes a few minutes the first time)

```bash
npm install
```

### d) Start it

```bash
npm start
```

A window called **Course Registrar** opens. Every next time, just open a terminal in the
`CourseRegDTU` folder and run `npm start` again.

> Optional: to make a double-click app instead, run `npm run dist:win` (Windows) or
> `npm run dist:linux` (Linux). The installer appears in the `dist` folder.

---

## 2. Fill in the app

### a) Your login: use your browser's cookie (recommended)

A **cookie** is the "pass" the website gives your browser after you log in. If the app uses the
same pass, it is already logged in as you, so it **never has to log in itself**. This is faster
and safer (repeated logins are what get devices blocked).

**Steps (Chrome / Edge / Brave):**
1. Open https://exam-setu.dtu.ac.in and log in normally.
2. Open your **course registration page**. The link looks like
   `https://exam-setu.dtu.ac.in/student/courseRegistration/66b0f2321af8ca2e2591dc58`
3. **Student ID** = the long code at the end of that link (`66b0f2321af8ca2e2591dc58`).
   You can also paste the whole link; the app picks the code out.
4. Press **F12** (Mac: **Cmd + Option + I**). A panel opens.
5. Click the **Network** tab at the top of that panel, then press **F5** to reload the page.
6. Click the **first row** in the list (it has the same name as your Student ID).
7. On the right side, scroll down to **Request Headers** and find the line **`cookie:`**.
8. Right-click the text after `cookie:` → **Copy value**.
   It looks like `connect.sid=s%3Aabc...; token=xyz...`
9. *(Optional)* In the same list, copy the value of **`user-agent:`**.

**Paste into the app**, in the box **"Use Browser Session (optional, no login)"**:

| App field | What to paste |
|---|---|
| Session Cookie | the cookie value from step 8 |
| Student ID (from URL) | the code from step 3 |
| Your Browser's User-Agent | the value from step 9 (optional) |

⚠️ Do **not** press **Logout** on the website afterwards. That cancels the cookie. Just close the tab.
Cookies expire after some time, so copy a **fresh** one shortly before registration starts.

### b) Or: roll number + password

If you leave the cookie boxes empty, enter your **Roll Number** and **Password** instead.
The app logs in **once** and saves the session for next time.
Tick **"Auto Login on Session Expiry"** if you want it to log in again by itself when the session
expires (at most once per run).
**"Forget Saved Session"** deletes the saved session.

You can fill both (cookie + roll number/password): the app uses the cookie, and only if it expires
uses the password as backup (when Auto Login is ticked).

### c) Courses to track

Click **Add Course** for each course and enter:
- **Course Code**, exactly as on the portal, e.g. `HU317`
- **Slot**, exactly as on the portal, e.g. `E2`

**Order matters:** if two of your courses get seats at the same time, the one higher in the list is
registered first.

Or click the **`</>`** button and paste a list:

```json
[
  { "code": "HU317", "slot": "E2" },
  { "code": "SE427", "slot": "E1" }
]
```

### The app remembers your details
Everything you type (cookie, Student ID, courses, speed, roll number) is **remembered on your computer**
and filled in again next time you open the app. **Your password is never saved.**
You only need to paste a **new cookie** when the old one stops working: the log then says
*"Your browser session cookie has expired"*, or you logged out on the website.

### d) Checking speed
- **Normal**: checks every 3 seconds (safer). Use most of the time.
- **Fast**: checks every 2 seconds. Use only for the first few minutes of the registration rush.

---

## 2½. Check that all the code works (self-test)

*(Only if you run from source code. Takes about 1½ minutes.)*

In the `CourseRegDTU` folder run:

```bash
npm run selftest
```

This does **not** contact the real portal. It starts a **fake portal on your own computer** and runs
the real app code against it in 20 situations: registering by itself, list order, Watch-only,
refused courses, all captcha types, registration closed, wrong course code, portal warnings,
429 errors, the Device Suspended page, an expired cookie and the speed limit.

You should see `PASS` on every line and **`20/20 checks passed.`** at the end.
If any line says `FAIL`, copy the whole output and send it to the maintainer.

---

## 3. Test it before registration opens

1. Fill everything in as above.
2. Keep **"Watch only"** **ticked** (it is ticked by default).
3. Press **Start Automation**.

In Watch-only mode the app only **looks**; it never clicks Register.
Every message is kept in the **Activity log** under the Start/Stop button (newest on top). Check it:
- `Tracking N course(s): HU317(0 seats), ...` → it found your courses ✅
- `WARNING - not found on the page ...` → fix the code or slot.
- `Registration is not open yet ...` → registration is closed right now. You can only fully test
  while registration is open, but this confirms your cookie/login works.
- If a seat is free it says `[WATCH ONLY] HU317 has 3 seat(s) and would be registered now`.

Press **Stop Automation** when you're happy.

---

## 4. On registration day

**Checklist:**
1. Log in on the website and copy a **fresh cookie** (section 2a). Close the tab; don't log out.
2. Open the app, paste the cookie + Student ID, check your course list.
3. **Untick "Watch only"**. The app asks you to confirm: click **OK**.
4. Choose **Fast** for the opening rush (switch back to Normal later if it runs a long time).
5. Press **Start Automation**.
6. **Stay at your computer** with the volume on, in case a captcha appears.
7. Don't keep refreshing the portal in your browser at the same time, and don't run the app on two
   computers with the same account. That doubles your requests.

**If a course didn't register and you want another go:** press **Try again now** (next to Stop).
Every course gets fresh tries at the next free seat, including ones the app paused after the portal
refused them. Or press Stop and Start again. Each run starts fresh.

**What happens next, by itself:**
- When a seat opens, the app clicks Register about 0.25 s later.
- No captcha → it registers, confirms it, shows it under **Registered Courses**, moves to the next course.
- If a course turns grey on the portal (blocked), it shows under **Blocked Courses** and is skipped.
- When all courses are done it stops by itself.

---

## 5. If a captcha appears

The app does **not** give up on the course.

**Picture captcha** (letters/numbers in an image):
1. The app **beeps 3 times** and **jumps to the front** with the captcha picture.
2. Type it and press **Enter** (or click **Verify & Register**). It is submitted instantly.
3. Wrong answer → a new captcha appears right away (up to 3 tries). You have **90 seconds**.

**Google "I'm not a robot", or a page the app can't read**, or if you click
**"Open portal page instead"**:
1. A window opens with the **real portal page, already logged in** as you.
2. Solve the captcha and click Verify / Register there.
3. **Close that window.** The app checks if the course got registered and continues.

---

## Safety limits

These are there so your device does not get blocked ("multiple altering requests"):

- Never more than **40 requests per minute**; at least 1 s between page checks.
- Register requests are sent **exactly like the real button** (same form fields/tokens), only when
  seats are free and the button is enabled.
- At most **2 tries per course**. A refused course (e.g. slot clash) is **not** retried until its
  seat count changes. At most **15 register/captcha submits per run**.
- **Stops immediately** if the portal returns an error like 403/429, shows any warning such as
  "too many requests" / "blocked" / "suspended", or shows the **Device Access Suspended** page.
- Only **one copy** of the app can run at a time.

**The app stops by itself on any problem.** It never keeps trying after something goes wrong:

| Problem | What the app does |
|---|---|
| "Performing security verification" (bot check) page | Stops at once. |
| "Too many requests" / any warning, HTTP 403 or 429 | Stops at once. |
| "Device Access Suspended" page | Stops at once. |
| Any other error from the portal (4xx), or the course list disappears | Stops at once. |
| A register request fails | Stops; does not retry. |
| Server/network error (5xx, timeout) | Waits 5 s and tries **once** more; stops if that fails too. |
| Session expires and no password/Auto Login | Stops with a clear message (no login attempts). |

If the app stops because the portal pushed back, **don't restart it right away.**
Meanwhile, **register by hand in your normal browser.**

---

## 7. Troubleshooting

| Message / problem | What to do |
|---|---|
| `WARNING - not found on the page` | Code or slot is spelled differently from the portal. The message lists courses that *are* on the page; copy yours exactly. |
| `Registration is not open yet` / `no course list on the page` | Normal before registration opens. Leave it running: it keeps checking and starts by itself the moment the course list appears. |
| `Your browser session cookie has expired` | Log in on the website again, copy a fresh cookie (2a), start again. |
| `Invalid Roll Number or Password` | Check your credentials. |
| `Server refused 2 times (clash/ineligible?)` | The portal won't let you take that course (slot clash, not eligible, credit limit). Check on the website. |
| `Portal warning: ...` / `HTTP 403 / 429` | The portal is pushing back. Wait a while before trying again. |
| `security verification (bot check)` | The portal now screens out bots. The app stops on purpose and won't continue. **Register by hand in your normal browser.** Don't keep restarting the app. |
| `Device Access Suspended` | Your device was blocked. Visit the Examination Department with your ID card and the reference code shown. |
| `Reached the safety limit` | Something kept failing. Check the portal by hand. |
| Captcha window opens every time | The captcha page looks different from what the app expects. Save that page (Ctrl+S) and share it so the app can be updated. |
| `npm` / `node` not found | Install Node.js (section 1a) and open a **new** terminal. |
| `npm install` fails | Delete the `node_modules` folder and run `npm install` again. |
| App window doesn't open | Make sure you're inside the `CourseRegDTU` folder when running `npm start`. |

---

## 8. Updating the app

**If you downloaded the installer:** download the newest file from
https://github.com/vineeta07/CourseRegDTU/releases/latest and install it again.

**If you run from source code:** when there are changes, open a terminal in the `CourseRegDTU` folder and run:

```bash
git pull origin vineeta
```
```bash
npm install
```

Then `npm start` as usual.

---

## For the maintainer: publishing a new download

The installers are built automatically by GitHub (`.github/workflows/release.yml`).
To publish a version (all on the GitHub website, no terminal):

1. *(For later versions)* change `"version"` in `package.json` (e.g. `1.0.1`) and commit.
2. Open https://github.com/vineeta07/CourseRegDTU/releases/new
3. **Choose a tag** → type `v1.0.0` (or the new version) → **Create new tag**.
4. **Target** → pick the branch with the code (e.g. `vineeta`).
5. Title: `v1.0.0` → click **Publish release**.
6. Wait ~10–15 minutes (progress in the **Actions** tab). The `.exe`, `.dmg`, `.AppImage` and `.deb`
   files then appear under **Assets** on that release.
