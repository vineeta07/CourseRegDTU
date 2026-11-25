// preload.js — DTU Seat Monitor

const { contextBridge, ipcRenderer } = require('electron');

// Every call / event carries an accountId (one per student login).
contextBridge.exposeInMainWorld('electronAPI', {
  startMonitor: (data) => ipcRenderer.invoke('start-monitor', data),
  stopMonitor: (accountId) => ipcRenderer.invoke('stop-monitor', accountId),
  removeAccount: (accountId) => ipcRenderer.invoke('remove-account', accountId),
  onMonitorStatus: (callback) => ipcRenderer.on('monitor-status', callback),
  onMonitorState: (callback) => ipcRenderer.on('monitor-state', callback),
  onMonitorAlert: (callback) => ipcRenderer.on('monitor-alert', callback),
  onMonitorStopped: (callback) => ipcRenderer.on('monitor-stopped', callback),
});
