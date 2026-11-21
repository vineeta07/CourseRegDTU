// preload.js

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startAutomation: (data) => ipcRenderer.invoke('start-automation', data),
  stopAutomation: () => ipcRenderer.invoke('stop-automation'),
  retryNow: () => ipcRenderer.invoke('retry-now'),
  clearSession: () => ipcRenderer.invoke('clear-session'),
  onCaptchaRequest: (callback) => ipcRenderer.on('captcha-request', callback),
  onCaptchaCancel: (callback) => ipcRenderer.on('captcha-cancel', callback),
  sendCaptchaAnswer: (data) => ipcRenderer.invoke('captcha-answer', data),
  onStatusUpdate: (callback) => ipcRenderer.on('status-update', callback),
  onCourseRegistered: (callback) => ipcRenderer.on('course-registered', callback),
  onCourseBlocked: (callback) => ipcRenderer.on('course-blocked', callback),
  onError: (callback) => ipcRenderer.on('automation-error', callback),
  onStopped: (callback) => ipcRenderer.on('automation-stopped', callback),

  // Read-only seat monitor (new /register/ portal)
  startMonitor: (data) => ipcRenderer.invoke('start-monitor', data),
  stopMonitor: () => ipcRenderer.invoke('stop-monitor'),
  onMonitorStatus: (callback) => ipcRenderer.on('monitor-status', callback),
  onMonitorState: (callback) => ipcRenderer.on('monitor-state', callback),
  onMonitorAlert: (callback) => ipcRenderer.on('monitor-alert', callback),
  onMonitorStopped: (callback) => ipcRenderer.on('monitor-stopped', callback),
});
