// 渲染进程能碰到的全部能力：三个方法与一个事件通道。
// 不暴露 require、不暴露 ipcRenderer 本体——渲染进程拿不到任意 IPC 的入口。

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('phonote', {
  config: () => ipcRenderer.invoke('phonote:config'),
  saveConfig: (patch) => ipcRenderer.invoke('phonote:save-config', patch),
  call: (tool, args) => ipcRenderer.invoke('phonote:call', { tool, args }),
  capture: () => ipcRenderer.invoke('phonote:capture'),
  mediaUrl: (capture) =>
    ipcRenderer.invoke('phonote:media-url', {
      sha256: capture.sha256,
      mediaType: capture.media_type,
    }),
  openFolder: () => ipcRenderer.invoke('phonote:open-folder'),
  onCaptured: (handler) => {
    ipcRenderer.on('phonote:captured', (_event, payload) => handler(payload));
  },
  onError: (handler) => {
    ipcRenderer.on('phonote:error', (_event, message) => handler(message));
  },
});
