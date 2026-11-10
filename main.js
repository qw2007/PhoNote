// PhoNote 桌面壳（P0）。
//
// 职责只有三件：全局热键截图、把图片交给平台、把平台的数据画出来。
// 业务规则一律不在壳里——树怎么长、笔记怎么组，都是插件的工具说了算。
//
// 进程分工：主进程持有 HTTP 客户端与截图能力（渲染进程访问不了 desktopCapturer，
// 也不该拥有 API key）；渲染进程只通过 preload 暴露的三个方法说话。

const { app, BrowserWindow, desktopCapturer, globalShortcut, ipcMain, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  apiBase: 'http://127.0.0.1:8000',
  apiKey: '',
  notesDir: path.join(process.env.USERPROFILE || process.env.HOME || '.', 'PhoNote'),
};

//: 截图的落盘尺寸上限。设计文档定的是长边 1600；desktopCapturer 会等比缩到这个框里。
const THUMBNAIL = { width: 1600, height: 1600 };
//: JPEG 质量：网课画面以文字为主，85 在 1600px 下通常 200–400 KB。
const JPEG_QUALITY = 85;

let mainWindow = null;

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

async function callTool(tool, args) {
  const settings = loadSettings();
  const response = await fetch(`${settings.apiBase}/v1/tools/execute`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(settings.apiKey ? { 'X-API-Key': settings.apiKey } : {}),
    },
    body: JSON.stringify({ tool, arguments: args }),
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = payload?.error ?? {};
    throw new Error(`${error.code || response.status}: ${error.message || '调用失败'}`);
  }
  return payload.result;
}

async function captureScreen() {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: THUMBNAIL,
  });
  if (sources.length === 0) {
    throw new Error('没有可截取的屏幕');
  }
  // 多屏时取第一个；P1 会按鼠标所在显示器挑。
  const source = sources[0];
  const image = source.thumbnail;
  if (image.isEmpty()) {
    throw new Error('截取的画面是空的（可能是受保护窗口）');
  }
  const { width, height } = image.getSize();
  const jpeg = image.toJPEG(JPEG_QUALITY).toString('base64');
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg}`,
    base64: jpeg,
    width,
    height,
    displayId: source.display_id,
    appTitle: source.name,
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 860,
    minHeight: 520,
    title: 'PhoNote',
    backgroundColor: '#0f1115',
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

  // Ctrl+Shift+S：截图 → 上传 → 通知渲染进程刷新图片区。
  const accelerator = 'Control+Shift+S';
  const registered = globalShortcut.register(accelerator, async () => {
    try {
      const shot = await captureScreen();
      const capture = await callTool('note_add_capture', {
        image_b64: shot.base64,
        source: 'shell',
        app_title: shot.appTitle,
        width: shot.width,
        height: shot.height,
      });
      mainWindow?.webContents.send('phonote:captured', {
        capture,
        preview: shot.dataUrl,
      });
    } catch (error) {
      mainWindow?.webContents.send('phonote:error', String(error.message || error));
    }
  });
  if (!registered) {
    console.warn(`热键 ${accelerator} 注册失败：可能被别的程序占用`);
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('phonote:config', () => {
  const settings = loadSettings();
  return {
    apiBase: settings.apiBase,
    notesDir: settings.notesDir,
    hasApiKey: Boolean(settings.apiKey),
  };
});

ipcMain.handle('phonote:save-config', (_event, patch) => {
  saveSettings({ ...loadSettings(), ...patch });
  return { apiBase: loadSettings().apiBase, notesDir: loadSettings().notesDir };
});

ipcMain.handle('phonote:call', async (_event, { tool, args }) => callTool(tool, args));

ipcMain.handle('phonote:capture', async () => {
  const shot = await captureScreen();
  const capture = await callTool('note_add_capture', {
    image_b64: shot.base64,
    source: 'shell',
    app_title: shot.appTitle,
    width: shot.width,
    height: shot.height,
  });
  return { capture, preview: shot.dataUrl };
});

// 媒体文件由壳直接读盘（平台与壳在同一台机器上）：P0 还没有 /captures/{id}/image 端点。
ipcMain.handle('phonote:media-url', (_event, { sha256, mediaType }) => {
  const settings = loadSettings();
  const suffix = mediaType === 'image/png' ? '.png' : mediaType === 'image/webp' ? '.webp' : '.jpg';
  const file = path.join(settings.notesDir, 'media', sha256.slice(0, 2), sha256.slice(2, 4), `${sha256}${suffix}`);
  return fs.existsSync(file) ? `file://${file.replace(/\\/g, '/')}` : null;
});

ipcMain.handle('phonote:open-folder', () => {
  shell.openPath(loadSettings().notesDir);
});
