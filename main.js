'use strict';

const { app, BrowserWindow, dialog, desktopCapturer, globalShortcut, ipcMain, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const DEFAULT_HOTKEY = 'Control+Alt+P';
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
  // 打包版自带后端（phonote-backend.exe）：勾着就不用另外起平台。
  bundleBackend: true,
  // 截图热键（Electron accelerator 语法）。可 DIY：设置里录制新组合。
  hotkey: DEFAULT_HOTKEY,
  // AI 设置：直接映射到后端的 DRIVER_NOTES_LLM*，改完会自动重启本机服务。
  aiMode: 'off',
  aiBaseUrl: '',
  aiApiKey: '',
  aiModel: '',
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

// ---------------------------------------------------------------- 内置后端

const backend = { child: null, port: null, base: null, status: 'stopped', error: null };

function backendExe() {
  if (!app.isPackaged) {
    return null;
  }
  return path.join(process.resourcesPath, 'app', 'backend', 'bin', 'phonote-backend.exe');
}

function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        return true;
      }
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last || new Error('backend_timeout: 本地服务启动超时');
}

function backendArgs(settings, port) {
  const args = ['--port', String(port), '--data-dir', settings.notesDir];
  if (settings.aiMode && settings.aiMode !== 'off') {
    args.push('--ai-mode', settings.aiMode);
    if (settings.aiBaseUrl) {
      args.push('--ai-base-url', settings.aiBaseUrl);
    }
    if (settings.aiApiKey) {
      args.push('--ai-api-key', settings.aiApiKey);
    }
    if (settings.aiModel) {
      args.push('--ai-model', settings.aiModel);
    }
  }
  return args;
}

function serverStatus() {
  return { status: backend.status, port: backend.port, base: backend.base, error: backend.error };
}

function sendServer() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('phonote:server', serverStatus());
  }
}

async function startBackend(settings) {
  const exe = backendExe();
  if (!exe || settings.bundleBackend === false) {
    backend.status = 'external';
    return backend;
  }
  if (!fs.existsSync(exe)) {
    backend.status = 'error';
    backend.error = `backend_missing: ${exe}`;
    return backend;
  }
  const port = await pickPort();
  const child = spawn(exe, backendArgs(settings, port), { windowsHide: true });
  child.stdout.on('data', (chunk) => console.log('[backend]', String(chunk).trim()));
  child.stderr.on('data', (chunk) => console.error('[backend]', String(chunk).trim()));
  child.on('exit', (code) => {
    if (backend.child === child) {
      backend.child = null;
      backend.base = null;
      backend.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0) {
        backend.error = `backend_exit: ${code}`;
      }
      sendServer();
    }
  });
  backend.child = child;
  backend.port = port;
  backend.base = `http://127.0.0.1:${port}`;
  backend.status = 'starting';
  backend.error = null;
  await waitForHealth(backend.base);
  backend.status = 'ready';
  return backend;
}

async function stopBackend() {
  const child = backend.child;
  backend.child = null;
  backend.base = null;
  backend.port = null;
  backend.status = 'stopped';
  if (child && child.exitCode === null) {
    child.kill();
  }
}

async function restartBackend(settings) {
  await stopBackend();
  try {
    await startBackend(settings);
  } catch (error) {
    backend.status = 'error';
    backend.error = String(error.message || error);
  }
  sendServer();
}

function baseUrl() {
  const fallback = readSettings().apiBase;
  return (backend.base || fallback).replace(/\/+$/, '');
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
  const base = baseUrl();
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

// 热键状态：注册失败（被别的程序占用）要能告诉用户，而不是静默失灵。
let hotkeyState = { accelerator: DEFAULT_HOTKEY, registered: false, error: null };

function applyHotkey(settings) {
  globalShortcut.unregisterAll();
  const accelerator = settings.hotkey || DEFAULT_HOTKEY;
  hotkeyState = { accelerator, registered: false, error: null };
  if (settings.readonly) {
    hotkeyState.error = 'readonly: 只读模式不注册热键';
    return hotkeyState;
  }
  try {
    const ok = globalShortcut.register(accelerator, async () => {
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
    hotkeyState.registered = ok;
    if (!ok) {
      hotkeyState.error = `hotkey_taken: ${accelerator} 被别的程序占用，换一个组合`;
    }
  } catch {
    hotkeyState.error = `hotkey_invalid: ${accelerator} 不是合法组合（需要修饰键 + 一个键）`;
  }
  return hotkeyState;
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

app.whenReady().then(async () => {
  const settings = readSettings();
  try {
    await startBackend(settings);
  } catch (error) {
    backend.status = 'error';
    backend.error = String(error.message || error);
  }
  createWindow();
  applyHotkey(settings);
  sendServer();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopBackend();
  backend.child = null;
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

ipcMain.handle('phonote:config', () => readSettings());
ipcMain.handle('phonote:save-config', async (_event, patch) => {
  const before = readSettings();
  const next = writeSettings(patch);
  const keys = ['bundleBackend', 'aiMode', 'aiBaseUrl', 'aiApiKey', 'aiModel', 'notesDir'];
  const changed = keys.some((key) => before[key] !== next[key]);
  if (changed) {
    await restartBackend(next);
  }
  return next;
});
ipcMain.handle('phonote:server-status', () => serverStatus());
ipcMain.handle('phonote:hotkey-status', () => hotkeyState);
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
