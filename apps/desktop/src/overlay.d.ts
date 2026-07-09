import type { OverlayApi } from "../electron/preload";

declare global {
  interface Window {
    overlay: OverlayApi;
  }
}

export {};
