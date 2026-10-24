/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from app://texteditor/ in production (ADR-0046).
  base: "/",
  // boot.js, the classic script index.html runs before the first paint.
  publicDir: "../ui/boot",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
    // Fonts and icons are files: the CSP has no data: scripts and few data: images.
    assetsInlineLimit: 0,
  },
  server: {
    port: 5177,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
