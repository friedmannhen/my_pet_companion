// Overlay spike — the #1 technical risk of the whole product (plan §7/§15):
// a transparent, frameless, always-on-top, click-through window spanning the
// primary display's work area, where click-through toggles OFF only while the
// cursor is over the pet sprite so the pet stays interactive without ever
// blocking clicks to apps underneath.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";
import { autoUpdater } from "electron-updater";

// Chromium's native-window-occlusion detection (Windows) sees the overlay's
// always-on-top, screen-spanning window as covering everything below it in
// Z-order — regardless of its actual pixel transparency — and stops
// compositing frames for any window it decides is "occluded". That's what
// left the stats window's DOM fully correct (verified via
// executeJavaScript) but never visually painting anything. Documented
// Electron/Chromium workaround: disable the feature outright.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let overlay: BrowserWindow | null = null;

function createOverlay(): void {
  const { workArea } = screen.getPrimaryDisplay();

  overlay = new BrowserWindow({
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    // 1px shy of the full work area on purpose: a borderless window that
    // exactly matches the monitor/work-area size can trigger Windows' DWM
    // "borderless fullscreen" heuristic, which suspends compositing of
    // windows behind it until ours loses focus — a second, independent
    // cause of the same "background app looks frozen" symptom the
    // focusable:false fix above addresses from the focus-stealing angle.
    height: workArea.height - 1,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    // Default non-focusable so clicking the pet/menus never steals OS
    // foreground focus — this is what was causing whatever app the user had
    // open behind the overlay to visually "freeze": losing foreground focus
    // makes most apps/games throttle their own rendering, same as clicking
    // any other window would. setFocusable(true) is only requested briefly,
    // by the renderer, while a text input (e.g. the auth form) is focused.
    focusable: false,
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

  // Requested only while a text <input> is actually focused in the renderer
  // (see focusableInputProps) — everything else (buttons, the radial menu)
  // works fine receiving clicks while non-focusable.
  ipcMain.on("overlay:set-focusable", (_evt, focusable: boolean) => {
    if (!overlay) return;
    overlay.setFocusable(focusable);
    if (focusable) overlay.focus();
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

/**
 * Re-fit the overlay to the CURRENT primary work area. The window is created
 * once at launch with that moment's dimensions — if the user then switches
 * resolution (2K → 1080p), changes display scaling, or swaps the primary
 * monitor, the stale window keeps its old size and everything docked to its
 * far edge (the SideDock ribbon) ends up physically offscreen. Resizing here
 * also fires the renderer's `resize` listeners, which already clamp the
 * ribbon's saved height and the pet's position back into view.
 */
function fitOverlayToWorkArea(): void {
  if (!overlay || overlay.isDestroyed()) return;
  const { workArea } = screen.getPrimaryDisplay();
  const target = {
    x: workArea.x,
    y: workArea.y,
    width: workArea.width,
    // Same -1 as at creation (DWM borderless-fullscreen heuristic).
    height: workArea.height - 1,
  };
  const current = overlay.getBounds();
  if (
    current.x === target.x &&
    current.y === target.y &&
    current.width === target.width &&
    current.height === target.height
  ) {
    return;
  }
  // On Windows, `resizable: false` can also block PROGRAMMATIC size changes
  // via setBounds (long-standing Electron quirk) — lift it for the call.
  overlay.setResizable(true);
  overlay.setBounds(target);
  overlay.setResizable(false);
}

export interface UpdateStatus {
  state: "downloading" | "ready";
  version: string;
}

function sendUpdateStatus(status: UpdateStatus): void {
  if (!overlay || overlay.isDestroyed()) return;
  overlay.webContents.send("overlay:update-status", status);
}

/**
 * Background auto-update, now with a visible in-app affordance (QA/beta
 * distribution). Checks GitHub Releases on launch and again every 2h,
 * downloads quietly in the background, then tells the renderer once it's
 * ready so it can show a "restart to update" button instead of silently
 * waiting for the next natural quit — a professional app shouldn't update
 * itself with zero visibility. `autoInstallOnAppQuit` stays on as a
 * fallback: even if the user ignores the button and just quits normally,
 * the update still applies. No-ops entirely in `pnpm dev` (electron-updater
 * requires a packaged, signed-or-not installer build to have anything to
 * compare against — `app.isPackaged` is false for the dev/electron-vite run).
 */
function setupAutoUpdate(): void {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus({ state: "downloading", version: info.version });
  });
  autoUpdater.on("update-downloaded", (info) => {
    console.log(`[update] ${info.version} downloaded — will install on next restart`);
    sendUpdateStatus({ state: "ready", version: info.version });
  });
  autoUpdater.on("error", (err) => {
    console.error("[update] check/download failed:", err);
  });

  autoUpdater.checkForUpdates().catch((err) => console.error("[update] initial check failed:", err));
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => console.error("[update] periodic check failed:", err));
  }, 2 * 3600_000);
}

ipcMain.handle("overlay:get-version", () => app.getVersion());
// Lets the user click "restart to update" instead of waiting for the next
// natural quit — quitAndInstall() is a no-op/harmless if nothing is ready yet.
ipcMain.on("overlay:install-update", () => autoUpdater.quitAndInstall());

app.whenReady().then(() => {
  createOverlay();
  setupAutoUpdate();

  screen.on("display-metrics-changed", fitOverlayToWorkArea);
  screen.on("display-added", fitOverlayToWorkArea);
  screen.on("display-removed", fitOverlayToWorkArea);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createOverlay();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
