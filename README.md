# DTU Seat Monitor

A desktop app for the DTU course registration page
[`https://exam-setu.dtu.ac.in/student/courseRegistration`](https://exam-setu.dtu.ac.in/student/courseRegistration).

## What it does

- Opens the DTU portal in a separate window; you log in there yourself.
- Watches only the course codes you enter (optionally with a slot, e.g. `HU404:E4`).
- Clicks that course's own **Register** button the instant it is enabled with seats > 0.
  If the portal doesn't react within 60 ms, it tries a real mouse click.
- At most 4 clicks per seat opening; if nothing changes it pauses 30 s.
- **Priority:** the course list order is the priority (top = highest; use ↑ to move a
  course up). The portal allows one course per slot, so when several courses in the
  same slot are open, only the highest-priority one is registered. If a higher-priority
  course opens in a slot where you already hold a lower one, the app tells you; it
  will not switch for you, because that needs a Drop.
- Skips greyed-out Register buttons (courses not open to you).
- Shows each course's live state: seats left, Full, **ADDED ✓**, or the portal's button state.
- **Never clicks Drop.** It only ever clicks a button that says exactly "Register",
  in the row of a course on your list. A real mouse click that would land on
  anything else is cancelled.
## Download

Download the latest installer or portable Windows build from:

https://github.com/vineeta07/CourseRegDTU/releases/latest

## Use

1. Start the app and enter course codes, one per row: `EV302`, or `HU404:E4` to require a slot.
2. Click **Start Monitoring**.
3. Sign in in the portal window and open Academics > Course Registration. Keep the slots you watch expanded.
4. Keep the portal window open (other windows on top are fine). Don't minimise or close it, or navigate away from the course list.
5. When a seat opens the app clicks Register and shows **ADDED ✓** once the portal confirms.

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
