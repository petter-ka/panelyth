import { app } from "electron"
import { join, resolve } from "node:path"

const exe = process.platform === "win32" ? ".exe" : ""

/**
 * The app-window icon; electron-builder uses the native .ico/.icns variants.
 * On Windows the .ico: the window's icon is what the taskbar shows, and from
 * the .ico Windows takes the size drawn for the slot (16 to 48 px on their
 * own pixel grid) instead of shrinking the 1024 px picture into a smudge.
 */
export function appIconPath(): string {
  const file = process.platform === "win32" ? "icon.ico" : "icon.png"
  if (app.isPackaged) return join(process.resourcesPath, file)
  return join(app.getAppPath(), "build", file)
}

/** The licence notices: beside the app's resources when packaged, else where `pnpm notices` writes them. */
export function noticesPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "THIRD-PARTY-NOTICES.txt")
  return join(app.getAppPath(), "build", "THIRD-PARTY-NOTICES.txt")
}

/** Written by electron-builder when the build names an update feed (ADR-0038). */
export function updateFeedPath(): string {
  return join(process.resourcesPath, "app-update.yml")
}

/**
 * Sidecar binary location. Packaged builds ship it in resources/bin;
 * unpackaged builds use the output of `pnpm build:sidecar`.
 * PANELYTH_SIDECAR_PATH overrides both (tests).
 */
export function sidecarBinaryPath(): string {
  const override = process.env.PANELYTH_SIDECAR_PATH
  if (override) return resolve(override)
  const name = `panelyth-sidecar${exe}`
  if (app.isPackaged) return join(process.resourcesPath, "bin", name)
  return join(app.getAppPath(), "resources", "bin", `${process.platform}-${process.arch}`, name)
}

/** Built renderer assets served through app://panelyth/. */
export function rendererDistPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "renderer")
  return resolve(app.getAppPath(), "..", "..", "viewer", "renderer", "dist")
}

/** Dev server URL; set by scripts/dev.mjs. Ignored in packaged builds. */
export function rendererDevUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.PANELYTH_RENDERER_URL || null
}

/** The commander's built renderer, served through app://commander/ (ADR-0031). */
export function commanderDistPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "commander")
  return resolve(app.getAppPath(), "..", "..", "commander", "renderer", "dist")
}

/** The commander's dev server URL; set by scripts/dev.mjs. */
export function commanderDevUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.PANELYTH_COMMANDER_URL || null
}

/** Panelyth System's built renderer, served through app://system/ (ADR-0042). */
export function systemDistPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "system")
  return resolve(app.getAppPath(), "..", "..", "system", "renderer", "dist")
}

/** Panelyth System's dev server URL; set by scripts/dev.mjs. */
export function systemDevUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.PANELYTH_SYSTEM_URL || null
}

export function systemPreloadPath(): string {
  return join(__dirname, "..", "preload", "system.cjs")
}

export function preloadPath(): string {
  return join(__dirname, "..", "preload", "preload.cjs")
}

export function commanderPreloadPath(): string {
  return join(__dirname, "..", "preload", "commander.cjs")
}

/** The document window's built renderer, served through app://documents/ (ADR-0033). */
export function documentsDistPath(): string {
  if (app.isPackaged) return join(process.resourcesPath, "documents")
  return resolve(app.getAppPath(), "..", "docviewer", "dist")
}

/** The document window's dev server URL; set by scripts/dev.mjs. */
export function documentsDevUrl(): string | null {
  if (app.isPackaged) return null
  return process.env.PANELYTH_DOCUMENTS_URL || null
}
