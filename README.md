# Course Registrar (DTU ExamSetu)

A desktop app that watches your course registration page on **https://exam-setu.dtu.ac.in**
and registers your chosen courses **automatically** the moment a seat opens.

- No captcha → it registers the course by itself, nothing for you to do.
- Captcha → it beeps, shows you the captcha, you type it, it submits instantly.
- Built-in safety limits so your device does not get blocked (see [Safety limits](#safety-limits)).

---

## Contents
1. [Install and run on your computer (local)](#1-install-and-run-on-your-computer-local)
2. [Fill in the app](#2-fill-in-the-app)
3. [Test it before registration opens](#3-test-it-before-registration-opens)
4. [On registration day](#4-on-registration-day)
5. [If a captcha appears](#5-if-a-captcha-appears)
6. [Safety limits](#safety-limits)
7. [Troubleshooting](#7-troubleshooting)
8. [Updating the app](#8-updating-the-app)

---

## 1. Install and run on your computer (local)

You only do this once.

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
expires (the first re-login is instant; at most 3 per run).
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

### d) Checking speed
- **Normal**: checks every 3 seconds (safer). Use most of the time.
- **Fast**: checks every 2 seconds. Use only for the first few minutes of the registration rush.

---

## 3. Test it before registration opens

1. Fill everything in as above.
2. Keep **"Watch only"** **ticked** (it is ticked by default).
3. Press **Start Automation**.

In Watch-only mode the app only **looks**; it never clicks Register. Check the status line:
- `Tracking N course(s): HU317(0 seats), ...` → it found your courses ✅
- `Not found on page (check code/slot): ...` → fix the code or slot.
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

If the app stops because of a warning: **don't restart it right away.** Wait, and register by hand
on the website if needed.

---

## 7. Troubleshooting

| Message / problem | What to do |
|---|---|
| `Not found on page (check code/slot)` | Code or slot is spelled differently from the portal. Copy them exactly. |
| `Your browser session cookie has expired` | Log in on the website again, copy a fresh cookie (2a), start again. |
| `Invalid Roll Number or Password` | Check your credentials. |
| `Server refused 2 times (clash/ineligible?)` | The portal won't let you take that course (slot clash, not eligible, credit limit). Check on the website. |
| `Portal warning: ...` / `HTTP 403 / 429` | The portal is pushing back. Wait a while before trying again. |
| `Device Access Suspended` | Your device was blocked. Visit the Examination Department with your ID card and the reference code shown. |
| `Reached the safety limit` | Something kept failing. Check the portal by hand. |
| Captcha window opens every time | The captcha page looks different from what the app expects. Save that page (Ctrl+S) and share it so the app can be updated. |
| `npm` / `node` not found | Install Node.js (section 1a) and open a **new** terminal. |
| `npm install` fails | Delete the `node_modules` folder and run `npm install` again. |
| App window doesn't open | Make sure you're inside the `CourseRegDTU` folder when running `npm start`. |

---

## 8. Updating the app

When there are changes, open a terminal in the `CourseRegDTU` folder and run:

```bash
git pull origin vineeta
```
```bash
npm install
```

Then `npm start` as usual.
