const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, globalShortcut, nativeImage, protocol, screen, powerMonitor } = require('electron');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const DEFAULT_SETTINGS = {
  maxItems: 500,
  clearSearchOnOpen: true
};
const POLL_INTERVAL_MS = 650;
const OCR_TIMEOUT_MS = 8000;
const GLOBAL_SHORTCUT = 'CommandOrControl+Shift+V';
// 显示后短暂忽略 blur：避免在别的 app 上唤醒时，面板拿到 key 焦点又被系统弹回而立即隐藏
const SHOW_BLUR_GRACE_MS = 300;
const MEDIA_EXTENSIONS = new Set([
  '.avi',
  '.m4v',
  '.mov',
  '.mp4',
  '.mpeg',
  '.mpg',
  '.webm',
  '.mkv',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.tiff',
  '.bmp'
]);

let mainWindow;
let tray;
let trayMenu;
let pollTimer;
let store;
let lastSignature = '';
let isRestoring = false;
let panelShownAt = 0;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'clip-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true
    }
  }
]);

function createEmptyStore() {
  return {
    version: 1,
    settings: { ...DEFAULT_SETTINGS },
    items: []
  };
}

function getDataPaths() {
  const dataDir = path.join(app.getPath('userData'), 'clipboard-data');
  return {
    dataDir,
    assetsDir: path.join(dataDir, 'assets'),
    storePath: path.join(dataDir, 'history.json')
  };
}

async function ensureStore() {
  const { dataDir, assetsDir, storePath } = getDataPaths();
  await fs.mkdir(assetsDir, { recursive: true });
  try {
    const raw = await fs.readFile(storePath, 'utf8');
    store = JSON.parse(raw);
    if (!store || !Array.isArray(store.items)) {
      store = createEmptyStore();
    } else {
      store.settings = normalizeSettings(store.settings);
    }
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    store = createEmptyStore();
    await persistStore();
  }
}

function normalizeSettings(settings = {}) {
  return {
    ...DEFAULT_SETTINGS,
    ...settings,
    maxItems: clampMaxItems(settings.maxItems ?? DEFAULT_SETTINGS.maxItems)
  };
}

function clampMaxItems(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.maxItems;
  return Math.max(50, Math.min(parsed, 5000));
}

async function persistStore() {
  const { storePath } = getDataPaths();
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
}

async function deleteAsset(assetName) {
  if (!assetName || isAssetReferenced(assetName)) return;

  const { assetsDir } = getDataPaths();
  try {
    await fs.unlink(path.join(assetsDir, assetName));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error('Failed to delete clipboard asset:', error);
    }
  }
}

function isAssetReferenced(assetName) {
  return store.items.some((item) => item.type === 'image' && item.assetName === assetName);
}

async function cleanupOrphanAssets() {
  const { assetsDir } = getDataPaths();
  const referencedAssets = new Set(
    store.items
      .filter((item) => item.type === 'image' && item.assetName)
      .map((item) => item.assetName)
  );

  let assetNames = [];
  try {
    assetNames = await fs.readdir(assetsDir);
  } catch {
    return;
  }

  await Promise.all(
    assetNames
      .filter((assetName) => assetName.endsWith('.png') && !referencedAssets.has(assetName))
      .map((assetName) => fs.unlink(path.join(assetsDir, assetName)).catch(() => {}))
  );
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function humanTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function normalizeFileUrl(raw) {
  if (!raw) return null;
  const cleaned = raw.toString('utf8').replace(/\0/g, '').trim();
  if (!cleaned) return null;

  try {
    const url = new URL(cleaned);
    if (url.protocol === 'file:') {
      return decodeURIComponent(url.pathname);
    }
  } catch {
    // Some apps place a plain path on the pasteboard.
  }

  if (cleaned.startsWith('/')) {
    return cleaned;
  }

  return null;
}

function readClipboardFilePaths() {
  const formats = clipboard.availableFormats();
  const candidates = [];

  for (const format of formats) {
    if (
      format.includes('public.file-url') ||
      format.includes('NSFilenamesPboardType') ||
      format.includes('FileNameW') ||
      format.includes('text/uri-list')
    ) {
      const buffer = clipboard.readBuffer(format);
      if (buffer.length > 0) {
        const text = buffer.toString('utf8');
        const lines = text.split(/\r?\n/).filter(Boolean);
        for (const line of lines) {
          const normalized = normalizeFileUrl(line);
          if (normalized) candidates.push(normalized);
        }
      }

      const direct = clipboard.read(format);
      const normalized = normalizeFileUrl(direct);
      if (normalized) candidates.push(normalized);
    }
  }

  return [...new Set(candidates)];
}

function inferFileKind(filePaths) {
  const extensions = filePaths.map((filePath) => path.extname(filePath).toLowerCase());
  if (extensions.some((extension) => ['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi'].includes(extension))) {
    return 'video';
  }
  if (extensions.some((extension) => ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.tiff', '.bmp'].includes(extension))) {
    return 'image-file';
  }
  if (extensions.some((extension) => MEDIA_EXTENSIONS.has(extension))) {
    return 'media-file';
  }
  return 'file';
}

function buildTitle(item) {
  if (item.type === 'text') {
    return item.text.replace(/\s+/g, ' ').trim().slice(0, 90) || '空文本';
  }
  if (item.type === 'image') {
    return `图片 ${item.width}x${item.height}`;
  }
  if (item.filePaths?.length) {
    if (item.filePaths.length === 1) {
      return path.basename(item.filePaths[0]);
    }
    return `${path.basename(item.filePaths[0])} 等 ${item.filePaths.length} 个文件`;
  }
  return '剪贴板内容';
}

function buildSearchableText(item) {
  const imageDescription = item.type === 'image' ? `图片 ${item.width}x${item.height}` : '';
  return [item.title, imageDescription, item.ocrText, item.text, ...(item.filePaths || [])]
    .filter(Boolean)
    .join('\n');
}

function getOcrHelperPath() {
  if (process.platform !== 'darwin') return null;
  if (app.isPackaged) return path.join(process.resourcesPath, 'ocr-helper');

  const localHelperPath = path.join(__dirname, '..', 'resources', 'ocr-helper');
  if (fsSync.existsSync(localHelperPath)) return localHelperPath;
  return null;
}

function runOcr(imagePath) {
  return new Promise((resolve) => {
    const helperPath = getOcrHelperPath();
    if (!helperPath || !fsSync.existsSync(helperPath)) {
      resolve({ status: 'unavailable', text: '', lines: [] });
      return;
    }

    childProcess.execFile(
      helperPath,
      [imagePath],
      {
        timeout: OCR_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 4
      },
      (error, stdout) => {
        if (error) {
          console.error('Failed to run OCR:', error);
          resolve({ status: 'failed', text: '', lines: [] });
          return;
        }

        try {
          const result = JSON.parse(stdout);
          const text = String(result.text || '').trim();
          resolve({
            status: text ? 'ready' : 'empty',
            text,
            lines: Array.isArray(result.lines) ? result.lines : []
          });
        } catch (parseError) {
          console.error('Failed to parse OCR output:', parseError);
          resolve({ status: 'failed', text: '', lines: [] });
        }
      }
    );
  });
}

async function applyOcr(item, imagePath) {
  const result = await runOcr(imagePath);
  item.ocrStatus = result.status;
  item.ocrText = result.text;
  item.ocrLines = result.lines;
  item.searchableText = buildSearchableText(item);
}

async function readCurrentClipboardItem() {
  const filePaths = readClipboardFilePaths();
  if (filePaths.length > 0) {
    const joined = filePaths.join('\n');
    const kind = inferFileKind(filePaths);
    const item = {
      id: crypto.randomUUID(),
      type: kind,
      filePaths,
      title: '',
      searchableText: joined,
      createdAt: nowIso()
    };
    item.title = buildTitle(item);
    if (kind === 'image-file' && filePaths.length === 1) {
      await applyOcr(item, filePaths[0]);
    } else {
      item.searchableText = buildSearchableText(item);
    }
    return {
      signature: `${kind}:${hashBuffer(Buffer.from(joined))}`,
      item
    };
  }

  const image = clipboard.readImage();
  if (!image.isEmpty()) {
    const png = image.toPNG();
    if (png.length > 0) {
      const digest = hashBuffer(png);
      const { assetsDir } = getDataPaths();
      const assetName = `${digest}.png`;
      const assetPath = path.join(assetsDir, assetName);
      await fs.writeFile(assetPath, png);

      const size = image.getSize();
      const item = {
        id: crypto.randomUUID(),
        type: 'image',
        assetName,
        width: size.width,
        height: size.height,
        title: '',
        searchableText: `图片 ${size.width}x${size.height}`,
        createdAt: nowIso()
      };
      item.title = buildTitle(item);
      await applyOcr(item, assetPath);
      return {
        signature: `image:${digest}`,
        item
      };
    }
  }

  const text = clipboard.readText().trim();
  if (text) {
    const item = {
      id: crypto.randomUUID(),
      type: 'text',
      text,
      title: '',
      searchableText: text,
      createdAt: nowIso()
    };
    item.title = buildTitle(item);
    item.searchableText = buildSearchableText(item);
    return {
      signature: `text:${hashBuffer(Buffer.from(text))}`,
      item
    };
  }

  return null;
}

async function captureClipboard() {
  if (isRestoring) return;

  try {
    const snapshot = await readCurrentClipboardItem();
    if (!snapshot || snapshot.signature === lastSignature) return;

    lastSignature = snapshot.signature;
    const duplicateIndex = store.items.findIndex((item) => {
      if (item.type !== snapshot.item.type) return false;
      if (item.type === 'text') return item.text === snapshot.item.text;
      if (item.type === 'image') return item.assetName === snapshot.item.assetName;
      return JSON.stringify(item.filePaths) === JSON.stringify(snapshot.item.filePaths);
    });

    if (duplicateIndex >= 0) {
      const [existing] = store.items.splice(duplicateIndex, 1);
      existing.createdAt = nowIso();
      if (snapshot.item.ocrText && !existing.ocrText) {
        existing.ocrStatus = snapshot.item.ocrStatus;
        existing.ocrText = snapshot.item.ocrText;
        existing.ocrLines = snapshot.item.ocrLines;
        existing.searchableText = buildSearchableText(existing);
      }
      store.items.unshift(existing);
    } else {
      store.items.unshift(snapshot.item);
    }

    const removedItems = trimHistory();
    await persistStore();
    await cleanupRemovedAssets(removedItems);
    sendItems();
  } catch (error) {
    console.error('Failed to capture clipboard:', error);
  }
}

function trimHistory() {
  const removedItems = [];
  while (store.items.length > store.settings.maxItems) {
    const removableIndex = store.items.length - 1;
    const [removedItem] = store.items.splice(removableIndex, 1);
    removedItems.push(removedItem);
  }
  return removedItems;
}

async function cleanupRemovedAssets(items) {
  const assetNames = items
    .filter((item) => item.type === 'image' && item.assetName)
    .map((item) => item.assetName);

  await Promise.all(assetNames.map((assetName) => deleteAsset(assetName)));
}

function presentItem(item) {
  return {
    ...item,
    createdLabel: humanTime(item.createdAt),
    previewUrl: item.type === 'image' ? `clip-asset://${item.assetName}` : null
  };
}

function sendItems() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('history:changed', store.items.map(presentItem));
  }
}

function sendSettings() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings:changed', store.settings);
  }
}

function getItem(id) {
  return store.items.find((item) => item.id === id);
}

async function restoreItem(id) {
  const item = getItem(id);
  if (!item) return false;

  isRestoring = true;
  try {
    if (item.type === 'text') {
      clipboard.writeText(item.text);
    } else if (item.type === 'image') {
      const { assetsDir } = getDataPaths();
      const imagePath = path.join(assetsDir, item.assetName);
      const image = nativeImage.createFromPath(imagePath);
      if (!image.isEmpty()) clipboard.writeImage(image);
    } else if (item.filePaths?.length) {
      const firstPath = item.filePaths[0];
      const fileUrl = `file://${encodeURI(firstPath)}`;
      clipboard.writeBuffer('public.file-url', Buffer.from(fileUrl, 'utf8'));
      clipboard.writeText(firstPath);
    }

    item.createdAt = nowIso();
    store.items = [item, ...store.items.filter((candidate) => candidate.id !== id)];
    await persistStore();
    lastSignature = '';
    sendItems();
    return true;
  } finally {
    setTimeout(() => {
      isRestoring = false;
    }, 300);
  }
}

async function copyOcrText(id) {
  const item = getItem(id);
  if (!item?.ocrText) return false;
  clipboard.writeText(item.ocrText);
  return true;
}

async function pasteItem(id) {
  const restored = await restoreItem(id);
  if (!restored) return false;

  hidePanel();
  setTimeout(sendPasteShortcut, 80);
  return true;
}

function sendPasteShortcut() {
  if (process.platform !== 'darwin') return;

  childProcess.execFile(
    'osascript',
    ['-e', 'tell application "System Events" to keystroke "v" using command down'],
    (error) => {
      if (error) {
        console.error('Failed to send paste shortcut:', error);
      }
    }
  );
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 680,
    minHeight: 480,
    title: 'Copy Pannel',
    icon: path.join(__dirname, '..', 'assets', 'app-icon.svg'),
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    acceptFirstMouse: true,
    focusable: true,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (process.platform === 'darwin') {
    keepPanelAboveFullscreen();
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('blur', () => {
    if (!mainWindow || !mainWindow.isVisible()) return;
    // 刚显示时系统可能把焦点弹回原前台 app，触发一次伪 blur —— 忽略它，否则面板会闪一下就消失
    if (Date.now() - panelShownAt < SHOW_BLUR_GRACE_MS) return;
    mainWindow.hide();
  });
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showPanel() {
  if (!mainWindow) return;
  // 先标记显示时刻，覆盖住 showInactive/focus 期间可能产生的伪 blur
  panelShownAt = Date.now();
  // 先确定层级与位置，再显示，避免竞态导致不出现在当前 Space/全屏之上
  keepPanelAboveFullscreen();
  positionPanelNearCursor();
  mainWindow.showInactive();
  if (process.platform === 'darwin') {
    mainWindow.moveTop();
  }
  keepPanelAboveFullscreen();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('panel:opened');
  sendItems();
}

function keepPanelAboveFullscreen() {
  if (process.platform !== 'darwin' || !mainWindow) return;

  mainWindow.setVisibleOnAllWorkspaces(true, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver', 1);
}

function positionPanelNearCursor() {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const workArea = display.workArea;
  const [width, height] = mainWindow.getSize();
  const gap = 14;

  let x = cursor.x + gap;
  let y = cursor.y + gap;

  if (x + width > workArea.x + workArea.width) {
    x = cursor.x - width - gap;
  }
  if (y + height > workArea.y + workArea.height) {
    y = cursor.y - height - gap;
  }

  x = Math.max(workArea.x + gap, Math.min(x, workArea.x + workArea.width - width - gap));
  y = Math.max(workArea.y + gap, Math.min(y, workArea.y + workArea.height - height - gap));

  mainWindow.setPosition(Math.round(x), Math.round(y), false);
}

function hidePanel() {
  if (!mainWindow) return;
  mainWindow.hide();
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible()) hidePanel();
  else showPanel();
}

function createTray() {
  tray = new Tray(createTrayIcon());
  tray.setToolTip('Copy Pannel');
  trayMenu = Menu.buildFromTemplate([
    { label: '打开剪贴板', click: showPanel },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(trayMenu);
  tray.on('click', showPanel);
}

function createTrayIcon() {
  const svg = fsSync.readFileSync(path.join(__dirname, '..', 'assets', 'app-icon.svg'), 'utf8');
  const icon = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
  icon.setTemplateImage(true);
  return icon.resize({ width: 18, height: 18 });
}

function registerAssetProtocol() {
  protocol.handle('clip-asset', async (request) => {
    const url = new URL(request.url);
    const assetName = path.basename(url.hostname || url.pathname);
    const { assetsDir } = getDataPaths();
    return new Response(await fs.readFile(path.join(assetsDir, assetName)), {
      headers: {
        'content-type': 'image/png'
      }
    });
  });
}

ipcMain.handle('history:list', () => store.items.map(presentItem));
ipcMain.handle('settings:get', () => store.settings);
ipcMain.handle('settings:update', async (_event, nextSettings) => {
  store.settings = normalizeSettings({
    ...store.settings,
    ...nextSettings
  });
  const removedItems = trimHistory();
  await persistStore();
  await cleanupRemovedAssets(removedItems);
  sendSettings();
  sendItems();
  return store.settings;
});
ipcMain.handle('history:restore', async (_event, id) => restoreItem(id));
ipcMain.handle('history:paste', async (_event, id) => pasteItem(id));
ipcMain.handle('history:copy-ocr', async (_event, id) => copyOcrText(id));
ipcMain.handle('panel:hide', () => {
  hidePanel();
  return true;
});
ipcMain.handle('history:delete', async (_event, id) => {
  const removedItem = getItem(id);
  store.items = store.items.filter((item) => item.id !== id);
  await persistStore();
  await cleanupRemovedAssets(removedItem ? [removedItem] : []);
  sendItems();
  return true;
});
ipcMain.handle('history:clear', async () => {
  const removedItems = store.items;
  store.items = [];
  await persistStore();
  await cleanupRemovedAssets(removedItems);
  sendItems();
  return true;
});

function registerGlobalShortcut() {
  if (globalShortcut.isRegistered(GLOBAL_SHORTCUT)) return true;
  const ok = globalShortcut.register(GLOBAL_SHORTCUT, showPanel);
  if (!ok) {
    console.warn(`[copy-pannel] 全局快捷键注册失败（可能被其他应用占用）: ${GLOBAL_SHORTCUT}`);
  }
  return ok;
}

// 单实例锁：避免多个实例同时抢注全局快捷键导致「快捷键没反应」
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
}
// 再次启动时，交给已有实例把面板唤起
app.on('second-instance', () => showPanel());

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  if (process.platform === 'darwin') {
    app.setActivationPolicy('accessory');
    app.dock.hide();
  }

  await ensureStore();
  await cleanupOrphanAssets();
  registerAssetProtocol();
  createWindow();
  createTray();

  registerGlobalShortcut();
  // 睡眠唤醒后全局快捷键可能失效，重新注册一次
  powerMonitor.on('resume', registerGlobalShortcut);
  pollTimer = setInterval(captureClipboard, POLL_INTERVAL_MS);
  await captureClipboard();
});

app.on('activate', showPanel);

app.on('window-all-closed', (event) => {
  event.preventDefault();
});

app.on('before-quit', () => {
  app.isQuitting = true;
  if (pollTimer) clearInterval(pollTimer);
  globalShortcut.unregisterAll();
});
