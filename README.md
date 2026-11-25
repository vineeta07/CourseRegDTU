# DTU Seat Monitor

A desktop app for the redesigned DTU course-registration portal
[`https://exam-setu.dtu.ac.in/register/`](https://exam-setu.dtu.ac.in/register/).

## What it does

- Opens the DTU portal in a separate Electron window; you log in there yourself.
- Watches only the course codes you enter (optionally with a slot, e.g. `EE316N:E4`).
- Clicks that course's own **Add** button the instant it appears (~1–2 ms), from
  inside the page. If the portal doesn't react within 60 ms, it falls back to a
  real mouse click, then keeps alternating every 300 ms until the row changes.
- Shows each course's live state: seats left, Full, **ADDED ✓**, or the portal's
  own button word if it is something unexpected.
- Keeps working with the portal window covered by other windows. Don't minimise it:
  the real-mouse fallback click needs it on screen.
- Never clicks another course's button, **Drop**, or the final **Submit**.

The app does not log in for you, solve verification, or submit the final registration.

## Download

Download the latest installer or portable Windows build from:

https://github.com/vineeta07/CourseRegDTU/releases/latest

## Use

1. Start the app and enter course codes, one per row: `EV302`, or `HU426:E4` to require a slot.
2. Click **Start Monitoring**.
3. Sign in in the portal window and open the course list.
4. Keep the portal window open (other windows on top are fine). Don't minimise or close it, or navigate away from the course list.
5. When a seat opens the app adds the course and shows **ADDED ✓**.

## Notes

- To change the course list, **Stop Monitoring** first (the list is locked while running).
- If you drop a watched course while monitoring, the app will add it straight back. Stop first.
- Don't log in to the portal anywhere else at the same time: it may sign out the app's window.
- Keep the PC awake and online while monitoring.
- The app does not reload the portal or contact the server on its own; it only reacts to what the portal page shows.
- The course box starts blank on every launch; old lists are not restored.
- Stop monitoring whenever the portal reports an error or verification challenge.

## Run from source

```bash
npm install
npm start
```

## Test

```bash
npm test
```

Runs the logic tests and the Electron tests (real scripts against mock portal
pages, including click latency and hidden-window checks).

## Build Windows downloads

```bash
npm run dist:win
```

Build output is written to `dist/`.
