# DTU Seat Monitor

A desktop app for the redesigned DTU course-registration portal
[`https://exam-setu.dtu.ac.in/register/`](https://exam-setu.dtu.ac.in/register/).

## What it does

- Opens the DTU portal in a separate Electron window.
- Lets you add the course codes and slots you want to watch.
- Watches portal DOM changes and uses a 50 ms polling fallback.
- Detects courses with 1 or more available seats.
- Automatically attempts the matching course's visible **+ Add** button.
- Retries an unconfirmed Add attempt and supports independent course de-duplication.
- Sends a normal desktop notification and in-app status update.
- Never clicks **Added**, **Drop**, or **Submit**.
- Supports one course per slot, while other slots remain eligible.

The app does not log in for you, solve verification, or submit the final registration.
Keep the portal window open and complete any login or verification yourself.

## Download

Download the latest installer or portable Windows build from:

https://github.com/vineeta07/CourseRegDTU/releases/latest

## Use

1. Start the app and enter course codes in `CODE:SLOT` format, for example `HU426:E4`.
2. Click **Start Monitoring**.
3. Sign in in the portal window and open Course Registration.
4. Keep the portal window open while monitoring.
5. The app will attempt **+ Add** for eligible available courses.
6. Review the selected courses and complete the final submit step manually.

## Safety notes

- Do not leave or submit the app against the portal's terms or access rules.
- The app does not reload the portal automatically.
- A failed or unconfirmed Add attempt is retried automatically while the course remains available.
- Only courses shown in the course box are eligible. Removing or clearing a course updates a running monitor immediately.
- Slot suffixes such as `CH314m:E1` restrict that course to the matching elective slot.
- The course box starts blank on every app launch; old saved course lists are intentionally not restored.
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

## Build Windows downloads

```bash
npm run dist:win
```

Build output is written to `dist/`.
