const { app, BrowserWindow, shell, Menu, Tray, nativeImage, session, ipcMain } = require('electron');
const path = require('path');

let mainWindow;
let tray;
let isQuitting = false;

const MESSENGER_URL = 'https://www.messenger.com';

// IPC handler for badge overlay from renderer
ipcMain.on('set-badge', (event, dataUrl) => {
  if (!mainWindow) return;
  if (dataUrl) {
    const icon = nativeImage.createFromDataURL(dataUrl);
    mainWindow.setOverlayIcon(icon, 'Nepřečtené zprávy');
  } else {
    mainWindow.setOverlayIcon(null, '');
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
  mainWindow.webContents.on('console-message', (event, level, message) => {
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

app.whenReady().then(() => {
  createWindow();
  createTray();
  createMenu();
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
