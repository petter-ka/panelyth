import { defineConfig } from "@playwright/test"

// The packaged smoke test (Stage P04): runs against the output of
// `pnpm package --dir` (or FASTVIEW_PACKAGED_APP), not the unpackaged build.
export default defineConfig({
  testDir: "smoke",
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
})
