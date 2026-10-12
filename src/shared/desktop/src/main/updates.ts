// Updates (Stage P06, ADR-0038). Main looks for a newer version, downloads
// it when the user says so and installs it on restart; the apps only show the
// state and name the next step. Nothing here runs before the window is up:
// the first check waits, and the update library loads with it.
import {
  MAX_RELEASE_NOTES,
  MAX_RELEASE_NOTE_CHARS,
  type ReleaseNote,
  type UpdateMode,
  type UpdateState,
} from "@panelyth/contracts"

/** What a check found. */
export interface FoundUpdate {
  version: string
  releaseDate: string | null
  notes: ReleaseNote[]
}

export interface DownloadProgress {
  percent: number
  transferredBytes: number
  totalBytes: number
}

/** The part that talks to the feed and the installer; faked in tests. */
export interface UpdateEngine {
  /** null: the running version is the newest. */
  check(): Promise<FoundUpdate | null>
  download(onProgress: (progress: DownloadProgress) => void): Promise<void>
  /** Quits the app and installs the downloaded version. */
  install(): void
}

/** The first automatic check: after the window is up and the first folder is listed. */
export const FIRST_CHECK_DELAY_MS = 15_000
/** Later automatic checks, for an app left running. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
/** A download reports at most this often (and always when it ends). */
export const PROGRESS_INTERVAL_MS = 250

export interface Timers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

const nodeTimers: Timers = {
  set: (fn, ms) => {
    const handle = setTimeout(fn, ms)
    // A pending check never keeps the app alive.
    handle.unref()
    return handle
  },
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export interface UpdateServiceOptions {
  mode: UpdateMode
  currentVersion: string
  /** Called once, by the first check: loading the engine is not on the startup path. */
  engine: () => Promise<UpdateEngine>
  onState(state: UpdateState): void
  log?(message: string, fields?: Record<string, unknown>): void
  now?: () => number
  timers?: Timers
}

/**
 * What a build can do with a newer version. A development build has no feed;
 * macOS installs only into a Developer ID signed app (the build records that
 * as `signed`); a Linux build updates itself only as an AppImage.
 */
export function resolveUpdateMode(build: {
  packaged: boolean
  platform: NodeJS.Platform
  /** electron-builder wrote app-update.yml: the build names a feed. */
  hasFeed: boolean
  /** macOS: the package was signed with a Developer ID (package.json `panelythSigned`). */
  signed: boolean
  /** Linux: the path of the running AppImage, if it is one. */
  appImage: string | undefined
}): UpdateMode {
  if (!build.packaged || !build.hasFeed) return "off"
  if (build.platform === "win32") return "auto"
  if (build.platform === "darwin") return build.signed ? "auto" : "manual"
  return build.appImage ? "auto" : "manual"
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
}

/**
 * A feed's release notes as plain text. GitHub sends HTML; no markup from the
 * network reaches a renderer, so the tags go here and the text is all that is
 * shown: list items as bullets, blocks as lines.
 */
export function notesToText(notes: string): string {
  const text = notes
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<li\b[^>]*>/gi, "\n• ")
    .replace(/<\/?(br|p|div|h[1-6]|ul|ol|tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
      if (name[0] !== "#") return ENTITIES[name.toLowerCase()] ?? whole
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : +name.slice(1)
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole
    })
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
  return text.length > MAX_RELEASE_NOTE_CHARS
    ? `${text.slice(0, MAX_RELEASE_NOTE_CHARS - 1).trimEnd()}…`
    : text
}

/** electron-updater's `releaseNotes` (a string, or one entry per version) as our list. */
export function releaseNotes(
  version: string,
  notes: string | readonly { version: string; note: string | null }[] | null | undefined,
): ReleaseNote[] {
  const list =
    typeof notes === "string"
      ? [{ version, note: notes }]
      : (notes ?? []).map((n) => ({ version: n.version, note: n.note ?? "" }))
  return list
    .map((n) => ({ version: n.version, text: notesToText(n.note) }))
    .filter((n) => n.text.length > 0)
    .slice(0, MAX_RELEASE_NOTES)
}

/** A message a person can act on, whatever the library threw. */
export function updateErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  // electron-updater puts headers and stack traces after the first line.
  const first = text.split("\n", 1)[0]?.trim() ?? ""
  return (first || "the update could not be completed").slice(0, 300)
}

export class UpdateService {
  private current: UpdateState
  private engine: Promise<UpdateEngine> | null = null
  private timer: unknown = null
  private started = false
  private readonly now: () => number
  private readonly timers: Timers

  constructor(private readonly options: UpdateServiceOptions) {
    this.now = options.now ?? Date.now
    this.timers = options.timers ?? nodeTimers
    this.current = {
      mode: options.mode,
      phase: "idle",
      currentVersion: options.currentVersion,
      version: null,
      releaseDate: null,
      notes: [],
      percent: 0,
      transferredBytes: 0,
      totalBytes: 0,
      checkedAt: null,
      error: null,
      auto: true,
    }
  }

  get state(): UpdateState {
    return this.current
  }

  /** The build's mode, once main has looked for the feed. */
  setMode(mode: UpdateMode): void {
    if (mode !== this.current.mode) this.set({ mode })
  }

  /** Begins the automatic checks (if the setting allows them). */
  start(): void {
    this.started = true
    this.schedule(FIRST_CHECK_DELAY_MS)
  }

  stop(): void {
    this.started = false
    this.cancelTimer()
  }

  /** Settings → About "Check automatically" (shared.updates). */
  setAuto(auto: boolean): void {
    if (auto === this.current.auto) return
    this.set({ auto })
    if (!this.started) return
    if (auto) this.schedule(FIRST_CHECK_DELAY_MS)
    else this.cancelTimer()
  }

  /** A check the user asked for: its failure is shown. */
  check(): UpdateState {
    void this.runCheck(true)
    return this.current
  }

  download(): UpdateState {
    if (this.current.mode !== "auto" || this.current.phase !== "available") return this.current
    this.set({ phase: "downloading", percent: 0, transferredBytes: 0, totalBytes: 0, error: null })
    void this.runDownload()
    return this.current
  }

  /** True when the app is about to quit for the install. */
  install(): boolean {
    if (this.current.mode !== "auto" || this.current.phase !== "ready" || !this.engine) return false
    void this.engine.then((engine) => engine.install())
    return true
  }

  private loadEngine(): Promise<UpdateEngine> {
    this.engine ??= this.options.engine()
    // A failed load is tried again by the next check.
    this.engine.catch(() => (this.engine = null))
    return this.engine
  }

  private async runCheck(manual: boolean): Promise<void> {
    const before = this.current
    // A download in progress or a version waiting to install is never replaced by a check.
    if (before.mode === "off") return
    if (before.phase === "checking" || before.phase === "downloading" || before.phase === "ready")
      return
    this.set({ phase: "checking", error: null })
    try {
      const found = await (await this.loadEngine()).check()
      const checkedAt = this.now()
      if (found) {
        this.set({
          phase: "available",
          version: found.version,
          releaseDate: found.releaseDate,
          notes: found.notes,
          checkedAt,
        })
      } else {
        this.set({ phase: "upToDate", version: null, releaseDate: null, notes: [], checkedAt })
      }
    } catch (error) {
      const message = updateErrorMessage(error)
      this.options.log?.("update check failed", { error: message, manual })
      // An automatic check that fails changes nothing on screen: the next one tries again.
      if (manual) this.set({ phase: "error", error: message })
      else this.set({ phase: before.phase === "error" ? "idle" : before.phase })
    } finally {
      if (this.started) this.schedule(CHECK_INTERVAL_MS)
    }
  }

  private async runDownload(): Promise<void> {
    let last = 0
    try {
      const engine = await this.loadEngine()
      await engine.download((progress) => {
        const now = this.now()
        if (now - last < PROGRESS_INTERVAL_MS) return
        last = now
        this.set({
          percent: Math.min(100, Math.max(0, progress.percent)),
          transferredBytes: progress.transferredBytes,
          totalBytes: progress.totalBytes,
        })
      })
      this.set({ phase: "ready", percent: 100 })
    } catch (error) {
      const message = updateErrorMessage(error)
      this.options.log?.("update download failed", { error: message })
      // The version is still there to download again.
      this.set({ phase: "available", error: message, percent: 0 })
    }
  }

  private schedule(ms: number): void {
    this.cancelTimer()
    if (!this.current.auto || this.current.mode === "off") return
    this.timer = this.timers.set(() => {
      this.timer = null
      void this.runCheck(false)
    }, ms)
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer)
    this.timer = null
  }

  private set(patch: Partial<UpdateState>): void {
    this.current = { ...this.current, ...patch }
    this.options.onState(this.current)
  }
}

/**
 * The engine of packaged builds: electron-updater against the feed the build
 * names (app-update.yml). It verifies a download's SHA-512 against the feed
 * and, on Windows, the installer's signature against the running app's
 * publisher. Loaded by the first check, never at start.
 */
export async function electronUpdaterEngine(
  log: (level: "info" | "warn" | "error", message: string) => void,
): Promise<UpdateEngine> {
  const { autoUpdater } = await import("electron-updater")
  autoUpdater.autoDownload = false
  // A downloaded version also installs when the app is simply closed.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.allowPrerelease = false
  // Notes of every version between the running one and the newest.
  autoUpdater.fullChangelog = true
  autoUpdater.logger = {
    info: (message?: unknown) => log("info", String(message)),
    warn: (message?: unknown) => log("warn", String(message)),
    error: (message?: unknown) => log("error", String(message)),
    debug: () => undefined,
  }
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates()
      if (!result?.isUpdateAvailable) return null
      const info = result.updateInfo
      return {
        version: info.version,
        releaseDate: info.releaseDate ?? null,
        notes: releaseNotes(info.version, info.releaseNotes),
      }
    },
    async download(onProgress) {
      const listener = (p: { percent: number; transferred: number; total: number }): void =>
        onProgress({ percent: p.percent, transferredBytes: p.transferred, totalBytes: p.total })
      autoUpdater.on("download-progress", listener)
      try {
        await autoUpdater.downloadUpdate()
      } finally {
        autoUpdater.off("download-progress", listener)
      }
    },
    // Silent, and the new version starts: the user asked for a restart.
    install: () => autoUpdater.quitAndInstall(true, true),
  }
}

/**
 * A scripted engine for the e2e tests of unpackaged builds
 * (PANELYTH_TEST_UPDATE): `{"version":"9.9.9","notes":"…"}` is found and
 * "downloads"; `{}` is up to date; `{"error":"…"}` fails the check.
 */
export function scriptedEngine(script: string, onInstall: (version: string) => void): UpdateEngine {
  const parsed = JSON.parse(script) as { version?: unknown; notes?: unknown; error?: unknown }
  const version = typeof parsed.version === "string" ? parsed.version : null
  return {
    check() {
      if (typeof parsed.error === "string") return Promise.reject(new Error(parsed.error))
      if (!version) return Promise.resolve(null)
      return Promise.resolve({
        version,
        releaseDate: null,
        notes: releaseNotes(version, typeof parsed.notes === "string" ? parsed.notes : null),
      })
    },
    async download(onProgress) {
      const totalBytes = 4_000_000
      for (const percent of [25, 50, 75, 100]) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        onProgress({ percent, transferredBytes: (totalBytes * percent) / 100, totalBytes })
      }
    },
    install: () => onInstall(version ?? ""),
  }
}
