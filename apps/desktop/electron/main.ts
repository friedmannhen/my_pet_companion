// Overlay spike — the #1 technical risk of the whole product (plan §7/§15):
// a transparent, frameless, always-on-top, click-through window spanning the
// primary display's work area, where click-through toggles OFF only while the
// cursor is over the pet sprite so the pet stays interactive without ever
// blocking clicks to apps underneath.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";

let overlay: BrowserWindow | null = null;

function createOverlay(): void {
  const { workArea } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    height: workArea.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // "screen-saver" level keeps the overlay above regular always-on-top windows.
  overlay.setAlwaysOnTop(true, "screen-saver");
  // Never appear in alt-tab as a "real" window.
  overlay.setSkipTaskbar(true);

  // Default state: fully click-through.
  // NOTE: `forward: true` mousemove forwarding proved unreliable on
  // Windows 10 + Electron 33 (verified in the overlay spike — no mousemove
  // nor mouseenter reached the renderer while ignored). So we use the other
  // standard desktop-pet pattern instead: the main process polls the OS
  // cursor position and streams it to the renderer, which hit-tests against
  // its interactive elements and asks to toggle clickability.
  overlay.setIgnoreMouseEvents(true, { forward: true });

  const cursorPoll = setInterval(() => {
    if (!overlay || overlay.isDestroyed()) return;
    const pt = screen.getCursorScreenPoint();
    const bounds = overlay.getBounds();
    overlay.webContents.send("overlay:cursor", {
      x: pt.x - bounds.x,
      y: pt.y - bounds.y,
    });
  }, 80);
  overlay.on("closed", () => clearInterval(cursorPoll));

  overlay.once("ready-to-show", () => overlay?.show());

  // Renderer-driven hit-testing: clickable only over the sprite bounds.
  ipcMain.on("overlay:set-clickable", (_evt, clickable: boolean) => {
    if (!overlay) return;
    if (clickable) {
      overlay.setIgnoreMouseEvents(false);
    } else {
      overlay.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on("overlay:quit", () => app.quit());

  if (process.env.ELECTRON_RENDERER_URL) {
    void overlay.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void overlay.loadFile(join(__dirname, "../renderer/index.html"));
  }

  overlay.on("closed", () => {
    overlay = null;
  });
}

app.whenReady().then(() => {
  createOverlay();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
