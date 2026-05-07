const { app, BrowserWindow, Tray, Menu, nativeImage, shell, screen } = require('electron');
const path = require('path');

let win, tray;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;

  win = new BrowserWindow({
    width: 320,
    height: 250,
    x: width - 328,
    y: height - 250,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  win.loadFile('index.html');
  win.setAlwaysOnTop(true, 'screen-saver');

  // Hide from Alt+Tab
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
}

function createTray() {
  // Inline 16x16 lightning bolt PNG (base64, no external file needed)
  const iconB64 =
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAoklEQVR4' +
    'nGNgGAWDHfz//5+BFMzIwMDAwEBqAIqNjY2BgYGBgZSNKBpRNKJoRNG' +
    'IohFFI4pGFI0oGlE0omhE0YiiEUUjikYUjSgaUTSiaETRiKIRRSOKRh' +
    'SNKBpRNKJoRNGIohFFI4pGFI0oGlE0omhE0YiiEUUjikYUjSgaUTSia' +
    'ETRiKIRRSOKRhSNKBpRNKJoRNEAANMEEAF5eYSmAAAAAElFTkSuQmCC';

  const img = nativeImage.createFromDataURL('data:image/png;base64,' + iconB64);
  tray = new Tray(img);
  tray.setToolTip('Wasted Token Overlay');

  const menu = Menu.buildFromTemplate([
    { label: 'Show / Hide', click: () => win.isVisible() ? win.hide() : win.show() },
    { type: 'separator' },
    { label: 'Open Dashboard', click: () => shell.openExternal('http://127.0.0.1:3777') },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);

  tray.setContextMenu(menu);
  tray.on('click', () => win.isVisible() ? win.hide() : win.show());
}

app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on('window-all-closed', (e) => e.preventDefault());
