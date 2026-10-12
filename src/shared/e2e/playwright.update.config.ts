import { defineConfig } from "@playwright/test"

// The install, update and uninstall test (Stage P06): it packages two
// versions and installs one for the current user, so it runs only when asked
// for (`pnpm test:update`), on a machine where Panelyth is not installed.
export default defineConfig({
  testDir: "update",
  timeout: 30 * 60_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
})
