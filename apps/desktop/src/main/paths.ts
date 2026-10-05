import { app } from "electron"
import { join, resolve } from "node:path"

const exe = process.platform === "win32" ? ".exe" : ""

/**
 * Sidecar binary location. Packaged builds ship it in resources/bin;
 * unpackaged builds use the output of `pnpm build:sidecar`.
 * FASTVIEW_SIDECAR_PATH overrides both (tests).
 */
export function sidecarBinaryPath(): string {
  const override = process.env.FASTVIEW_SIDECAR_PATH
  if (override) return resolve(override)
  const name = `fastview-sidecar${exe}`
  if (app.isPackaged) return join(process.resourcesPath, "bin", name)
  return join(app.getAppPath(), "resources", "bin", `${process.platform}-${process.arch}`, name)
}

/** Built renderer assets served through app://fastview/. */
export function rendererDistPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "renderer")
  return resolve(app.getAppPath(), "..", "renderer", "dist")
}

/** Dev server URL; set by scripts/dev.mjs. Ignored in packaged builds. */
export function rendererDevUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.FASTVIEW_RENDERER_URL || null
}

export function preloadPath(): string {
  return join(__dirname, "..", "preload", "preload.cjs")
}
