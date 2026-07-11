import { contextBridge, ipcRenderer } from "electron";
import type { UpdateStatus } from "./main";

// Minimal, explicit surface — no generic ipc passthrough.
const overlayApi = {
  /** Toggle whether the overlay window accepts mouse input (cursor over sprite). */
  setClickable(clickable: boolean): void {
    ipcRenderer.send("overlay:set-clickable", clickable);
  },
  /** Cursor position in window coordinates, streamed from the main-process poll. */
  onCursor(cb: (pos: { x: number; y: number }) => void): () => void {
    const listener = (_evt: unknown, pos: { x: number; y: number }) => cb(pos);
    ipcRenderer.on("overlay:cursor", listener);
    return () => ipcRenderer.removeListener("overlay:cursor", listener);
  },
  /** Request/release OS keyboard focus — only while a text input is active. */
  setFocusable(focusable: boolean): void {
    ipcRenderer.send("overlay:set-focusable", focusable);
  },
  quit(): void {
    ipcRenderer.send("overlay:quit");
  },
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke("overlay:get-version");
  },
  /** Fires once an update download starts, then again once it's ready to install. */
  onUpdateStatus(cb: (status: UpdateStatus) => void): () => void {
    const listener = (_evt: unknown, status: UpdateStatus) => cb(status);
    ipcRenderer.on("overlay:update-status", listener);
    return () => ipcRenderer.removeListener("overlay:update-status", listener);
  },
  /** Restarts the app now to apply a downloaded update, instead of waiting for the next natural quit. */
  installUpdate(): void {
    ipcRenderer.send("overlay:install-update");
  },
};

export type OverlayApi = typeof overlayApi;

contextBridge.exposeInMainWorld("overlay", overlayApi);
