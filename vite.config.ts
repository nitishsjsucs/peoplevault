// Build of the privacy console (React SPA, SPEC.md section 4): `npm run build:web` writes dist/web, which both
// Wrangler configs serve as static assets (only /api/* and /dev/* invoke the Worker). No source maps are published.
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  publicDir: "src/web/public",
  build: { outDir: "dist/web", emptyOutDir: true, sourcemap: false, assetsInlineLimit: 0 },
});
