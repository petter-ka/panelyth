/// <reference types="vitest/config" />
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Served from app://commander/ in production (ADR-0031).
  base: "/",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "chrome130",
    sourcemap: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
