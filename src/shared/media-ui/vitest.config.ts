/// <reference types="vitest/config" />
import { defineConfig } from "vite"

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: ["src/test-setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
})
