# Course Registrar (DTU ExamSetu)

To start: `npm install` then `npm start`

## How it avoids repeated logins
- **Browser session (recommended):** log in on https://exam-setu.dtu.ac.in in your browser, copy the cookies
  (DevTools -> Application -> Cookies, as `name=value; name2=value2`) and the Student ID from the end of the
  course registration URL. The app then never logs in itself.
- **Saved session:** after one successful login the session is saved and reused on the next start.
  Use "Forget Saved Session" to clear it.
- Re-login on expiry is capped at 3 attempts with long back-off (15s / 45s / 2min).

## Safety limits (to avoid getting your device blocked)
- **Watch only** mode is ON by default: test it first, it sends no register requests.
- Page checked every 3s; never more than 25 requests/min, minimum 1.5s between any two requests.
- Register requests submit the course's form exactly as the page defines it (same fields/tokens),
  only when seats are free and the button is enabled.
- Max 2 tries per course; a refused course is not retried until its seat count changes. Max 10 per run.
- Stops immediately on HTTP 403/429, any warning like "too many requests"/"blocked"/"suspended",
  or the Device Access Suspended page.
- Only one copy of the app can run at a time. Don't also keep refreshing the portal in your browser.
