import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Refuse to silently fall through to 5174/5175 — those are likely owned by
    // another project's dev server (e.g. git-viewer's backend on 5174). A
    // sneaky port grab leaves an orphan vite that proxies /api elsewhere and
    // breaks the neighbor without an obvious failure mode.
    strictPort: true,
    proxy: {
      "/api": "http://localhost:4000",
    },
  },
});
