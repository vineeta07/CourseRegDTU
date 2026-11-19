# Course Registrar (DTU ExamSetu)

To start: `npm install` then `npm start`

## How it avoids repeated logins
- **Browser session (recommended):** log in on https://exam-setu.dtu.ac.in in your browser, copy the cookies
  (DevTools -> Application -> Cookies, as `name=value; name2=value2`) and the Student ID from the end of the
  course registration URL. The app then never logs in itself.
- **Saved session:** after one successful login the session is saved and reused on the next start.
  Use "Forget Saved Session" to clear it.
- Re-login on expiry is capped at 3 attempts with long back-off (15s / 45s / 2min).

## Request behaviour
- Registration page is checked every 2s.
- A register request is only sent when a tracked course shows free seats; at most 3 attempts per course,
  then the course is dropped (usually a slot clash / not eligible).
- If the portal shows "Device Access Suspended", the app stops immediately and shows the reference code.
