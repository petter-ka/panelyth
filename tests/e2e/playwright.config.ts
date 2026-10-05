import { defineConfig } from "@playwright/test"

// Electron tests launch the built app (`pnpm build` first; `pnpm test:e2e`
// does both). One worker: each test owns a full app + sidecar.
export default defineConfig({
  testDir: "specs",
  timeout: 30_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
})
