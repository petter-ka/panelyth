/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from app://panelyth/ in production.
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
    // settings.html is the settings window's page (ADR-0039).
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    // Only the token file is loaded (as ?raw) by tokens.test.ts; other CSS stays stubbed.
    css: { include: [/styles\/index\.css/] },
  },
})
