# DTU Seat Monitor

A desktop app for the redesigned DTU course-registration portal
[`https://exam-setu.dtu.ac.in/register/`](https://exam-setu.dtu.ac.in/register/).

## What it does

- Opens the DTU portal in a separate Electron window.
- Lets you add the course codes and slots you want to watch.
- Checks the loaded portal page every 3 seconds.
- Detects courses with 1 or more available seats.
- Automatically attempts the matching course's visible **+ Add** button.
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
- The app makes no registration retry after an Add attempt.
- If multiple courses in the same slot open, only one course from that slot is attempted.
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
