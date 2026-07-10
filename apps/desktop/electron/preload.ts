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
  /** Request/release OS keyboard focus — only while a text input is active. */
  setFocusable(focusable: boolean): void {
    ipcRenderer.send("overlay:set-focusable", focusable);
  },
  /** Opens (or focuses, if already open) the separate stats/details window. */
  openStats(): void {
    ipcRenderer.send("overlay:open-stats");
  },
  /** Called by the pet overlay on every save change — instant same-machine push to the stats window. */
  notifyPetState(save: unknown): void {
    ipcRenderer.send("overlay:pet-state", save);
  },
  /** Called by the stats window to receive those pushes instantly (no poll wait). */
  onPetState(cb: (save: unknown) => void): () => void {
    const listener = (_evt: unknown, save: unknown) => cb(save);
    ipcRenderer.on("pet-state", listener);
    return () => ipcRenderer.removeListener("pet-state", listener);
  },
  quit(): void {
    ipcRenderer.send("overlay:quit");
  },
};

export type OverlayApi = typeof overlayApi;

contextBridge.exposeInMainWorld("overlay", overlayApi);
