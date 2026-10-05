import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ClipboardItem,
  ipcMain,
  session,
  shell,
  webContents,
} from "electron"
import { handleAppProtocol, registerAppScheme } from "./appProtocol"
import { handleMediaProtocol, MediaTokens, toMediaOpenResult } from "./mediaProtocol"
import { handleThumbProtocol } from "./thumbProtocol"
import {
  broadcast,
  forwardableEvent,
  ipcInvokeCounts,
  registerIpc,
  type MainHandlers,
} from "./ipc/router"
import { consoleLogger, createFileLogger, type Logger } from "./log"
import {
  commanderDevUrl,
  commanderDistPath,
  commanderPreloadPath,
  preloadPath,
  rendererDevUrl,
  rendererDistPath,
  sidecarBinaryPath,
} from "./paths"
import {
  APP_HOST,
  APP_ORIGIN,
  COMMANDER_HOST,
  COMMANDER_ORIGIN,
  hardenSession,
  originOf,
  trustedOrigin,
} from "./security"
import { AppShell } from "./shell"
import { COMMANDER_ENABLED_ARG, type AppId } from "@fastview/contracts"
import { SidecarProcess } from "./sidecar/SidecarProcess"
import { createMainWindow } from "./window"
import { pngSize, workspaceHandlers, type WorkspaceDeps } from "./workspace"
import { perfMark } from "./perf"

// Recorded once all main-process modules (including electron) are loaded.
perfMark("main-loaded")

// Dev-only RPC methods (system.echo) exist for benchmarks; never in packaged builds.
const devMethods = !app.isPackaged && process.env.FASTVIEW_DEV_METHODS === "1"

// The commander stays hidden behind a feature flag until Stage C11 (ADR-0031).
const commanderEnabled = process.env.FASTVIEW_COMMANDER === "1"
// Tests and benchmarks may start with the commander shown. Unpackaged only.
const startApp: AppId =
  !app.isPackaged && commanderEnabled && process.env.FASTVIEW_START_APP === "commander"
    ? "commander"
    : "viewer"

// Tests and benchmarks run each launch with a fresh profile (localStorage,
// logs) so stored preferences cannot leak between runs. Unpackaged only.
const userDataOverride = app.isPackaged ? undefined : process.env.FASTVIEW_USER_DATA_DIR
if (userDataOverride) app.setPath("userData", userDataOverride)

registerAppScheme()

// Benchmark hook (main process only, like __fastviewPerf).
;(globalThis as { __fastviewIpcCounts?: () => Record<string, number> }).__fastviewIpcCounts =
  ipcInvokeCounts

// E2E tests must not launch apps, open file managers or touch the user's
// clipboard: unpackaged builds can record those calls instead.
const recordShell = !app.isPackaged && process.env.FASTVIEW_TEST_SHELL === "record"
const shellLog: { action: string; value: string }[] = []
;(globalThis as { __fastviewShellLog?: typeof shellLog }).__fastviewShellLog = shellLog

let sidecar: SidecarProcess | null = null
let appShell: AppShell | null = null
let logger: Logger = consoleLogger
let shutdownState: "running" | "stopping" | "done" = "running"

const commanderOrigin = (): string => {
  const devUrl = commanderDevUrl()
  return (devUrl && originOf(devUrl)) || COMMANDER_ORIGIN
}

function openWindow(): BrowserWindow {
  const devUrl = rendererDevUrl()
  const win = createMainWindow({
    preload: preloadPath(),
    url: devUrl ?? `${APP_ORIGIN}/index.html`,
    origin: trustedOrigin(devUrl),
    devMethods,
    devTools: !app.isPackaged,
    extraArgs: commanderEnabled ? [COMMANDER_ENABLED_ARG] : [],
  })
  const commanderUrl = commanderDevUrl() ?? `${COMMANDER_ORIGIN}/index.html`
  appShell = new AppShell(
    win,
    commanderEnabled
      ? {
          url: commanderUrl,
          origin: commanderOrigin(),
          preload: commanderPreloadPath(),
          devTools: !app.isPackaged,
        }
      : null,
  )
  if (startApp === "commander") appShell.switchTo("commander")
  return win
}

// Test hook (main process only): which app is shown and whether the commander view exists.
;(globalThis as { __fastviewShellState?: () => object }).__fastviewShellState = () => ({
  active: appShell?.activeApp ?? null,
  commanderCreated: appShell?.webContentsOf("commander") != null,
  commanderEnabled,
})

async function boot(): Promise<void> {
  perfMark("app-ready")
  logger = await createFileLogger(app.getPath("logs"), !app.isPackaged).catch((error: unknown) => {
    consoleLogger.error("file logger unavailable", { error: String(error) })
    return consoleLogger
  })
  logger.info("app starting", { version: app.getVersion(), packaged: app.isPackaged, devMethods })

  const devUrl = rendererDevUrl()
  const devUrls = [devUrl, commanderDevUrl()].filter((u): u is string => u !== null)
  hardenSession(session.defaultSession, [trustedOrigin(devUrl), commanderOrigin()], devUrls)
  handleAppProtocol({ [APP_HOST]: rendererDistPath(), [COMMANDER_HOST]: commanderDistPath() })

  const sc = new SidecarProcess({
    binaryPath: sidecarBinaryPath(),
    logger,
    logLevel: app.isPackaged ? "info" : "debug",
    env: devMethods ? { FASTVIEW_DEV_METHODS: "1" } : { FASTVIEW_DEV_METHODS: "" },
  })
  sidecar = sc
  // The thumbnail root comes from the sidecar's hello, never from the renderer.
  handleThumbProtocol(() => sc.getHello()?.thumbnailRoot ?? null)
  const mediaTokens = new MediaTokens()
  handleMediaProtocol(mediaTokens)
  sc.onStatus((status) => {
    if (status.state === "ready") perfMark("sidecar-ready")
    logger.info("sidecar status", { ...status })
    broadcast(webContents.getAllWebContents(), "sidecar.status", status)
  })
  // Coalesced sidecar events (index progress, query invalidation) go to all windows.
  sc.onEvent((frame) => {
    const message = forwardableEvent(frame)
    if (message) broadcast(webContents.getAllWebContents(), message.ch, message.p)
    else logger.warn("dropped malformed sidecar event", { ch: frame.ch })
  })

  const workspaceDeps: WorkspaceDeps = {
    call: (method, params) => sc.call(method, params),
    getPath: (id) => app.getPath(id),
    openPath: (path) => {
      if (!recordShell) return shell.openPath(path)
      shellLog.push({ action: "open", value: path })
      return Promise.resolve("")
    },
    showItemInFolder: (path) => {
      if (recordShell) shellLog.push({ action: "reveal", value: path })
      else shell.showItemInFolder(path)
    },
    writeClipboard: (text) => {
      if (recordShell) shellLog.push({ action: "clipboard", value: text })
      else clipboard.writeText(text)
    },
    writeClipboardImage: async (png) => {
      // Tests read the size back from the PNG header.
      if (recordShell) {
        shellLog.push({ action: "clipboardImage", value: pngSize(png) })
        return
      }
      await clipboard.write([
        new ClipboardItem({
          "image/png": new Blob([png as Uint8Array<ArrayBuffer>], { type: "image/png" }),
        }),
      ])
    },
  }
  const main: MainHandlers = {
    "app.exit": () => {
      app.quit()
      return { ok: true }
    },
    "app.switch": (_event, { to }) => {
      if (!appShell?.enabled) throw new Error("the commander is not enabled")
      appShell.switchTo(to)
      return { ok: true }
    },
    ...workspaceHandlers(workspaceDeps),
    "media.open": async (_event, { entryId }) =>
      toMediaOpenResult(await sc.call("media.resolve", { entryId }), mediaTokens),
    "sidecar.getStatus": () => sc.getStatus(),
    "dialog.openFolder": async (event) => {
      // E2E tests cannot drive the native dialog; unpackaged builds accept a canned answer.
      const canned = app.isPackaged ? undefined : process.env.FASTVIEW_TEST_DIALOG_PATH
      if (canned !== undefined) return { path: canned || null }
      const win = BrowserWindow.fromWebContents(event.sender)
      const options = { title: "Open folder", properties: ["openDirectory" as const] }
      const result = await (win
        ? dialog.showOpenDialog(win, options)
        : dialog.showOpenDialog(options))
      return { path: result.canceled ? null : (result.filePaths[0] ?? null) }
    },
  }
  registerIpc(ipcMain, {
    sidecar: sc,
    main,
    origins: { viewer: trustedOrigin(devUrl), commander: commanderOrigin() },
    devMethods,
    // Shared settings (theme, interface size) reach the other app at once (ADR-0031).
    onSharedSetting: (key, value) =>
      broadcast(webContents.getAllWebContents(), "settings.changed", { key, value }),
  })

  // Sidecar and window start in parallel; calls wait for the handshake.
  sc.start()
  perfMark("sidecar-spawned")
  openWindow()
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows()
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(boot, (error: unknown) => {
    logger.error("startup failed", { error: String(error) })
    app.exit(1)
  })

  app.on("activate", () => {
    if (shutdownState === "running" && BrowserWindow.getAllWindows().length === 0) openWindow()
  })

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })

  // Hold quit until the sidecar has shut down; the second quit goes through.
  app.on("before-quit", (event) => {
    if (shutdownState === "done") return
    event.preventDefault()
    if (shutdownState === "stopping") return
    shutdownState = "stopping"
    const started = performance.now()
    void (sidecar?.stop() ?? Promise.resolve()).finally(() => {
      logger.info("shutdown complete", { sidecarStopMs: Math.round(performance.now() - started) })
      shutdownState = "done"
      app.quit()
    })
  })

  process.on("uncaughtException", (error) =>
    logger.error("uncaught exception", { error: error.stack ?? String(error) }),
  )
  process.on("unhandledRejection", (reason) =>
    logger.error("unhandled rejection", { reason: String(reason) }),
  )
}
