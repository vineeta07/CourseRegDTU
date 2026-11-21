// preload.js — DTU Seat Monitor

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  startMonitor: (data) => ipcRenderer.invoke('start-monitor', data),
  stopMonitor: () => ipcRenderer.invoke('stop-monitor'),
  onMonitorStatus: (callback) => ipcRenderer.on('monitor-status', callback),
  onMonitorState: (callback) => ipcRenderer.on('monitor-state', callback),
  onMonitorAlert: (callback) => ipcRenderer.on('monitor-alert', callback),
  onMonitorStopped: (callback) => ipcRenderer.on('monitor-stopped', callback),
});
