import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Debugging-only: runs the exact same renderer code as electron.vite.config.ts's
// `renderer` block, but as a plain browser dev server (no Electron process),
// so browser devtools/automation can click into it directly. Not used by any
// pnpm script that ships — see main.tsx's window.overlay mock guard.
export default defineConfig({
  root: resolve(__dirname, "src"),
  envDir: __dirname,
  plugins: [react()],
  server: {
    port: 5183,
  },
});
