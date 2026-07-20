const { app, BrowserWindow, shell, Menu, Tray, nativeImage, session, ipcMain, dialog, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Store user data in a fixed location (not temp) so login persists
const userDataPath = path.join(app.getPath('appData'), 'MessengerApp');
app.setPath('userData', userDataPath);

// Prevent multiple instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

// Register custom protocol before app ready (bypasses CSP for local audio)
protocol.registerSchemesAsPrivileged([
  { scheme: 'messenger-asset', privileges: { bypassCSP: true, stream: true } }
]);

let mainWindow;
let tray;
let trayBaseIcon;
let isQuitting = false;
let isMuted = false;
let customSoundFile = null;
let isSelectingSound = false;

const CUSTOM_SOUND_EXTENSIONS = ['.mp3', '.wav', '.ogg', '.m4a'];

// Settings persistence
const settingsPath = path.join(userDataPath, 'settings.json');

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const data = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      isMuted = !!data.muted;
      if (
        typeof data.customSoundFile === 'string'
        && path.basename(data.customSoundFile) === data.customSoundFile
        && /^notification-custom\.(mp3|wav|ogg|m4a)$/i.test(data.customSoundFile)
      ) {
        customSoundFile = data.customSoundFile;
      }
    }
  } catch { /* ignore */ }
}

function saveSettings() {
  try {
    let data = {};
    try { data = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* ignore */ }
    data.muted = isMuted;
    data.customSoundFile = customSoundFile;
    fs.writeFileSync(settingsPath, JSON.stringify(data));
  } catch { /* ignore */ }
}

function removeCustomSoundFiles(exceptFile = null) {
  for (const extension of CUSTOM_SOUND_EXTENSIONS) {
    const fileName = `notification-custom${extension}`;
    if (fileName === exceptFile) continue;

    const soundPath = path.join(userDataPath, fileName);
    try {
      if (fs.existsSync(soundPath)) fs.unlinkSync(soundPath);
    } catch { /* ignore */ }
  }
}

// Meta retired the standalone messenger.com web app in favor of Facebook Messages.
const MESSENGER_URL = 'https://www.facebook.com/messages/';
const MESSENGER_PARTITION = 'persist:messenger';

const LEGACY_MESSENGER_HOSTS = new Set(['messenger.com', 'www.messenger.com']);
const FACEBOOK_HOSTS = new Set(['facebook.com', 'www.facebook.com']);
const FACEBOOK_APP_PATHS = [
  /^\/messages(?:\/|$)/,
  /^\/login(?:\.php|\/|$)/,
  /^\/checkpoint(?:\/|$)/,
  /^\/recover(?:\/|$)/,
  /^\/two_step_verification(?:\/|$)/,
  /^\/auth_platform(?:\/|$)/,
  /^\/privacy\/consent(?:\/|$)/,
  /^\/cookie\/consent(?:\/|$)/,
];

function isAllowedAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;

    const hostname = url.hostname.toLowerCase();
    if (LEGACY_MESSENGER_HOSTS.has(hostname)) return true;
    if (hostname === 'm.facebook.com') return true;

    return FACEBOOK_HOSTS.has(hostname)
      && FACEBOOK_APP_PATHS.some(pattern => pattern.test(url.pathname));
  } catch {
    return false;
  }
}

function isTrustedPermissionUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'https:') return false;

    const hostname = url.hostname.toLowerCase();
    return LEGACY_MESSENGER_HOSTS.has(hostname)
      || FACEBOOK_HOSTS.has(hostname)
      || hostname === 'm.facebook.com';
  } catch {
    return false;
  }
}

loadSettings();

// IPC handler for custom notification sound selection
ipcMain.on('select-notification-sound', async () => {
  if (isSelectingSound) return;
  isSelectingSound = true;

  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Vyber zvuk oznámení',
      filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
      properties: ['openFile'],
    });
    if (!result.canceled && result.filePaths[0]) {
      const source = result.filePaths[0];
      const extension = path.extname(source).toLowerCase();
      if (!CUSTOM_SOUND_EXTENSIONS.includes(extension)) return;

      const nextFile = `notification-custom${extension}`;
      const destination = path.join(userDataPath, nextFile);
      const temporary = path.join(userDataPath, 'notification-custom.tmp');
      const backup = path.join(userDataPath, 'notification-custom.backup');

      try {
        await fs.promises.copyFile(source, temporary);
        if (fs.existsSync(backup)) await fs.promises.unlink(backup);
        if (fs.existsSync(destination)) await fs.promises.rename(destination, backup);

        try {
          await fs.promises.rename(temporary, destination);
        } catch (error) {
          if (fs.existsSync(backup)) await fs.promises.rename(backup, destination);
          throw error;
        }

        try {
          if (fs.existsSync(backup)) await fs.promises.unlink(backup);
        } catch { /* stale backup is harmless */ }
        removeCustomSoundFiles(nextFile);
        customSoundFile = nextFile;
        saveSettings();
        mainWindow.webContents.send('notification-sound-updated');
      } catch (error) {
        try {
          if (fs.existsSync(temporary)) await fs.promises.unlink(temporary);
        } catch { /* ignore */ }
        dialog.showErrorBox('Chyba zvuku', 'Vybraný zvuk se nepodařilo uložit.');
      }
    }
  } finally {
    isSelectingSound = false;
  }
});

ipcMain.on('reset-notification-sound', () => {
  removeCustomSoundFiles();
  customSoundFile = null;
  saveSettings();
  mainWindow.webContents.send('notification-sound-updated');
});

// Notification sound

function getNotificationSoundPath() {
  if (customSoundFile) {
    const configured = path.join(userDataPath, customSoundFile);
    if (fs.existsSync(configured)) return configured;
  }

  // Backwards compatibility with custom sounds saved by older versions.
  for (const extension of CUSTOM_SOUND_EXTENSIONS) {
    const custom = path.join(userDataPath, `notification-custom${extension}`);
    if (fs.existsSync(custom)) return custom;
  }

  // Check extraResources first (real file, not inside asar)
  const prod = path.join(process.resourcesPath, 'notification.mp3');
  if (fs.existsSync(prod) && !prod.includes('app.asar')) return prod;
  // Dev mode fallback
  const dev = path.join(__dirname, 'assets', 'notification.mp3');
  return dev;
}

function getNotificationSoundContentType(soundPath) {
  switch (path.extname(soundPath).toLowerCase()) {
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    default: return 'audio/mpeg';
  }
}

// Protocol handler is registered in app.whenReady below

ipcMain.on('get-mute-state', (event) => {
  event.returnValue = isMuted;
});

ipcMain.on('set-mute-state', (event, muted) => {
  isMuted = !!muted;
  saveSettings();
  // Update menus to reflect new state
  rebuildMenus();
  if (mainWindow) mainWindow.webContents.send('mute-state-changed', isMuted);
});

// IPC handler for the taskbar badge.
ipcMain.on('set-badge', (event, dataUrl) => {
  if (!mainWindow) return;
  if (dataUrl) {
    const icon = nativeImage.createFromDataURL(dataUrl);
    mainWindow.setOverlayIcon(icon, 'Nepřečtené zprávy');
  } else {
    mainWindow.setOverlayIcon(null, '');
  }
});

// IPC handler for the tray badge.
ipcMain.on('set-tray-badge', (event, dataUrl) => {
  if (!tray) return;
  if (dataUrl) {
    const icon = nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
    tray.setImage(icon);
  } else if (trayBaseIcon && !trayBaseIcon.isEmpty()) {
    tray.setImage(trayBaseIcon);
  }
});

function createWindow() {
  mainWindow = new BrowserWindow({
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
      sandbox: false,
      spellcheck: true,
      partition: MESSENGER_PARTITION,
      autoplayPolicy: 'no-user-gesture-required',
    },
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    show: true,
  });

  // Fake user agent so FB doesn't block us
  const userAgent = mainWindow.webContents.getUserAgent()
    .replace(/Electron\/\S+\s/, '')
    .replace(/messenger-app\/\S+\s/, '');
  mainWindow.webContents.setUserAgent(userAgent);

  mainWindow.loadURL(MESSENGER_URL);

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedAppUrl(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Keep Messenger and Facebook auth inside the app, open everything else externally.
  const handleNavigation = (event, url) => {
    if (event.isMainFrame === false) return;

    const targetUrl = event.url || url;
    if (!isAllowedAppUrl(targetUrl)) {
      event.preventDefault();
      shell.openExternal(targetUrl);
    }
  };
  mainWindow.webContents.on('will-navigate', handleNavigation);
  mainWindow.webContents.on('will-redirect', handleNavigation);

  // Minimize to tray instead of closing (only if tray exists)
  mainWindow.on('close', (event) => {
    if (!isQuitting && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Badge count from title changes (Messenger shows unread count in title)
  mainWindow.webContents.on('page-title-updated', (event, title) => {
    const match = title.match(/\((\d+)\)/);
    const count = match ? parseInt(match[1]) : 0;
    mainWindow.webContents.send('unread-count-changed', count);
    if (count > 0) {
      mainWindow.setTitle(`Messenger (${count})`);
      if (tray) tray.setToolTip(`Messenger - ${count} neprectenych zprav`);
    } else {
      mainWindow.setTitle('Messenger');
      if (tray) tray.setToolTip('Messenger');
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  if (!fs.existsSync(iconPath)) {
    console.log('No tray icon found at', iconPath, '- skipping tray');
    return;
  }

  trayBaseIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (trayBaseIcon.isEmpty()) {
    console.log('Tray icon is empty - skipping tray');
    return;
  }

  tray = new Tray(trayBaseIcon);
  updateTrayMenu();
  tray.setToolTip('Messenger');
  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
}

function updateTrayMenu() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Otevrit Messenger',
      click: () => {
        mainWindow.show();
        mainWindow.focus();
      },
    },
    { type: 'separator' },
    {
      label: 'Ztlumit zvuky',
      type: 'checkbox',
      checked: isMuted,
      click: (menuItem) => {
        isMuted = menuItem.checked;
        saveSettings();
        rebuildMenus();
        if (mainWindow) mainWindow.webContents.send('mute-state-changed', isMuted);
      },
    },
    {
      label: 'Změnit zvuk oznámení...',
      click: () => {
        mainWindow.webContents.send('open-sound-picker');
      },
    },
    {
      label: 'Výchozí zvuk oznámení',
      click: () => {
        ipcMain.emit('reset-notification-sound');
      },
    },
    { type: 'separator' },
    {
      label: 'Ukoncit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

function createMenu() {
  const template = [
    {
      label: 'Soubor',
      submenu: [
        {
          label: 'Novy chat',
          accelerator: 'CmdOrCtrl+N',
          click: () => {
            mainWindow.webContents.executeJavaScript(`
              document.querySelector('[aria-label="New message"]')?.click();
            `);
          },
        },
        { type: 'separator' },
        {
          label: 'Ztlumit zvuky',
          type: 'checkbox',
          checked: isMuted,
          accelerator: 'CmdOrCtrl+Shift+M',
          click: (menuItem) => {
            isMuted = menuItem.checked;
            saveSettings();
            updateTrayMenu();
            if (mainWindow) mainWindow.webContents.send('mute-state-changed', isMuted);
          },
        },
        {
          label: 'Změnit zvuk oznámení...',
          click: () => {
            mainWindow.webContents.send('open-sound-picker');
          },
        },
        {
          label: 'Výchozí zvuk oznámení',
          click: () => {
            ipcMain.emit('reset-notification-sound');
          },
        },
        { type: 'separator' },
        {
          label: 'Ukoncit',
          accelerator: 'CmdOrCtrl+Q',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ],
    },
    {
      label: 'Upravit',
      submenu: [
        { role: 'undo', label: 'Zpet' },
        { role: 'redo', label: 'Vpred' },
        { type: 'separator' },
        { role: 'cut', label: 'Vystrihnout' },
        { role: 'copy', label: 'Kopirovat' },
        { role: 'paste', label: 'Vlozit' },
        { role: 'selectAll', label: 'Vybrat vse' },
      ],
    },
    {
      label: 'Zobrazit',
      submenu: [
        { role: 'reload', label: 'Obnovit' },
        { role: 'forceReload', label: 'Vynutit obnoveni' },
        { type: 'separator' },
        { role: 'zoomIn', label: 'Priblizit' },
        { role: 'zoomOut', label: 'Oddabit' },
        { role: 'resetZoom', label: 'Puvodni velikost' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Celá obrazovka' },
        { role: 'toggleDevTools', label: 'Vyvojarské nastroje' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function rebuildMenus() {
  createMenu();
  updateTrayMenu();
}

// Notifications - allow them
app.on('ready', () => {
  const messengerSession = session.fromPartition(MESSENGER_PARTITION);
  const allowedPermissions = new Set([
    'notifications',
    'media',
    'mediaKeySystem',
    'clipboard-read',
    'clipboard-sanitized-write',
  ]);
  const canGrantPermission = (permission, requestingUrl, isMainFrame) => (
    isMainFrame
    && allowedPermissions.has(permission)
    && isTrustedPermissionUrl(requestingUrl)
  );

  messengerSession.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
    const requestingUrl = details.requestingUrl
      || details.securityOrigin
      || requestingOrigin
      || webContents?.getURL()
      || '';
    return canGrantPermission(permission, requestingUrl, details.isMainFrame);
  });

  messengerSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const requestingUrl = details.requestingUrl
      || details.securityOrigin
      || webContents.getURL();
    callback(canGrantPermission(permission, requestingUrl, details.isMainFrame));
  });
});

// When a second instance tries to start, focus the existing window
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// Auto-updater via GitHub releases
autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.on('checking-for-update', () => {
  console.log('NAV updater: checking for updates...');
});

autoUpdater.on('update-not-available', () => {
  console.log('NAV updater: no update available');
});

autoUpdater.on('update-available', (info) => {
  console.log('NAV update available:', info.version);
  // Wait for window to be ready
  const showDialog = () => {
    if (!mainWindow || !mainWindow.isVisible()) {
      setTimeout(showDialog, 1000);
      return;
    }
    dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Nová verze k dispozici',
    message: `Je dostupná nová verze: v${info.version}`,
    buttons: ['Aktualizovat', 'Později'],
    defaultId: 0,
  }).then(({ response }) => {
    if (response === 0) {
      // Show progress in title bar + taskbar
      mainWindow.setTitle('Messenger - Stahování aktualizace... 0%');
      mainWindow.setProgressBar(0);
      autoUpdater.downloadUpdate();
    }
  });
  };
  showDialog();
});

autoUpdater.on('download-progress', (progress) => {
  const pct = Math.round(progress.percent);
  const mb = Math.round(progress.transferred / 1024 / 1024);
  const totalMb = Math.round(progress.total / 1024 / 1024);
  if (mainWindow) {
    mainWindow.setTitle(`Messenger - Stahování aktualizace... ${pct}% (${mb}/${totalMb} MB)`);
    mainWindow.setProgressBar(pct / 100);
  }
});

autoUpdater.on('update-downloaded', () => {
  if (mainWindow) {
    mainWindow.setTitle('Messenger');
    mainWindow.setProgressBar(-1);
  }
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Aktualizace připravena',
    message: 'Aktualizace byla stažena. Aplikace se nyní restartuje.',
    buttons: ['OK'],
  }).then(() => {
    autoUpdater.quitAndInstall(true, true);
  });
});

autoUpdater.on('error', (err) => {
  console.log('NAV updater error:', err.message);
  if (mainWindow) {
    mainWindow.setTitle('Messenger');
    mainWindow.setProgressBar(-1);
  }
  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Chyba aktualizace',
    message: `Aktualizace selhala: ${err.message}`,
  });
});

app.whenReady().then(() => {
  // Register protocol handler for local audio files
  const messengerSession = session.fromPartition(MESSENGER_PARTITION);
  messengerSession.protocol.handle('messenger-asset', () => {
    const soundPath = getNotificationSoundPath();
    return new Response(fs.readFileSync(soundPath), {
      headers: {
        'Content-Type': getNotificationSoundContentType(soundPath),
        'Cache-Control': 'no-store',
      }
    });
  });

  createWindow();
  createTray();
  createMenu();

  // Keep the update request away from Messenger's cold-start network burst.
  if (app.isPackaged) {
    setTimeout(() => {
      if (!isQuitting) autoUpdater.checkForUpdates();
    }, 30000);
  }
});

app.on('before-quit', () => {
  isQuitting = true;
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow) {
    mainWindow.show();
  }
});
