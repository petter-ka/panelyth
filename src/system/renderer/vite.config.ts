/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from app://system/ in production (ADR-0042).
  base: "/",
  // boot.js, the classic script index.html runs before the first paint.
  publicDir: "../../shared/ui/boot",
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
    port: 5176,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
