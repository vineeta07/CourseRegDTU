// main.js

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const { startAutomation, stopAutomation } = require('./automation');

let win;
let automationRunning = false;

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
