import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

// Only present when there's no Electron preload (plain browser tab, used for
// debugging renderer logic directly with browser devtools/automation) — a
// real Electron launch always has window.overlay from contextBridge, so this
// never runs there.
if (typeof window.overlay === "undefined") {
  console.warn("[browser] no window.overlay — using no-op mock (Electron-only features disabled)");
  window.overlay = {
    setClickable: () => {},
    onCursor: () => () => {},
    setFocusable: () => {},
    quit: () => {},
    getAppVersion: () => Promise.resolve("0.0.0-browser"),
    onUpdateStatus: () => () => {},
    installUpdate: () => {},
  };
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
