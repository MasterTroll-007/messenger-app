'use strict';

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  session,
  shell,
  Tray,
} = require('electron');
const { autoUpdater } = require('electron-updater');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  classifyNavigationUrl,
  getTitleUnreadHint,
  isAllowedAppUrl,
  isAllowedPermissionRequest,
  isExpectedNavigationAbort,
  isOwnedTemporaryFileName,
  normalizeRequestedMediaTypes,
  permitUnloadForApplicationQuit,
  shouldHandleUpdateAvailable,
  soundHeaderMatchesExtension,
  validateUnreadStatePayload,
} = require('./lib/main-policy');

const MESSENGER_URL = 'https://www.facebook.com/messages/';
const MESSENGER_PARTITION = 'persist:messenger';
const CUSTOM_PROTOCOL = 'messenger-asset';
const CUSTOM_SOUND_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a']);
const MAX_SOUND_BYTES = 10 * 1024 * 1024;
const SETTINGS_VERSION = 1;
const SETTINGS_FLUSH_TIMEOUT_MS = 5_000;
const UPDATE_DELAY_MS = 30_000;
const LOAD_RETRY_DELAYS_MS = [750, 2_000];

const userDataPath = path.join(app.getPath('appData'), 'MessengerApp');
const settingsPath = path.join(userDataPath, 'settings.json');

app.setPath('userData', userDataPath);

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

protocol.registerSchemesAsPrivileged([
  {
    scheme: CUSTOM_PROTOCOL,
    privileges: {
      bypassCSP: true,
      secure: true,
      standard: true,
      stream: true,
      supportFetchAPI: true,
    },
  },
]);

let mainWindow = null;
let tray = null;
let trayBaseIcon = null;
let isQuitting = false;
let isMuted = false;
let customSoundFile = null;
let currentUnreadCount = 0;
let currentBadgeIcon = null;
let lastAllowedAppUrl = MESSENGER_URL;
let settingsOperationQueue = Promise.resolve();
let settingsFlushPromise = null;
let quitFlushState = 'idle';
let restartPending = false;
let isSelectingSound = false;
let updateTimer = null;
let updatePhase = 'idle';
let updatePromptOpen = false;
let updateErrorPromptOpen = false;

const LEGACY_SOUND_FILE_PATTERN = /^notification-custom\.(mp3|wav|ogg|m4a)$/i;
const VERSIONED_SOUND_FILE_PATTERN = /^notification-custom-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(mp3|wav|ogg|m4a)$/i;

function isKnownSoundFileName(fileName) {
  return typeof fileName === 'string'
    && path.basename(fileName) === fileName
    && (LEGACY_SOUND_FILE_PATTERN.test(fileName) || VERSIONED_SOUND_FILE_PATTERN.test(fileName));
}

function findLegacyCustomSound() {
  for (const extension of CUSTOM_SOUND_EXTENSIONS) {
    const fileName = `notification-custom${extension}`;
    try {
      if (fs.statSync(path.join(userDataPath, fileName)).isFile()) return fileName;
    } catch {
      // Try the next legacy extension.
    }
  }
  return null;
}

function loadSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return;

    isMuted = data.muted === true;
    if (Object.prototype.hasOwnProperty.call(data, 'customSoundFile')) {
      customSoundFile = isKnownSoundFileName(data.customSoundFile)
        ? data.customSoundFile
        : null;
    } else {
      // Migrate older installs once. An explicit null means reset and must not
      // resurrect an old file left behind by a failed cleanup.
      customSoundFile = findLegacyCustomSound();
    }
  } catch {
    isMuted = false;
    customSoundFile = findLegacyCustomSound();
  }
}

async function writeSettingsAtomic() {
  await fs.promises.mkdir(userDataPath, { recursive: true });
  const temporaryPath = `${settingsPath}.${crypto.randomUUID()}.tmp`;
  const contents = JSON.stringify({
    version: SETTINGS_VERSION,
    muted: isMuted,
    customSoundFile,
  });

  let handle;
  try {
    handle = await fs.promises.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(temporaryPath, settingsPath);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function enqueueSettingsOperation(operation) {
  const result = settingsOperationQueue.then(operation);
  settingsOperationQueue = result.catch((error) => {
    console.error('Settings operation failed:', error.message);
  });
  return result;
}

function flushSettingsOperationsOnce() {
  if (settingsFlushPromise) return settingsFlushPromise;

  const pendingOperations = settingsOperationQueue;
  settingsFlushPromise = new Promise((resolve) => {
    let settled = false;
    const finish = (flushed) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(flushed);
    };
    const timeout = setTimeout(() => {
      console.warn('Timed out while flushing settings before exit.');
      finish(false);
    }, SETTINGS_FLUSH_TIMEOUT_MS);

    pendingOperations.then(
      () => finish(true),
      (error) => {
        console.error('Could not flush settings before exit:', error.message);
        finish(false);
      },
    );
  });
  return settingsFlushPromise;
}

async function removeStoredCustomSounds(exceptFile = null) {
  let entries;
  try {
    entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || entry.name === exceptFile || !isKnownSoundFileName(entry.name)) return;
    await fs.promises.unlink(path.join(userDataPath, entry.name)).catch(() => {});
  }));
}

async function removeOrphanedTemporaryFiles() {
  let entries;
  try {
    entries = await fs.promises.readdir(userDataPath, { withFileTypes: true });
  } catch {
    return;
  }

  await Promise.all(entries.map(async (entry) => {
    if (!entry.isFile() || !isOwnedTemporaryFileName(entry.name)) return;
    await fs.promises.unlink(path.join(userDataPath, entry.name)).catch(() => {});
  }));
}

function getLiveMainWindow() {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

function getLiveTray() {
  return tray && !tray.isDestroyed() ? tray : null;
}

function showMainWindow() {
  let win = getLiveMainWindow();
  if (!win && app.isReady() && !isQuitting) {
    try {
      win = createWindow();
    } catch (error) {
      console.error('Could not recreate the Messenger window:', error.message);
      return null;
    }
  }
  if (!win) return null;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  win.focus();
  return win;
}

function sendToMainWindow(channel, payload) {
  const win = getLiveMainWindow();
  if (!win || win.webContents.isDestroyed()) return;
  win.webContents.send(channel, payload);
}

function applyNativeUnreadState() {
  const win = getLiveMainWindow();
  const liveTray = getLiveTray();
  const hasUnread = currentUnreadCount > 0;
  const title = hasUnread ? `Messenger (${currentUnreadCount})` : 'Messenger';
  const tooltip = hasUnread
    ? `Messenger - ${currentUnreadCount} nepřečtených zpráv`
    : 'Messenger';

  if (win) {
    if (updatePhase !== 'downloading') win.setTitle(title);
    win.setOverlayIcon(hasUnread ? currentBadgeIcon : null, hasUnread ? tooltip : '');
  }

  if (liveTray) {
    if (hasUnread && currentBadgeIcon && !currentBadgeIcon.isEmpty()) {
      liveTray.setImage(currentBadgeIcon.resize({ width: 16, height: 16 }));
    } else if (trayBaseIcon && !trayBaseIcon.isEmpty()) {
      liveTray.setImage(trayBaseIcon);
    }
    liveTray.setToolTip(tooltip);
  }
}

function isTrustedMainFrameIpc(event) {
  const win = getLiveMainWindow();
  if (!win || event.sender !== win.webContents || event.sender.isDestroyed()) return false;

  const senderFrame = event.senderFrame;
  const mainFrame = win.webContents.mainFrame;
  if (!senderFrame || !mainFrame) return false;

  const isSameFrame = senderFrame === mainFrame
    || (senderFrame.processId === mainFrame.processId && senderFrame.routingId === mainFrame.routingId);
  return isSameFrame && isAllowedAppUrl(senderFrame.url || event.sender.getURL());
}

ipcMain.on('publish-unread-state', (event, rawPayload) => {
  if (!isTrustedMainFrameIpc(event)) return;

  const payload = validateUnreadStatePayload(rawPayload);
  if (!payload) return;

  let nextBadgeIcon = null;
  if (payload.badgeDataUrl) {
    let image;
    try {
      image = nativeImage.createFromDataURL(payload.badgeDataUrl);
      const size = image.getSize();
      if (image.isEmpty() || size.width < 1 || size.height < 1 || size.width > 64 || size.height > 64) {
        return;
      }
    } catch {
      return;
    }
    nextBadgeIcon = image;
  }

  currentUnreadCount = payload.count;
  currentBadgeIcon = payload.count > 0 ? nextBadgeIcon : null;
  applyNativeUnreadState();

  if (payload.notify && !isMuted) sendToMainWindow('play-notification-sound');
});

async function getNotificationSoundPath() {
  const candidates = [];
  if (isKnownSoundFileName(customSoundFile)) {
    candidates.push(path.join(userDataPath, customSoundFile));
  }
  if (app.isPackaged) candidates.push(path.join(process.resourcesPath, 'notification.mp3'));
  candidates.push(path.join(__dirname, 'assets', 'notification.mp3'));

  for (const candidate of candidates) {
    try {
      await validateSoundFile(candidate, path.extname(candidate).toLowerCase());
      return candidate;
    } catch {
      // A stale, corrupt, or legacy-mismatched custom sound falls through to
      // the bundled default instead of leaving notifications silent.
    }
  }
  return null;
}

function getNotificationSoundContentType(soundPath) {
  switch (path.extname(soundPath).toLowerCase()) {
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    default: return 'audio/mpeg';
  }
}

async function validateSoundFile(soundPath, extension) {
  const stat = await fs.promises.stat(soundPath);
  if (!stat.isFile() || stat.size < 4 || stat.size > MAX_SOUND_BYTES) {
    throw new Error('Sound file has an invalid size.');
  }

  const handle = await fs.promises.open(soundPath, 'r');
  try {
    const header = Buffer.alloc(32);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (!soundHeaderMatchesExtension(header.subarray(0, bytesRead), extension)) {
      throw new Error('Sound file content does not match its extension.');
    }
  } finally {
    await handle.close();
  }
}

async function copySoundFileBounded(sourcePath, destinationPath) {
  const source = await fs.promises.open(sourcePath, 'r');
  let destination;
  try {
    destination = await fs.promises.open(destinationPath, 'wx', 0o600);
    const chunk = Buffer.alloc(64 * 1024);
    let totalBytes = 0;

    while (true) {
      const { bytesRead } = await source.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_SOUND_BYTES) throw new Error('Sound file is too large.');

      let written = 0;
      while (written < bytesRead) {
        const result = await destination.write(chunk, written, bytesRead - written, null);
        if (result.bytesWritten < 1) throw new Error('Could not finish writing the sound file.');
        written += result.bytesWritten;
      }
    }

    if (totalBytes < 4) throw new Error('Sound file is empty.');
    await destination.sync();
  } finally {
    await source.close().catch(() => {});
    if (destination) await destination.close().catch(() => {});
  }
}

async function installCustomSound(sourcePath) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!CUSTOM_SOUND_EXTENSIONS.has(extension)) throw new Error('Unsupported sound extension.');
  await validateSoundFile(sourcePath, extension);

  await fs.promises.mkdir(userDataPath, { recursive: true });
  const nextFile = `notification-custom-${crypto.randomUUID()}${extension}`;
  const temporaryPath = path.join(userDataPath, `.${nextFile}.${crypto.randomUUID()}.tmp`);
  const destinationPath = path.join(userDataPath, nextFile);

  try {
    await copySoundFileBounded(sourcePath, temporaryPath);
    await validateSoundFile(temporaryPath, extension);
    await fs.promises.rename(temporaryPath, destinationPath);

    const previousFile = customSoundFile;
    customSoundFile = nextFile;
    try {
      // Persist the new pointer before deleting any prior sound.
      await writeSettingsAtomic();
    } catch (error) {
      customSoundFile = previousFile;
      await fs.promises.unlink(destinationPath).catch(() => {});
      throw error;
    }

    await removeStoredCustomSounds(nextFile);
    sendToMainWindow('notification-sound-updated');
  } catch (error) {
    await fs.promises.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function showSoundError() {
  const win = getLiveMainWindow();
  if (!win) return;
  await dialog.showMessageBox(win, {
    type: 'error',
    title: 'Chyba zvuku',
    message: 'Vybraný zvuk se nepodařilo bezpečně uložit.',
  }).catch(() => {});
}

async function selectNotificationSound() {
  if (isSelectingSound) return;
  const win = showMainWindow();
  if (!win) return;

  isSelectingSound = true;
  try {
    const result = await dialog.showOpenDialog(win, {
      title: 'Vyber zvuk oznámení',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
      properties: ['openFile'],
    });
    if (isQuitting || result.canceled || !result.filePaths[0]) return;

    await enqueueSettingsOperation(() => installCustomSound(result.filePaths[0]));
  } catch (error) {
    console.error('Custom sound install failed:', error.message);
    await showSoundError();
  } finally {
    isSelectingSound = false;
  }
}

function resetNotificationSound() {
  if (isQuitting) return;
  void enqueueSettingsOperation(async () => {
    const previousFile = customSoundFile;
    customSoundFile = null;
    try {
      // Explicit null prevents legacy files from being rediscovered on restart.
      await writeSettingsAtomic();
    } catch (error) {
      customSoundFile = previousFile;
      throw error;
    }
    await removeStoredCustomSounds();
    sendToMainWindow('notification-sound-updated');
  }).catch(() => {
    void showSoundError();
  });
}

function setMuted(nextMuted) {
  if (isQuitting) return;
  // Apply the user's choice synchronously so a notification in the same turn
  // cannot beat the settings write. Persistence remains serialized and atomic.
  isMuted = nextMuted === true;
  if (isMuted) sendToMainWindow('stop-notification-sound');
  rebuildMenus();
  void enqueueSettingsOperation(writeSettingsAtomic).catch(() => {});
}

function isExactSoundRequest(request) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return false;
  try {
    const url = new URL(request.url);
    if (
      url.protocol !== `${CUSTOM_PROTOCOL}:`
      || url.hostname !== 'notification'
      || url.pathname !== '/sound'
      || url.username
      || url.password
      || url.port
      || url.hash
    ) return false;

    const keys = [...url.searchParams.keys()];
    if (keys.length === 0) return true;
    return keys.length === 1
      && keys[0] === 'v'
      && /^\d{1,10}$/.test(url.searchParams.get('v') || '');
  } catch {
    return false;
  }
}

async function handleCustomAssetRequest(request) {
  if (!isExactSoundRequest(request)) {
    return new Response(null, { status: request.method === 'GET' || request.method === 'HEAD' ? 404 : 405 });
  }

  try {
    const soundPath = await getNotificationSoundPath();
    if (!soundPath) return new Response(null, { status: 404 });
    const handle = await fs.promises.open(soundPath, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOUND_BYTES) {
        return new Response(null, { status: 404 });
      }

      const headers = {
        'Cache-Control': 'no-store',
        'Content-Length': String(stat.size),
        'Content-Type': getNotificationSoundContentType(soundPath),
        'X-Content-Type-Options': 'nosniff',
      };
      if (request.method === 'HEAD') return new Response(null, { status: 200, headers });

      const contents = Buffer.alloc(stat.size);
      let offset = 0;
      while (offset < contents.length) {
        const { bytesRead } = await handle.read(contents, offset, contents.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }

      const overflowProbe = Buffer.alloc(1);
      const { bytesRead: overflowBytes } = await handle.read(overflowProbe, 0, 1, offset);
      if (offset !== stat.size || overflowBytes !== 0) return new Response(null, { status: 409 });
      return new Response(contents, { status: 200, headers });
    } finally {
      await handle.close();
    }
  } catch (error) {
    console.warn('Notification sound unavailable:', error.message);
    return new Response(null, { status: 404 });
  }
}

function openExternalSafely(rawUrl) {
  if (classifyNavigationUrl(rawUrl) !== 'external') return;
  void shell.openExternal(rawUrl).catch((error) => {
    console.warn('Could not open external URL:', error.message);
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadUrlWithRetry(win, url, retryDelays = LOAD_RETRY_DELAYS_MS) {
  if (!isAllowedAppUrl(url)) return false;
  for (let attempt = 0; attempt <= retryDelays.length; attempt += 1) {
    if (isQuitting || win.isDestroyed()) return false;
    try {
      await win.loadURL(url);
      return true;
    } catch (error) {
      if (isExpectedNavigationAbort(error)
        && isAllowedAppUrl(win.webContents.getURL())) {
        return true;
      }
      console.warn(`Messenger load attempt ${attempt + 1} failed:`, error.message);
      if (attempt === retryDelays.length) throw error;
      await delay(retryDelays[attempt]);
    }
  }
  return false;
}

function routePopupToMain(url) {
  const classification = classifyNavigationUrl(url);
  if (classification === 'external') {
    openExternalSafely(url);
  } else if (classification === 'internal') {
    const win = getLiveMainWindow();
    if (win) void loadUrlWithRetry(win, url, []).catch(() => {});
  }
}

function guardNavigation(event, legacyUrl, _legacyIsInPlace, legacyIsMainFrame) {
  const url = event.url || legacyUrl;
  const isMainFrame = typeof event.isMainFrame === 'boolean'
    ? event.isMainFrame
    : legacyIsMainFrame;
  // The host page legitimately uses cross-origin embedded frames. The main-frame
  // boundary is the one this app owns and can safely route.
  if (isMainFrame === false) return;

  const classification = classifyNavigationUrl(url);
  if (classification === 'internal') return;

  event.preventDefault();
  if (classification === 'external') openExternalSafely(url);
}

function recoverUnexpectedInPageNavigation(url, isMainFrame) {
  if (isMainFrame === false) return;
  const classification = classifyNavigationUrl(url);
  if (classification === 'internal') {
    lastAllowedAppUrl = url;
    return;
  }

  if (classification === 'external') openExternalSafely(url);
  const win = getLiveMainWindow();
  if (win) void loadUrlWithRetry(win, lastAllowedAppUrl, []).catch(() => {});
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 400,
    minHeight: 600,
    title: 'Messenger',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      partition: MESSENGER_PARTITION,
      autoplayPolicy: 'no-user-gesture-required',
    },
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: true,
  });
  mainWindow = win;

  const userAgent = win.webContents.getUserAgent()
    .replace(/Electron\/\S+\s/, '')
    .replace(/messenger-app\/\S+\s/, '');
  win.webContents.setUserAgent(userAgent);

  win.webContents.setWindowOpenHandler(({ url }) => {
    routePopupToMain(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-frame-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);
  win.webContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    recoverUnexpectedInPageNavigation(url, isMainFrame);
  });
  win.webContents.on('did-navigate', (_event, url) => {
    if (isAllowedAppUrl(url)) lastAllowedAppUrl = url;
  });
  win.webContents.on('will-prevent-unload', (event) => {
    permitUnloadForApplicationQuit(event, isQuitting);
  });

  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('title-unread-hint', getTitleUnreadHint(title));
    }
    applyNativeUnreadState();
  });

  win.once('ready-to-show', () => {
    if (!win.isDestroyed()) win.show();
  });

  win.on('close', (event) => {
    if (!isQuitting && getLiveTray()) {
      event.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  applyNativeUnreadState();
  void loadUrlWithRetry(win, MESSENGER_URL).catch((error) => {
    console.error('Messenger load failed:', error.message);
  });
  return win;
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  if (!fs.existsSync(iconPath)) {
    console.warn('No tray icon found; tray disabled.');
    return;
  }

  trayBaseIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (trayBaseIcon.isEmpty()) {
    console.warn('Tray icon is empty; tray disabled.');
    trayBaseIcon = null;
    return;
  }

  tray = new Tray(trayBaseIcon);
  tray.on('click', showMainWindow);
  updateTrayMenu();
  applyNativeUnreadState();
}

function updateTrayMenu() {
  const liveTray = getLiveTray();
  if (!liveTray) return;

  liveTray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Otevřít Messenger', click: showMainWindow },
    { type: 'separator' },
    {
      label: 'Ztlumit zvuky',
      type: 'checkbox',
      checked: isMuted,
      click: (menuItem) => setMuted(menuItem.checked),
    },
    { label: 'Změnit zvuk oznámení...', click: () => void selectNotificationSound() },
    { label: 'Výchozí zvuk oznámení', click: resetNotificationSound },
    { type: 'separator' },
    {
      label: 'Ukončit',
      click: requestApplicationQuit,
    },
  ]));
}

function createMenu() {
  const template = [
    {
      label: 'Soubor',
      submenu: [
        {
          label: 'Nový chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            const win = getLiveMainWindow();
            if (!win) return;
            void win.webContents.executeJavaScript(
              `document.querySelector('[aria-label="New message"], [aria-label="Nová zpráva"]')?.click();`,
              true,
            ).catch(() => {});
          },
        },
        { type: 'separator' },
        {
          label: 'Ztlumit zvuky',
          type: 'checkbox',
          checked: isMuted,
          accelerator: 'CmdOrCtrl+Shift+M',
          click: (menuItem) => setMuted(menuItem.checked),
        },
        { label: 'Změnit zvuk oznámení...', click: () => void selectNotificationSound() },
        { label: 'Výchozí zvuk oznámení', click: resetNotificationSound },
        { type: 'separator' },
        {
          label: 'Ukončit',
          accelerator: 'CmdOrCtrl+Q',
          click: requestApplicationQuit,
        },
      ],
    },
    {
      label: 'Upravit',
      submenu: [
        { role: 'undo', label: 'Zpět' },
        { role: 'redo', label: 'Vpřed' },
        { type: 'separator' },
        { role: 'cut', label: 'Vyjmout' },
        { role: 'copy', label: 'Kopírovat' },
        { role: 'paste', label: 'Vložit' },
        { role: 'selectAll', label: 'Vybrat vše' },
      ],
    },
    {
      label: 'Zobrazit',
      submenu: [
        { role: 'reload', label: 'Obnovit' },
        { role: 'forceReload', label: 'Vynutit obnovení' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'Přiblížit' },
        { role: 'zoomOut', label: 'Oddálit' },
        { role: 'resetZoom', label: 'Původní velikost' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Celá obrazovka' },
        { role: 'toggleDevTools', label: 'Vývojářské nástroje' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rebuildMenus() {
  createMenu();
  updateTrayMenu();
}

function cancelStartupUpdateCheck() {
  if (!updateTimer) return;
  clearTimeout(updateTimer);
  updateTimer = null;
}

function requestApplicationQuit() {
  if (isQuitting) return;
  isQuitting = true;
  cancelStartupUpdateCheck();
  app.quit();
}

async function restartForInstalledUpdate() {
  if (isQuitting) return;
  isQuitting = true;
  quitFlushState = 'flushing';
  cancelStartupUpdateCheck();
  await flushSettingsOperationsOnce();
  quitFlushState = 'complete';
  restartPending = true;

  try {
    autoUpdater.quitAndInstall(true, true);
    // BaseUpdater schedules app.quit() with setImmediate when installation starts.
    // Our before-quit handler clears restartPending first. If that never happens,
    // installation was rejected and the still-running app must become usable again.
    setImmediate(() => {
      if (!restartPending) return;
      const error = new Error('Instalátor aktualizace se nepodařilo spustit.');
      recoverFailedUpdateRestart(error);
      void showUpdateError(error);
    });
  } catch (error) {
    recoverFailedUpdateRestart(error);
    void showUpdateError(error);
  }
}

function recoverFailedUpdateRestart(error) {
  if (!restartPending) return false;
  restartPending = false;
  isQuitting = false;
  quitFlushState = 'idle';
  settingsFlushPromise = null;
  updatePhase = 'idle';
  showMainWindow();
  restoreNativeUpdateUi();
  console.error('Could not restart into the downloaded update:', error.message);
  return true;
}

function getPermissionRequestUrl(webContents, requestingOrigin, details = {}) {
  // Never replace an explicit untrusted requester with the trusted top-level URL.
  // Chromium omits requestingUrl for some checks, hence the ordered fallbacks.
  return details.requestingUrl
    || details.securityOrigin
    || requestingOrigin
    || webContents?.getURL()
    || '';
}

function configureSessionPermissions(messengerSession) {
  messengerSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details = {}) => (
    isAllowedPermissionRequest({
      permission,
      requestingUrl: getPermissionRequestUrl(webContents, requestingOrigin, details),
      isMainFrame: details.isMainFrame,
      mediaTypes: normalizeRequestedMediaTypes(details),
    })
  ));

  messengerSession.setPermissionRequestHandler((webContents, permission, callback, details = {}) => {
    const allowed = isAllowedPermissionRequest({
      permission,
      requestingUrl: getPermissionRequestUrl(webContents, '', details),
      isMainFrame: details.isMainFrame,
      mediaTypes: normalizeRequestedMediaTypes(details),
    });
    callback(allowed);
  });
}

function restoreNativeUpdateUi() {
  const win = getLiveMainWindow();
  if (win) win.setProgressBar(-1);
  applyNativeUnreadState();
}

async function promptForAvailableUpdate(info) {
  if (updatePromptOpen || isQuitting) return;
  const win = showMainWindow();
  if (!win) {
    updatePhase = 'idle';
    return;
  }

  updatePromptOpen = true;
  try {
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Nová verze k dispozici',
      message: `Je dostupná nová verze: v${info.version}`,
      buttons: ['Aktualizovat', 'Později'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0 || isQuitting || !getLiveMainWindow()) {
      updatePhase = 'idle';
      return;
    }

    updatePhase = 'downloading';
    const liveWindow = getLiveMainWindow();
    if (liveWindow) {
      liveWindow.setTitle('Messenger - Stahování aktualizace... 0%');
      liveWindow.setProgressBar(0);
    }
    await autoUpdater.downloadUpdate().catch((error) => {
      updatePhase = 'idle';
      restoreNativeUpdateUi();
      console.error('Update download failed:', error.message);
      void showUpdateError(error);
    });
  } catch (error) {
    updatePhase = 'idle';
    console.error('Update prompt failed:', error.message);
  } finally {
    updatePromptOpen = false;
  }
}

async function showUpdateError(error) {
  if (updateErrorPromptOpen || isQuitting) return;
  const win = getLiveMainWindow();
  if (!win) return;

  updateErrorPromptOpen = true;
  try {
    await dialog.showMessageBox(win, {
      type: 'error',
      title: 'Chyba aktualizace',
      message: `Aktualizace selhala: ${error.message}`,
      buttons: ['OK'],
      noLink: true,
    });
  } catch {
    // The window may have closed while the dialog was pending.
  } finally {
    updateErrorPromptOpen = false;
  }
}

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('checking-for-update', () => {
  updatePhase = 'checking';
  console.log('Updater: checking for updates...');
});
autoUpdater.on('update-not-available', () => {
  updatePhase = 'idle';
  console.log('Updater: no update available');
});
autoUpdater.on('update-available', (info) => {
  if (!shouldHandleUpdateAvailable({ isQuitting, updatePromptOpen, updatePhase })) {
    console.log('Updater: ignoring duplicate update-available event');
    return;
  }
  updatePhase = 'available';
  console.log('Updater: update available:', info.version);
  void promptForAvailableUpdate(info);
});
autoUpdater.on('download-progress', (progress) => {
  if (updatePhase !== 'downloading') return;
  const percent = Number.isFinite(progress.percent)
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : 0;
  const transferred = Number.isFinite(progress.transferred) ? Math.max(0, progress.transferred) : 0;
  const total = Number.isFinite(progress.total) ? Math.max(0, progress.total) : 0;
  const win = getLiveMainWindow();
  if (!win) return;
  win.setTitle(`Messenger - Stahování aktualizace... ${percent}% (${Math.round(transferred / 1048576)}/${Math.round(total / 1048576)} MB)`);
  win.setProgressBar(percent / 100);
});
autoUpdater.on('update-downloaded', () => {
  updatePhase = 'downloaded';
  restoreNativeUpdateUi();
  const win = showMainWindow();
  if (!win || isQuitting) return;

  void dialog.showMessageBox(win, {
    type: 'info',
    title: 'Aktualizace připravena',
    message: 'Aktualizace byla stažena. Aplikace se nyní restartuje.',
    buttons: ['OK'],
    noLink: true,
  }).then(() => {
    if (!isQuitting) void restartForInstalledUpdate();
  }).catch((error) => {
    console.error('Downloaded update prompt failed:', error.message);
  });
});
autoUpdater.on('error', (error) => {
  const failedPhase = updatePhase;
  const failedRestart = recoverFailedUpdateRestart(error);
  updatePhase = 'idle';
  restoreNativeUpdateUi();
  console.error('Updater error:', error.message);
  // Startup update checks are best-effort and should never interrupt the user.
  if (failedPhase === 'downloading' || failedRestart) void showUpdateError(error);
});

function scheduleStartupUpdateCheck() {
  if (!app.isPackaged || updateTimer || isQuitting) return;
  updateTimer = setTimeout(() => {
    updateTimer = null;
    if (isQuitting) return;
    void autoUpdater.checkForUpdates().catch((error) => {
      updatePhase = 'idle';
      console.error('Startup update check failed:', error.message);
    });
  }, UPDATE_DELAY_MS);
}

if (gotLock) {
  loadSettings();
  void enqueueSettingsOperation(removeOrphanedTemporaryFiles);

  app.on('second-instance', showMainWindow);

  app.whenReady().then(() => {
    const messengerSession = session.fromPartition(MESSENGER_PARTITION);
    configureSessionPermissions(messengerSession);
    messengerSession.protocol.handle(CUSTOM_PROTOCOL, handleCustomAssetRequest);

    createWindow();
    createTray();
    createMenu();
    scheduleStartupUpdateCheck();
  }).catch((error) => {
    console.error('Application startup failed:', error);
    app.quit();
  });

  app.on('before-quit', (event) => {
    // A successful quitAndInstall reaches here from its earlier setImmediate.
    // Clearing this flag prevents our later fallback from reviving quit state.
    restartPending = false;
    isQuitting = true;
    cancelStartupUpdateCheck();
    if (quitFlushState === 'complete') return;

    event.preventDefault();
    if (quitFlushState === 'flushing') return;
    quitFlushState = 'flushing';

    void flushSettingsOperationsOnce().finally(() => {
      quitFlushState = 'complete';
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });

  app.on('activate', showMainWindow);
}
