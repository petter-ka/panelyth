import type { BrowserWindow, Rectangle } from "electron"
import { readFile, rename, writeFile } from "node:fs/promises"

// The main window's size, place and maximized state, kept between runs.
// Electron main owns window state (ARCHITECTURE.md): a small file in the
// user-data folder, read before the app is ready, so the window opens at its
// size without waiting for the sidecar.

export interface WindowState {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

/** What the window is created with: no x and y means Electron centers it. */
export interface InitialBounds {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

export const DEFAULT_SIZE = { width: 1440, height: 900 }
export const MIN_SIZE = { width: 720, height: 480 }

/** How much of the window's top edge must be on a display for it to be reached and moved. */
const VISIBLE_TOP = { width: 120, height: 32 }

/** A resize or move is saved once it has rested this long. */
const SAVE_DELAY_MS = 1000

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v)

/** The stored state, or null when it is missing or not ours. */
export function parseWindowState(text: string): WindowState | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== "object" || value === null) return null
  const { v, x, y, width, height, maximized } = value as Record<string, unknown>
  if (v !== 1 || !isInt(x) || !isInt(y) || !isInt(width) || !isInt(height)) return null
  if (width <= 0 || height <= 0) return null
  return { x, y, width, height, maximized: maximized === true }
}

const overlap = (a: Rectangle, b: Rectangle): { width: number; height: number } => ({
  width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
  height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
})

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(v, max))

/**
 * Where the window opens. The saved place when its top edge is on a display
 * (a display may be gone or smaller since), else the saved size centered;
 * the size never exceeds the display it opens on.
 */
export function initialBounds(
  saved: WindowState | null,
  workAreas: readonly Rectangle[],
): InitialBounds {
  if (!saved) return { ...DEFAULT_SIZE, maximized: false }
  const top = { x: saved.x, y: saved.y, width: saved.width, height: VISIBLE_TOP.height }
  const area = workAreas.find((a) => {
    const o = overlap(top, a)
    return o.width >= Math.min(VISIBLE_TOP.width, saved.width) && o.height >= VISIBLE_TOP.height
  })
  const fit = area ?? workAreas[0]
  const width = fit
    ? clamp(saved.width, MIN_SIZE.width, Math.max(MIN_SIZE.width, fit.width))
    : saved.width
  const height = fit
    ? clamp(saved.height, MIN_SIZE.height, Math.max(MIN_SIZE.height, fit.height))
    : saved.height
  if (!area) return { width, height, maximized: saved.maximized }
  // Shrunk to the display: kept inside it.
  const x = clamp(saved.x, area.x, area.x + area.width - width)
  const y = clamp(saved.y, area.y, area.y + area.height - height)
  return { x, y, width, height, maximized: saved.maximized }
}

export interface WindowStateFileDeps {
  read: (path: string) => Promise<string>
  /** Replaces the file whole: a crash mid-write never leaves half a file. */
  write: (path: string, text: string) => Promise<void>
  log: (message: string, fields: Record<string, unknown>) => void
}

export const fsDeps = (log: WindowStateFileDeps["log"]): WindowStateFileDeps => ({
  read: (path) => readFile(path, "utf8"),
  write: async (path, text) => {
    const tmp = `${path}.tmp`
    await writeFile(tmp, text, "utf8")
    await rename(tmp, path)
  },
  log,
})

/** The window state file: loaded once, then kept up to date by the window it tracks. */
export class WindowStateFile {
  private state: WindowState | null = null
  private readonly loaded: Promise<void>
  private timer: ReturnType<typeof setTimeout> | null = null
  private written = ""
  /** One write at a time, in order. */
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly path: string,
    private readonly deps: WindowStateFileDeps,
  ) {
    this.loaded = deps.read(path).then(
      (text) => {
        this.written = text
        this.state = parseWindowState(text)
      },
      () => undefined,
    )
  }

  /** Settles once the file was read (or found missing); never rejects. */
  ready(): Promise<void> {
    return this.loaded
  }

  /** The last known state: the file's, then the window's. */
  get current(): WindowState | null {
    return this.state
  }

  /** Saves the window's state as it is resized, moved, maximized and closed. */
  track(win: BrowserWindow): void {
    const later = (): void => this.later(win)
    win.on("resize", later)
    win.on("move", later)
    win.on("maximize", later)
    win.on("unmaximize", later)
    win.on("enter-full-screen", later)
    win.on("leave-full-screen", later)
    win.on("close", () => this.save(win))
  }

  /** Waits for the pending save; quitting holds for it. */
  flush(): Promise<void> {
    return this.writing
  }

  private later(win: BrowserWindow): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (!win.isDestroyed()) this.save(win)
    }, SAVE_DELAY_MS)
  }

  /** Saves the window's state now; quitting on macOS comes before the window's close. */
  save(win: BrowserWindow): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    // A minimized window keeps the maximized state it had; full screen opens maximized.
    const maximized = win.isMinimized()
      ? (this.state?.maximized ?? false)
      : win.isMaximized() || win.isFullScreen()
    // The size the window has when it is neither maximized, minimized nor full screen.
    const { x, y, width, height } = win.getNormalBounds()
    this.state = { x, y, width, height, maximized }
    const text = JSON.stringify({ v: 1, ...this.state })
    if (text === this.written) return
    this.written = text
    this.writing = this.writing
      .then(() => this.deps.write(this.path, text))
      .catch((error: unknown) => {
        // The next save tries again.
        if (this.written === text) this.written = ""
        this.deps.log("the window state was not saved", { error: String(error) })
      })
  }
}
