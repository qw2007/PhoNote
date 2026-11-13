'use strict';

const { app, BrowserWindow, dialog, desktopCapturer, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const HOTKEY = 'Control+Shift+S';
const THUMBNAIL = { width: 1600, height: 1600 };
const JPEG_QUALITY = 85;

const DEFAULT_SETTINGS = {
  apiBase: 'http://127.0.0.1:8000',
  apiKey: '',
  notesDir: path.join(app.getPath('home'), 'PhoNote'),
  // 第二台设备 / 投屏场景：只读钥匙只能读，壳里也要把写入口收起来。
  readonly: false,
  // 新建笔记时套用平台内置骨架（lecture：定义 / 定理 / 易错点 / 例题）。
  useTemplate: true,
};

let mainWindow = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return {
      ...DEFAULT_SETTINGS,
      ...raw,
      readonly: raw.readonly === true,
      useTemplate: raw.useTemplate !== false,
    };
  } catch (error) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  next.readonly = next.readonly === true;
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  applyHotkey(next);
  return next;
}

async function rest(method, pathname, payload) {
  const settings = readSettings();
  const headers = {};
  if (settings.apiKey) {
    headers['X-API-Key'] = settings.apiKey;
  }
  if (payload !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const base = settings.apiBase.replace(/\/+$/, '');
  const response = await fetch(`${base}/notes/api${pathname}`, {
    method,
    headers,
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  if (!response.ok) {
    let code = 'http_error';
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body && body.error) {
        code = body.error.code || code;
        message = body.error.message || message;
      }
    } catch (ignored) {
      // 非 JSON 的错误体（例如框架层 404）只保留状态码。
    }
    throw new Error(`${code}: ${message}`);
  }
  if (response.status === 204) {
    return null;
  }
  const type = response.headers.get('content-type') || '';
  return type.includes('application/json') ? response.json() : response.text();
}

async function captureScreen() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: THUMBNAIL,
  });
  if (sources.length === 0) {
    throw new Error('no_screen: 没有可截取的屏幕');
  }
  const source = sources[0];
  const image = source.thumbnail;
  const size = image.getSize();
  const jpeg = image.toJPEG(JPEG_QUALITY);
  return {
    base64: jpeg.toString('base64'),
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: size.width,
    height: size.height,
    appTitle: source.name,
  };
}

async function captureIntoBuffer() {
  const settings = readSettings();
  if (settings.readonly) {
    throw new Error('readonly: 只读模式不能截图入缓冲区');
  }
  const shot = await captureScreen();
  const capture = await rest('POST', '/captures', {
    image_b64: shot.base64,
    source: 'shell',
    app_title: shot.appTitle,
    width: shot.width,
    height: shot.height,
  });
  return { capture, preview: shot.dataUrl };
}

function applyHotkey(settings) {
  globalShortcut.unregisterAll();
  if (settings.readonly) {
    return;
  }
  globalShortcut.register(HOTKEY, async () => {
    try {
      const payload = await captureIntoBuffer();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phonote:captured', payload);
      }
    } catch (error) {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('phonote:error', String(error.message || error));
      }
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    backgroundColor: '#12141a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();
  applyHotkey(readSettings());
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('phonote:config', () => readSettings());
ipcMain.handle('phonote:save-config', (_event, patch) => writeSettings(patch));
ipcMain.handle('phonote:rest', (_event, request) =>
  rest(request.method || 'GET', request.path, request.body),
);
ipcMain.handle('phonote:capture', () => captureIntoBuffer());
ipcMain.handle('phonote:pick-folder', async () => {
  const result = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('phonote:media-url', (_event, image) => {
  const settings = readSettings();
  const sha = String(image.sha256 || '');
  const mediaType = String(image.media_type || '');
  if (sha.length < 4 || !mediaType.startsWith('image/')) {
    return null;
  }
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[mediaType];
  if (!ext) {
    return null;
  }
  const target = path.join(settings.notesDir, 'media', sha.slice(0, 2), sha.slice(2, 4), `${sha}.${ext}`);
  return fs.existsSync(target) ? `file://${target.replace(/\\/g, '/')}` : null;
});

ipcMain.handle('phonote:open-folder', (_event, folder) => {
  const settings = readSettings();
  const target = folder === 'media' ? path.join(settings.notesDir, 'media') : settings.notesDir;
  shell.openPath(target);
});
