'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 只暴露这组方法，不把 ipcRenderer 本体交给页面。
contextBridge.exposeInMainWorld('phonote', {
  config: () => ipcRenderer.invoke('phonote:config'),
  saveConfig: (patch) => ipcRenderer.invoke('phonote:save-config', patch),
  rest: (request) => ipcRenderer.invoke('phonote:rest', request),
  capture: () => ipcRenderer.invoke('phonote:capture'),
  pickFolder: () => ipcRenderer.invoke('phonote:pick-folder'),
  mediaUrl: (image) => ipcRenderer.invoke('phonote:media-url', image),
  openFolder: (folder) => ipcRenderer.invoke('phonote:open-folder', folder),
  onCaptured: (handler) => {
    ipcRenderer.on('phonote:captured', (_event, payload) => handler(payload));
  },
  onError: (handler) => {
    ipcRenderer.on('phonote:error', (_event, message) => handler(message));
  },
});
