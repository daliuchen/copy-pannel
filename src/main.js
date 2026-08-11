const { app, BrowserWindow, Tray, Menu, clipboard, ipcMain, globalShortcut, nativeImage, protocol, screen } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_ITEMS = 500;
const POLL_INTERVAL_MS = 650;
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
let pollTimer;
let store;
let lastSignature = '';
let isRestoring = false;

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
    }
  } catch {
    await fs.mkdir(dataDir, { recursive: true });
    store = createEmptyStore();
    await persistStore();
  }
}

async function persistStore() {
  const { storePath } = getDataPaths();
  await fs.writeFile(storePath, JSON.stringify(store, null, 2));
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
      createdAt: nowIso(),
      favorite: false
    };
    item.title = buildTitle(item);
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
        createdAt: nowIso(),
        favorite: false
      };
      item.title = buildTitle(item);
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
      createdAt: nowIso(),
      favorite: false
    };
    item.title = buildTitle(item);
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
      store.items.unshift(existing);
    } else {
      store.items.unshift(snapshot.item);
    }

    store.items = store.items.slice(0, MAX_ITEMS);
    await persistStore();
    sendItems();
  } catch (error) {
    console.error('Failed to capture clipboard:', error);
  }
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

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 780,
    height: 560,
    minWidth: 680,
    minHeight: 480,
    title: 'Copy Pannel',
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
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
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, 'floating');
  }

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('blur', () => mainWindow.hide());
  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showPanel() {
  if (!mainWindow) return;
  positionPanelNearCursor();
  mainWindow.showInactive();
  mainWindow.webContents.focus();
  mainWindow.webContents.send('panel:opened');
  sendItems();
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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开剪贴板', click: showPanel },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showPanel);
}

function createTrayIcon() {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <rect x="8" y="6" width="16" height="22" rx="3" fill="#1f7a63"/>
      <rect x="12" y="4" width="8" height="5" rx="2" fill="#1f7a63"/>
      <rect x="11" y="13" width="10" height="2" rx="1" fill="#ffffff"/>
      <rect x="11" y="18" width="10" height="2" rx="1" fill="#ffffff"/>
    </svg>
  `;
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
ipcMain.handle('history:restore', async (_event, id) => restoreItem(id));
ipcMain.handle('panel:hide', () => {
  hidePanel();
  return true;
});
ipcMain.handle('history:toggleFavorite', async (_event, id) => {
  const item = getItem(id);
  if (!item) return false;
  item.favorite = !item.favorite;
  await persistStore();
  sendItems();
  return true;
});
ipcMain.handle('history:delete', async (_event, id) => {
  store.items = store.items.filter((item) => item.id !== id);
  await persistStore();
  sendItems();
  return true;
});
ipcMain.handle('history:clear', async () => {
  store.items = store.items.filter((item) => item.favorite);
  await persistStore();
  sendItems();
  return true;
});

app.whenReady().then(async () => {
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  await ensureStore();
  registerAssetProtocol();
  createWindow();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+V', showPanel);
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
