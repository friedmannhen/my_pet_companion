import { contextBridge, ipcRenderer } from "electron";

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
  quit(): void {
    ipcRenderer.send("overlay:quit");
  },
};

export type OverlayApi = typeof overlayApi;

contextBridge.exposeInMainWorld("overlay", overlayApi);
