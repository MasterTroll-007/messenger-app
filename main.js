const { app, BrowserWindow, shell, Menu, Tray, nativeImage, session, ipcMain, dialog, protocol } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');

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
let isQuitting = false;

const MESSENGER_URL = 'https://www.messenger.com';

// IPC handler for custom notification sound selection
ipcMain.on('select-notification-sound', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Vyber zvuk oznámení',
    filters: [{ name: 'Audio', extensions: ['mp3', 'wav', 'ogg', 'm4a'] }],
    properties: ['openFile'],
  });
  if (!result.canceled && result.filePaths[0]) {
    const fs = require('fs');
    const dest = path.join(userDataPath, 'notification-custom.mp3');
    fs.copyFileSync(result.filePaths[0], dest);
    mainWindow.webContents.send('notification-sound-updated', dest);
  }
});

ipcMain.on('reset-notification-sound', () => {
  const fs = require('fs');
  const custom = path.join(userDataPath, 'notification-custom.mp3');
  if (fs.existsSync(custom)) fs.unlinkSync(custom);
  mainWindow.webContents.send('notification-sound-updated', null);
});

// Notification sound
const fs = require('fs');

function getNotificationSoundPath() {
  const custom = path.join(userDataPath, 'notification-custom.mp3');
  if (fs.existsSync(custom)) return custom;
  const dev = path.join(__dirname, 'assets', 'notification.mp3');
  if (fs.existsSync(dev)) return dev;
  return path.join(process.resourcesPath, 'notification.mp3');
}

// Protocol handler is registered in app.whenReady below

ipcMain.on('play-notification-sound', () => {
  const soundPath = getNotificationSoundPath();
  console.log('NAV playing sound:', soundPath);
  const { exec } = require('child_process');
  exec(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName presentationCore; $p = New-Object system.windows.media.mediaplayer; $p.open([uri]'${soundPath.replace(/'/g, "''")}'); Start-Sleep -Milliseconds 300; $p.Play(); Start-Sleep -Seconds 3"`);
});

// IPC handler for badge overlay (taskbar - pulsing)
ipcMain.on('set-badge', (event, dataUrl) => {
  if (!mainWindow) return;
  if (dataUrl) {
    const icon = nativeImage.createFromDataURL(dataUrl);
    mainWindow.setOverlayIcon(icon, 'Nepřečtené zprávy');
  } else {
    mainWindow.setOverlayIcon(null, '');
  }
});

// IPC handler for tray badge (static, no pulsing)
ipcMain.on('set-tray-badge', (event, dataUrl) => {
  if (!tray) return;
  if (dataUrl) {
    const icon = nativeImage.createFromDataURL(dataUrl).resize({ width: 16, height: 16 });
    tray.setImage(icon);
  } else {
    const iconPath = path.join(__dirname, 'assets', 'icon.png');
    const originalIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    if (!originalIcon.isEmpty()) tray.setImage(originalIcon);
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
      partition: 'persist:messenger',
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

  // Forward console logs from renderer to main process
  mainWindow.webContents.on('console-message', (e) => {
    const message = e.message || '';
    if (message.startsWith('NAV') || message.startsWith('  ')) {
      console.log('[renderer]', message);
    }
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('https://www.messenger.com') && !url.startsWith('https://www.facebook.com/login')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Handle navigation - keep messenger/fb login, open rest externally
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = [
      'https://www.messenger.com',
      'https://www.facebook.com/login',
      'https://www.facebook.com/checkpoint',
      'https://m.facebook.com',
    ];
    const isAllowed = allowed.some(prefix => url.startsWith(prefix));
    if (!isAllowed) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

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
  const fs = require('fs');
  const iconPath = path.join(__dirname, 'assets', 'icon.png');

  if (!fs.existsSync(iconPath)) {
    console.log('No tray icon found at', iconPath, '- skipping tray');
    return;
  }

  const trayIcon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (trayIcon.isEmpty()) {
    console.log('Tray icon is empty - skipping tray');
    return;
  }

  tray = new Tray(trayIcon);
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
      label: 'Ukoncit',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setToolTip('Messenger');
  tray.setContextMenu(contextMenu);
  tray.on('click', () => {
    mainWindow.show();
    mainWindow.focus();
  });
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

// Notifications - allow them
app.on('ready', () => {
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['notifications', 'media', 'mediaKeySystem', 'clipboard-read', 'clipboard-sanitized-write'];
    callback(allowed.includes(permission));
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

let progressWin = null;

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
      // Show progress window
      progressWin = new BrowserWindow({
        width: 350,
        height: 120,
        resizable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        frame: false,
        parent: mainWindow,
        modal: true,
        webPreferences: { nodeIntegration: false },
      });
      progressWin.loadURL(`data:text/html,
        <html><body style="margin:0;padding:20px;font-family:Arial;background:#1a1a2e;color:white;display:flex;flex-direction:column;justify-content:center;">
          <div style="font-size:14px;margin-bottom:12px;">Stahování aktualizace...</div>
          <div style="background:#333;border-radius:8px;height:16px;overflow:hidden;">
            <div id="bar" style="background:linear-gradient(90deg,#0095F6,#0078D4);height:100%;width:0%;transition:width 0.3s;border-radius:8px;"></div>
          </div>
          <div id="pct" style="font-size:12px;margin-top:8px;color:#aaa;">0%</div>
        </body></html>
      `);
      autoUpdater.downloadUpdate();
    }
  });
  };
  showDialog();
});

autoUpdater.on('download-progress', (progress) => {
  const pct = Math.round(progress.percent);
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.webContents.executeJavaScript(`
      document.getElementById('bar').style.width = '${pct}%';
      document.getElementById('pct').textContent = '${pct}% (${Math.round(progress.transferred / 1024 / 1024)}/${Math.round(progress.total / 1024 / 1024)} MB)';
    `).catch(() => {});
  }
  if (mainWindow) mainWindow.setProgressBar(pct / 100);
});

autoUpdater.on('update-downloaded', () => {
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.close();
    progressWin = null;
  }
  if (mainWindow) mainWindow.setProgressBar(-1);
  dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: 'Aktualizace připravena',
    message: 'Aktualizace byla stažena. Aplikace se restartuje a nainstaluje novou verzi.',
    buttons: ['Restartovat'],
  }).then(() => {
    autoUpdater.quitAndInstall();
  });
});

autoUpdater.on('error', (err) => {
  console.log('NAV updater error:', err.message);
  if (progressWin && !progressWin.isDestroyed()) {
    progressWin.close();
    progressWin = null;
  }
  if (mainWindow) mainWindow.setProgressBar(-1);
  dialog.showMessageBox(mainWindow, {
    type: 'error',
    title: 'Chyba aktualizace',
    message: `Aktualizace selhala: ${err.message}`,
  });
});

app.whenReady().then(() => {
  // Register protocol handler for local audio files
  protocol.handle('messenger-asset', () => {
    const soundPath = getNotificationSoundPath();
    return new Response(fs.readFileSync(soundPath), {
      headers: { 'Content-Type': 'audio/mpeg' }
    });
  });

  createWindow();
  createTray();
  createMenu();

  // Check for updates shortly after start
  setTimeout(() => autoUpdater.checkForUpdates(), 1000);
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
