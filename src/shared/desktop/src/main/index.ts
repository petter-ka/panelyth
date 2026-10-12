import { ASSET_EXTENSIONS, editorHandlers } from "./editor"
import { SAVE_EXTENSIONS } from "@panelyth/contracts"
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ClipboardItem,
  ipcMain,
  safeStorage,
  session,
  shell,
  webContents,
} from "electron"
import { handleAppProtocol, registerAppScheme } from "./appProtocol"
import { spawn } from "node:child_process"
import {
  handleMediaProtocol,
  MediaTokens,
  toFileOpenResult,
  toMediaOpenResult,
} from "./mediaProtocol"
import { handleThumbProtocol } from "./thumbProtocol"
import { DocumentWindows } from "./documentWindow"
import { MediaWindows } from "./mediaWindow"
import { fileArgument, OpenWithSession } from "./openWith"
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
  documentsDevUrl,
  documentsDistPath,
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
  DOCUMENTS_HOST,
  DOCUMENTS_ORIGIN,
  hardenSession,
  originOf,
  trustedOrigin,
} from "./security"
import { AppShell, startAppFrom } from "./shell"
import {
  COMMANDER_ENABLED_ARG,
  documentKindOf,
  type AppId,
  type OpenRequest,
} from "@panelyth/contracts"
import { SidecarProcess } from "./sidecar/SidecarProcess"
import { createMainWindow } from "./window"
import { pngSize, workspaceHandlers, type WorkspaceDeps } from "./workspace"
import { shellRunHandlers, startInvocation, writeListFile } from "./shellRun"
import { statSync } from "node:fs"
import { stat } from "node:fs/promises"
import { join } from "node:path"
import { perfMark } from "./perf"
import { electronSecretStore, noSecretStore, remoteHandlers } from "./remote"

// Recorded once all main-process modules (including electron) are loaded.
perfMark("main-loaded")

// Dev-only RPC methods (system.echo) exist for benchmarks; never in packaged builds.
const devMethods = !app.isPackaged && process.env.PANELYTH_DEV_METHODS === "1"

// Packaged builds include and enable the commander; development can still hide
// it with the feature flag (ADR-0031).
const commanderEnabled = app.isPackaged || process.env.PANELYTH_COMMANDER === "1"
// Tests and benchmarks may choose the app shown at start. Unpackaged only;
// otherwise the last used app opens (shared.context, ADR-0031).
const envStartApp = app.isPackaged ? undefined : process.env.PANELYTH_START_APP
const forcedStartApp: AppId | null = !commanderEnabled
  ? "viewer"
  : envStartApp === "commander" || envStartApp === "viewer"
    ? envStartApp
    : null
// The window does not wait longer than this for the last used app.
const START_APP_WAIT_MS = 400

// Tests and benchmarks run each launch with a fresh profile (localStorage,
// logs) so stored preferences cannot leak between runs. Unpackaged only.
const userDataOverride = app.isPackaged ? undefined : process.env.PANELYTH_USER_DATA_DIR
if (userDataOverride) app.setPath("userData", userDataOverride)

registerAppScheme()

// Benchmark hook (main process only, like __panelythPerf).
;(globalThis as { __panelythIpcCounts?: () => Record<string, number> }).__panelythIpcCounts =
  ipcInvokeCounts

// E2E tests must not launch apps, open file managers or touch the user's
// clipboard: unpackaged builds can record those calls instead.
const recordShell = !app.isPackaged && process.env.PANELYTH_TEST_SHELL === "record"
const shellLog: { action: string; value: string }[] = []
;(globalThis as { __panelythShellLog?: typeof shellLog }).__panelythShellLog = shellLog

let sidecar: SidecarProcess | null = null
let appShell: AppShell | null = null
let mainWindow: BrowserWindow | null = null
let documentWindows: DocumentWindows | null = null
let mediaWindows: MediaWindows | null = null
let logger: Logger = consoleLogger
let shutdownState: "running" | "stopping" | "done" = "running"

// "Open with" (ADR-0033 amended): a picture or video the OS handed over opens
// in a media window of its own, and the main window is not created for it.
const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}
/** The file an argument list names; the app's own entry script is none. */
const fileFrom = (argv: readonly string[], cwd: string): string | null =>
  fileArgument(argv, cwd, isFile, [app.getAppPath()])
/** The file this run was started for; macOS names it with open-file, also before the app is ready. */
let startFile: string | null = fileFrom(process.argv, process.cwd())
/** Main's handlers are registered: files can open. */
let booted = false
/** A file's folder and entry waiting for the viewer to start (app.openRequest takes it). */
let pendingOpen: OpenRequest | null = null

const documentsOrigin = (): string => {
  const devUrl = documentsDevUrl()
  return (devUrl && originOf(devUrl)) || DOCUMENTS_ORIGIN
}

const commanderOrigin = (): string => {
  const devUrl = commanderDevUrl()
  return (devUrl && originOf(devUrl)) || COMMANDER_ORIGIN
}

/**
 * A file from the OS in a full-screen media window of its own. A file that
 * turns out to be no picture or video opens the app as usual instead.
 */
function openFile(path: string): void {
  const sc = sidecar
  const windows = mediaWindows
  if (!sc || !windows) return
  perfMark("open-with")
  const session = new OpenWithSession((method, params) => sc.call(method, params), path)
  let win: BrowserWindow | null = null
  const unavailable = (reason: unknown): void => {
    logger.warn("a file from the OS could not be shown", { reason: String(reason) })
    if (!mainWindow && shutdownState === "running") openWindow()
    if (win && !win.isDestroyed()) win.close()
  }
  win = windows.open({
    source: {
      step: async (direction) => {
        try {
          const item = await session.step(direction)
          if (!item && direction === 0) unavailable("not in its folder")
          return item
        } catch (error) {
          if (direction === 0) unavailable(error)
          throw error
        }
      },
      current: () => session.current(),
      close: () => session.close(),
    },
  })
}

/** The viewer shows a folder with an entry selected: in the window that is there, or in a new one. */
function revealInViewer(request: OpenRequest): void {
  const viewer = mainWindow && !mainWindow.isDestroyed() ? appShell?.showViewer() : null
  if (viewer && !viewer.isLoading()) {
    broadcast([viewer], "open.request", request)
    return
  }
  // The viewer asks for it when it starts (app.openRequest).
  pendingOpen = request
  if (!viewer) openWindow()
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
  mainWindow = win
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = null
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
  const shell = appShell
  // Opened to show a file's folder: the viewer, whichever app was used last.
  if (pendingOpen) return win
  if (forcedStartApp === "commander") shell.switchTo("commander")
  else if (forcedStartApp === null)
    void lastUsedApp().then((last) => {
      // Only before the user did anything: a late answer never moves them.
      if (last === "commander" && shell.activeApp === "viewer" && !shell.switched) {
        shell.switchTo("commander")
      }
    })
  return win
}

/** Settings → General "Start with", else the app the previous run ended in. */
async function lastUsedApp(): Promise<AppId | null> {
  if (!sidecar) return null
  const sc = sidecar
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), START_APP_WAIT_MS))
  const read = sc
    .call("library.get", {})
    .then((r) => startAppFrom((r as { settings?: Record<string, unknown> }).settings ?? {}))
    .catch(() => null)
  return Promise.race([read, timeout])
}

// Test hook (main process only): which app is shown and whether the commander view exists.
;(globalThis as { __panelythShellState?: () => object }).__panelythShellState = () => ({
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
  const devUrls = [devUrl, commanderDevUrl(), documentsDevUrl()].filter(
    (u): u is string => u !== null,
  )
  hardenSession(
    session.defaultSession,
    [trustedOrigin(devUrl), commanderOrigin()],
    devUrls,
    [commanderOrigin(), documentsOrigin()],
    documentsOrigin(),
  )
  handleAppProtocol({
    [APP_HOST]: rendererDistPath(),
    [COMMANDER_HOST]: commanderDistPath(),
    [DOCUMENTS_HOST]: documentsDistPath(),
  })
  documentWindows = new DocumentWindows(
    {
      url: documentsDevUrl() ?? `${DOCUMENTS_ORIGIN}/index.html`,
      origin: documentsOrigin(),
      devTools: !app.isPackaged,
    },
    () => mainWindow,
  )
  mediaWindows = new MediaWindows(
    {
      url: new URL("media.html", `${commanderDevUrl() ?? COMMANDER_ORIGIN}/`).toString(),
      origin: commanderOrigin(),
      preload: commanderPreloadPath(),
      devTools: !app.isPackaged,
    },
    () => mainWindow,
  )

  const sc = new SidecarProcess({
    binaryPath: sidecarBinaryPath(),
    logger,
    logLevel: app.isPackaged ? "info" : "debug",
    env: devMethods ? { PANELYTH_DEV_METHODS: "1" } : { PANELYTH_DEV_METHODS: "" },
  })
  sidecar = sc
  // The thumbnail root comes from the sidecar's hello, never from the renderer.
  handleThumbProtocol(() => sc.getHello()?.thumbnailRoot ?? null)
  const mediaTokens = new MediaTokens()
  // The editor's frames (Stage 12): the last few are enough, a frame is loaded at once.
  const frameTokens = new MediaTokens(16)
  // Preset thumbnails (Stage 13): two batches' worth.
  const thumbTokens = new MediaTokens(48)
  handleMediaProtocol(mediaTokens, frameTokens, thumbTokens)
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
    launch: (file, args) => {
      if (recordShell) {
        shellLog.push({ action: "launch", value: [file, ...args].join("|") })
        return Promise.resolve()
      }
      // Detached, no shell, no inherited stdio: the editor outlives nothing of ours.
      return new Promise((resolve, reject) => {
        const child = spawn(file, [...args], { detached: true, stdio: "ignore", shell: false })
        child.once("error", reject)
        child.once("spawn", () => {
          child.unref()
          resolve()
        })
      })
    },
    platform: process.platform,
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
    // Viewer, once at start: what a file opened from the OS asked it to show.
    "app.openRequest": () => {
      const request = pendingOpen
      pendingOpen = null
      return { request }
    },
    "app.switch": (_event, { to, edit }) => {
      // Edit in the media overlay or the media window (Stage 12): the viewer
      // comes to the front and opens its editor on the picture. The viewer is
      // always there, so this works without the commander too.
      if (edit !== undefined) {
        if (!appShell) throw new Error("no window")
        const viewer = appShell.showViewer()
        if (viewer) broadcast([viewer], "edit.request", { entryId: edit })
        return { ok: true }
      }
      if (!appShell?.enabled) throw new Error("the commander is not enabled")
      appShell.requestSwitch(to)
      return { ok: true }
    },
    // Viewer only (the allowlist): frames, saves and reveals of the image editor (Stage 12).
    ...editorHandlers({
      call: (method, params) => sc.call(method, params),
      tokens: frameTokens,
      thumbTokens,
      saveDialog: async (event, { defaultPath, format }) => {
        // E2E tests cannot drive the native dialog; unpackaged builds accept a canned answer.
        const canned = app.isPackaged ? undefined : process.env.PANELYTH_TEST_SAVE_PATH
        if (canned !== undefined) return canned || null
        const win = BrowserWindow.fromWebContents(event.sender)
        const options = {
          defaultPath,
          filters: [{ name: format.toUpperCase(), extensions: [...SAVE_EXTENSIONS[format]] }],
        }
        const result = await (win
          ? dialog.showSaveDialog(win, options)
          : dialog.showSaveDialog(options))
        return result.canceled || !result.filePath ? null : result.filePath
      },
      showItemInFolder: (path) => {
        if (recordShell) shellLog.push({ action: "reveal", value: path })
        else shell.showItemInFolder(path)
      },
      folderDialog: async (event) => {
        // As for the other dialogs: unpackaged builds accept a canned answer for the e2e tests.
        const canned = app.isPackaged ? undefined : process.env.PANELYTH_TEST_BATCH_FOLDER
        if (canned !== undefined) return canned || null
        const win = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = {
          title: "Folder for the edited pictures",
          properties: ["openDirectory", "createDirectory"],
        }
        const result = await (win
          ? dialog.showOpenDialog(win, options)
          : dialog.showOpenDialog(options))
        return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
      },
      openDialog: async (event, { defaultPath }) => {
        // As for the save dialog: unpackaged builds accept a canned answer for the e2e tests.
        const canned = app.isPackaged ? undefined : process.env.PANELYTH_TEST_ASSET_PATH
        if (canned !== undefined) return canned || null
        const win = BrowserWindow.fromWebContents(event.sender)
        const options: Electron.OpenDialogOptions = {
          defaultPath,
          properties: ["openFile"],
          filters: [{ name: "Pictures", extensions: [...ASSET_EXTENSIONS] }],
        }
        const result = await (win
          ? dialog.showOpenDialog(win, options)
          : dialog.showOpenDialog(options))
        return result.canceled || !result.filePaths[0] ? null : result.filePaths[0]
      },
    }),
    ...workspaceHandlers(workspaceDeps),
    // Commander only (the allowlist): the command line and user commands (Stage C10).
    ...shellRunHandlers({
      call: (method, params) => sc.call(method, params),
      start: async (invocation) => {
        if (recordShell) {
          const { file, args, cwd, env } = invocation
          shellLog.push({ action: "run", value: JSON.stringify({ file, args, cwd, env }) })
          return
        }
        await startInvocation(invocation)
      },
      // The commander's own view, and only while it is the app shown: a media
      // window runs on the commander's origin but never runs commands.
      allowed: (event) =>
        appShell?.activeApp === "commander" && event.sender === appShell.webContentsOf("commander"),
      log: (message, fields) => logger.info(message, fields),
      writeList: (paths) => writeListFile(join(app.getPath("userData"), "command-lists"), paths),
      isDir: (path) =>
        stat(path).then(
          (s) => s.isDirectory(),
          () => false,
        ),
      exists: (path) =>
        stat(path).then(
          () => true,
          () => false,
        ),
      platform: process.platform,
      processEnv: process.env,
    }),
    "media.open": async (_event, { entryId }) =>
      toMediaOpenResult(await sc.call("media.resolve", { entryId }), mediaTokens),
    // Both apps: an image or video in a frameless full-screen window (ADR-0033).
    "media.openWindow": async (event, { entryId, key, theme, lang }) => {
      const r = await sc.call("media.resolve", { entryId })
      // Main decides from the resolved entry; the window is for media only.
      if (r.kind !== "image" && r.kind !== "video")
        throw new Error("this file cannot be shown in a media window")
      mediaWindows?.open({
        opener: event.sender,
        key,
        entryId,
        ...(theme && { theme }),
        ...(lang && { lang }),
      })
      return { ok: true }
    },
    // The media window asks its opener for a neighbour; the opener answers.
    "media.windowStep": async (event, { direction }) => ({
      item: (await mediaWindows?.step(event.sender, direction)) ?? null,
    }),
    "media.windowAnswer": (event, { requestId, item }) => {
      mediaWindows?.answer(event.sender, requestId, item)
      return { ok: true }
    },
    // The media window of a file opened from the OS: its picture in the viewer, at its
    // folder. Only such a window may ask; what is shown is what main gave it.
    "media.windowReveal": (event) => {
      const request = mediaWindows?.sourceOf(event.sender)?.current()
      if (!request) throw new Error("this window was not opened for a file")
      revealInViewer(request)
      // After the main window exists, so the app never has no window in between.
      const win = BrowserWindow.fromWebContents(event.sender)
      setImmediate(() => {
        if (win && !win.isDestroyed()) win.close()
      })
      return { ok: true }
    },
    // Commander only (the allowlist); the token may be fetch()ed by its origin alone.
    "file.open": async (_event, { entryId }) =>
      toFileOpenResult(await sc.call("file.resolve", { entryId }), mediaTokens, commanderOrigin()),
    // Commander only: a PDF or text file in a document window (ADR-0033).
    "document.open": async (_event, { entryId, theme, lang }) => {
      const r = await sc.call("file.resolve", { entryId })
      // Main decides from the resolved path; no token is minted for anything else.
      if (!documentKindOf(r.path)) throw new Error("this file is not a document")
      const { url } = toFileOpenResult(r, mediaTokens, documentsOrigin())
      documentWindows?.open({
        tokenUrl: url,
        path: r.path,
        sizeBytes: r.sizeBytes,
        ...(theme && { theme }),
        ...(lang && { lang }),
      })
      return { ok: true }
    },
    // Commander only (the allowlist): connections whose passwords pass through main (ADR-0037).
    ...remoteHandlers(
      (method, params) => sc.call(method, params as never),
      // Tests force a computer without a secret store (no password is saved there).
      process.env.PANELYTH_TEST_NO_SECRET_STORE === "1"
        ? noSecretStore
        : electronSecretStore(safeStorage),
    ),
    "sidecar.getStatus": () => sc.getStatus(),
    "dialog.openFolder": async (event) => {
      // E2E tests cannot drive the native dialog; unpackaged builds accept a canned answer.
      const canned = app.isPackaged ? undefined : process.env.PANELYTH_TEST_DIALOG_PATH
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
    activeApp: () => appShell?.activeApp ?? "viewer",
    // Shared settings (theme, interface size) reach the other app at once (ADR-0031).
    onSharedSetting: (key, value) =>
      broadcast(webContents.getAllWebContents(), "settings.changed", { key, value }),
  })

  // Sidecar and window start in parallel; calls wait for the handshake.
  sc.start()
  perfMark("sidecar-spawned")
  booted = true
  // A file from the OS: its media window alone. The app's window is made when it is asked for.
  if (startFile) openFile(startFile)
  else openWindow()
  startFile = null
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv, cwd) => {
    // Another file opened from the OS while the app runs: one more media window.
    const file = fileFrom(argv, cwd)
    if (file && booted) {
      openFile(file)
      return
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    } else if (booted && shutdownState === "running") {
      // Only media windows so far: the app itself was asked for now.
      openWindow()
    }
  })

  // macOS hands files over with an event, possibly before the app is ready.
  app.on("open-file", (event, path) => {
    event.preventDefault()
    if (booted) openFile(path)
    else startFile = path
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
