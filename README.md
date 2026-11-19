# Course Registrar (DTU ExamSetu)

To start: `npm install` then `npm start`

## Easiest way: use your browser's login (the app never logs in itself)

A **cookie** is the "pass" the website gives your browser after you log in.
If the app uses the same pass, it is already logged in as you, so it never has to log in again.

**Steps (Chrome):**
1. Open https://exam-setu.dtu.ac.in and log in normally.
2. Open your course registration page. The link looks like
   `.../student/courseRegistration/66b0f2321af8ca2e2591dc58`.
3. **Student ID** = the long code at the end of that link (or paste the whole link, the app picks the code out).
4. Press **F12** (Mac: **Cmd + Option + I**). A panel opens.
5. Click the **Network** tab, then press **F5** to reload the page.
6. Click the **first row** in the list (named like your Student ID).
7. On the right, scroll to **Request Headers** and find the line **`cookie:`**.
8. Right-click its value -> **Copy value**. It looks like `connect.sid=s%3Aabc...; token=xyz...`
9. (Optional) Copy the **`user-agent:`** value from the same list.

**Paste into the app**, in the box "Use Browser Session (optional, no login)":
- **Session Cookie** <- step 8
- **Student ID (from URL)** <- step 3
- **Your Browser's User-Agent** <- step 9 (optional)

Do **not** press Logout on the website afterwards (that kills the cookie). Just close the tab.

If you don't paste a cookie, the app logs in once with roll number + password and saves that session
for next time ("Forget Saved Session" clears it). If a session expires mid-run, the first re-login is
instant; further ones wait 5s and 20s, max 3.

## Safety limits (to avoid getting your device blocked)
- **Watch only** mode is ON by default: test it first, it sends no register requests.
- Page checked every 3s (Normal) or 2s (Fast); never more than 40 requests/min.
- When a seat opens, the register request goes out ~0.25s later.
- Register requests submit the course's form exactly as the page defines it (same fields/tokens),
  only when seats are free and the button is enabled.
- Max 2 tries per course; a refused course is not retried until its seat count changes. Max 10 per run.
- Stops immediately on HTTP 403/429, any warning like "too many requests"/"blocked"/"suspended",
  or the Device Access Suspended page.
- Only one copy of the app can run at a time. Don't also keep refreshing the portal in your browser.

## Captcha

If the portal asks for a captcha after clicking a course, the app does **not** give up:

1. **Normal picture captcha:** the app beeps, jumps to the front and shows the captcha picture.
   Type it and press **Enter** (or click *Verify & Register*). The app submits it instantly with your session.
   Wrong answer -> it shows the new captcha (up to 3 tries). You have 90 seconds to answer.
2. **Anything else** (Google "I'm not a robot", or a layout the app can't read), or if you click
   *Open portal page instead*: a window opens with the real portal page, already logged in.
   Solve the captcha and click Verify/Register there, then **close that window**.
   The app then checks whether the course got registered and continues.

Stay at the computer during registration: the captcha always needs you.
