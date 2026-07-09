import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

export default defineConfig({
  main: {
    build: {
      lib: { entry: resolve(__dirname, "electron/main.ts") },
    },
  },
  preload: {
    build: {
      lib: { entry: resolve(__dirname, "electron/preload.ts") },
    },
  },
  renderer: {
    root: resolve(__dirname, "src"),
    // .env lives in apps/desktop, not the renderer root (src).
    envDir: __dirname,
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/index.html"),
      },
    },
    plugins: [react()],
  },
});
