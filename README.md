# DTU Seat Monitor

A desktop app that watches specific courses on the new DTU registration portal
(**https://exam-setu.dtu.ac.in/register/**) and gives a **loud desktop alert** the moment a full
course frees up — then highlights and focuses its **Add** button so you confirm with one keystroke.

It is **read-only**: it never clicks Add, never submits, and never bypasses the portal's security
check. You log in yourself in the window it opens, and you make the final click.

> The older auto-registration app (for the previous portal) lives on the **`vineeta`** branch.
> This branch is the monitor only.

To start: `npm install` then `npm start`

## Seat Monitor (new /register/ portal) — read-only

The redesigned portal (`/register/`) is a different site with a bot check, so the auto-registration
part of this app does **not** work there. Instead there is a **read-only Seat Monitor** that alerts you
the instant a full course frees up. It never clicks Add/Submit — **you** do the final click.

**How it works**
1. In the app, under **Seat Monitor**, enter the course codes to watch (defaults to HU426, HU308, HU404).
   You may add the slot for display as `CODE:SLOT`, e.g. `HU426:E4`.
2. Click **Start Monitoring**. A browser window opens on `/register/`.
3. **Log in there yourself** (solve any verification), open Course Registration, and **keep that window open**.
4. The app reads that page every few seconds (read-only). When a course changes from **Full → seats available**, it:
   - plays a **loud alarm** and shows a **desktop notification** (course code + seats),
   - **brings that portal window to the front**,
   - **scrolls to the course and highlights its Add button** with a red/yellow outline and a banner.
5. The **Add** button is right there, highlighted and focused — **press Enter (or click it)** to add the course.
   Clicking **Add** adds it immediately. **Do NOT click the final Submit button** — that locks all your
   course choices and you can't change them afterwards. The app never clicks Add and never submits for you.

**Behaviour**
- Independent state per course; a course is tracked separately from the others.
- No duplicate alerts: it fires once when a seat opens, and again only if the course fills and re-opens.
- Tolerates page reloads / brief disconnects; stops itself if the page is unreadable several times in a row
  or if you close the portal window.
- It only observes the page you loaded and authenticated yourself — it does not bypass the bot check,
  log in for you, or submit anything.

Tested by `npm run selftest:monitor` (19 checks).

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
