// main.js

const { app, BrowserWindow, ipcMain, session: electronSession } = require('electron');
const path = require('path');
const fs = require('fs');
const { startAutomation, stopAutomation } = require('./automation');

let win;
let automationRunning = false;
let captchaSeq = 0;
const pendingCaptchas = new Map(); // id -> resolve

// Bring the app to the front and get attention (captcha needs you NOW).
function grabAttention() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.setAlwaysOnTop(true);
  win.focus();
  win.flashFrame(true);
  setTimeout(() => { if (win) { win.setAlwaysOnTop(false); win.flashFrame(false); } }, 3000);
}

// Shows the captcha picture in the app and waits for what you type.
function askCaptcha(data) {
  return new Promise(resolve => {
    const id = ++captchaSeq;
    const timer = setTimeout(() => {
      pendingCaptchas.delete(id);
      win.webContents.send('captcha-cancel', id);
      resolve(null);
    }, data.timeoutMs);
    pendingCaptchas.set(id, reply => { clearTimeout(timer); resolve(reply); });
    grabAttention();
    win.webContents.send('captcha-request', { id, ...data });
  });
}

ipcMain.handle('captcha-answer', async (event, { id, answer, manual }) => {
  const done = pendingCaptchas.get(id);
  if (done) { pendingCaptchas.delete(id); done({ answer, manual }); }
  return { success: true };
});

// Opens the real portal page, logged in with the app's session, so you can solve
// any kind of captcha yourself. Resolves with the (possibly updated) cookies when closed.
async function openManualWindow({ url, cookies, userAgent, courseCode }) {
  const ses = electronSession.fromPartition('portal');
  const base = new URL(url).origin;
  await ses.clearStorageData({ storages: ['cookies'] });
  for (const part of cookies.split(';').map(c => c.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i > 0) await ses.cookies.set({ url: base, name: part.slice(0, i), value: part.slice(i + 1), secure: base.startsWith('https') });
  }
  grabAttention();
  return new Promise(resolve => {
    const portal = new BrowserWindow({
      width: 1100, height: 850, parent: win, title: `Register ${courseCode} - solve the captcha, then close this window`,
      webPreferences: { partition: 'portal', contextIsolation: true, nodeIntegration: false },
    });
    if (userAgent) portal.webContents.setUserAgent(userAgent);
    portal.loadURL(url);
    portal.focus();
    portal.on('closed', async () => {
      try {
        const list = await ses.cookies.get({ url: base });
        resolve(list.map(c => `${c.name}=${c.value}`).join('; ') || null);
      } catch (_) { resolve(null); }
    });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
    icon: path.join(__dirname, 'assets', 'dtulogo.png'),
  });

  win.loadFile('index.html');
}

// Only one copy of the app may run, so requests are never doubled up.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(createWindow);
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

ipcMain.handle('start-automation', async (event, data) => {
  if (automationRunning) {
    return { success: false, error: 'Automation is already running.' };
  }

  const { creds, courses, autoLogin, manualCookie, manualStudentId, watchOnly, browserUserAgent, speed } = data;
  automationRunning = true;

  try {
    startAutomation({
      credentials: creds,
      courses,
      autoLogin,
      manualCookie,
      manualStudentId,
      watchOnly,
      browserUserAgent,
      speed,
      sessionFile: path.join(app.getPath('userData'), 'session.json'),
    }, {
      onStatusUpdate: (message) => win.webContents.send('status-update', message),
      onCourseRegistered: (course) => win.webContents.send('course-registered', course),
      onCourseBlocked: (course) => win.webContents.send('course-blocked', course),
      onError: (error) => win.webContents.send('automation-error', error),
      askCaptcha,
      openManualWindow,
      onStop: () => {
        automationRunning = false;
        win.webContents.send('status-update', 'Automation stopped.');
      },
    });
    return { success: true };
  } catch (error) {
    automationRunning = false;
    return { success: false, error: error.message };
  }
});

ipcMain.handle('clear-session', async () => {
  try { fs.unlinkSync(path.join(app.getPath('userData'), 'session.json')); } catch (_) {}
  return { success: true };
});

ipcMain.handle('stop-automation', async () => {
  if (automationRunning) {
    stopAutomation();
    automationRunning = false;
  }
  return { success: true };
});
