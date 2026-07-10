// Overlay spike — the #1 technical risk of the whole product (plan §7/§15):
// a transparent, frameless, always-on-top, click-through window spanning the
// primary display's work area, where click-through toggles OFF only while the
// cursor is over the pet sprite so the pet stays interactive without ever
// blocking clicks to apps underneath.
import { app, BrowserWindow, ipcMain, screen } from "electron";
import { join } from "node:path";

// Chromium's native-window-occlusion detection (Windows) sees the overlay's
// always-on-top, screen-spanning window as covering everything below it in
// Z-order — regardless of its actual pixel transparency — and stops
// compositing frames for any window it decides is "occluded". That's what
// left the stats window's DOM fully correct (verified via
// executeJavaScript) but never visually painting anything. Documented
// Electron/Chromium workaround: disable the feature outright.
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");

let overlay: BrowserWindow | null = null;
let statsWindow: BrowserWindow | null = null;

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

  ipcMain.on("overlay:open-stats", () => createOrFocusStatsWindow());

  // Instant same-machine relay: the overlay pushes its save on every change
  // straight to the stats window over IPC (no network round-trip), so the
  // HUD updates the moment you feed/wash/pet instead of waiting out its
  // Supabase poll interval.
  ipcMain.on("overlay:pet-state", (_evt, save) => {
    statsWindow?.webContents.send("pet-state", save);
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
 * The detailed stats/quests/achievements view (plan §17: "a separate main
 * game window", not more clutter on the pet overlay). A real, independently
 * focusable/movable/closable window (none of the overlay's click-through/
 * DWM-occlusion baggage applies) — but frameless/transparent so it reads as
 * a HUD panel rather than a stock Electron app window, matching the design
 * intent ("all HUD of the game should be a smooth overlay on screen").
 * StatsApp.tsx supplies its own rounded panel chrome, drag handle, and
 * close button since there's no OS title bar here.
 */
function createOrFocusStatsWindow(): void {
  if (statsWindow && !statsWindow.isDestroyed()) {
    statsWindow.show();
    statsWindow.focus();
    return;
  }

  statsWindow = new BrowserWindow({
    width: 420,
    height: 640,
    frame: false,
    transparent: true,
    hasShadow: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    // `new URL` correctly normalizes the slash regardless of whether
    // ELECTRON_RENDERER_URL already ends in one (a naive template-string
    // join here previously produced "http://localhost:5173//stats.html",
    // a 404 that left the window blank).
    void statsWindow.loadURL(new URL("stats.html", process.env.ELECTRON_RENDERER_URL).toString());
  } else {
    void statsWindow.loadFile(join(__dirname, "../renderer/stats.html"));
  }

  statsWindow.on("closed", () => {
    statsWindow = null;
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
