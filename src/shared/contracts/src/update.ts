// The product's version, its updates and the native menu (Stage P06, ADR-0038).
// Electron main owns all of it: a renderer names what it wants, never a URL,
// a path or a file to run.

/**
 * What this build can do about a newer version:
 * - "auto": download it and install it on restart;
 * - "manual": find it and show its notes; the release page has the download
 *   (a macOS build without a Developer ID signature, a Linux tar.gz);
 * - "off": nothing (a development build, or a build with no update feed).
 */
export const UPDATE_MODES = ["auto", "manual", "off"] as const
export type UpdateMode = (typeof UPDATE_MODES)[number]

export const UPDATE_PHASES = [
  /** Not checked in this run. */
  "idle",
  "checking",
  "upToDate",
  /** A newer version exists; nothing is downloaded. */
  "available",
  "downloading",
  /** Downloaded and verified; it installs when the app restarts or quits. */
  "ready",
  "error",
] as const
export type UpdatePhase = (typeof UPDATE_PHASES)[number]

/** The most notes a state carries, and the most text of one (the release page has the rest). */
export const MAX_RELEASE_NOTES = 20
export const MAX_RELEASE_NOTE_CHARS = 8_000

/** One version's changes as plain text: main strips the markup a feed sends. */
export interface ReleaseNote {
  version: string
  text: string
}

export interface UpdateState {
  mode: UpdateMode
  phase: UpdatePhase
  /** The running version. */
  currentVersion: string
  /** The newer version (available, downloading, ready); null otherwise. */
  version: string | null
  /** ISO date of the newer version's release, when the feed names one. */
  releaseDate: string | null
  /** Newest first: every version between the running one and the newest. */
  notes: ReleaseNote[]
  /** While downloading. */
  percent: number
  transferredBytes: number
  totalBytes: number
  /** Epoch ms of the last finished check in this run; null before it. */
  checkedAt: number | null
  /** Why the last check or download failed (phase "error"). */
  error: string | null
  /** Settings: look for a newer version at start and every few hours. */
  auto: boolean
}

/** The library setting both apps read and write; main follows it. */
export const SHARED_UPDATES_KEY = "shared.updates"

export interface SharedUpdateSettings {
  v: 1
  auto: boolean
}

export const DEFAULT_UPDATE_SETTINGS: SharedUpdateSettings = { v: 1, auto: true }

/** Tolerant reader: anything unknown is the default. */
export function readUpdateSettings(value: unknown): SharedUpdateSettings {
  const auto = (value as { auto?: unknown } | null | undefined)?.auto
  return { v: 1, auto: typeof auto === "boolean" ? auto : DEFAULT_UPDATE_SETTINGS.auto }
}

/** What Settings → About shows beside the update state. */
export interface AboutInfo {
  /** The product's name and version (one version for the shell, both apps and the sidecar). */
  name: string
  version: string
  /** The sidecar's own report (hello); null until it is ready. It equals `version` in a release build. */
  sidecarVersion: string | null
  electron: string
  chrome: string
  node: string
  /** "win32 x64", "darwin arm64", … */
  platform: string
  packaged: boolean
  copyright: string
}

/**
 * What main opens for the Help menu and the About tab. Each is a fixed place:
 * a folder of the app's own, a file it ships, or a page of the project.
 */
export const APP_TARGETS = ["logs", "notices", "releases", "issues", "website"] as const
export type AppTarget = (typeof APP_TARGETS)[number]

export interface AppOpenTargetParams {
  target: AppTarget
}

/** A native menu item the visible app carries out (main sends it to that app's view only). */
export const MENU_COMMANDS = ["about", "checkForUpdates", "settings", "shortcuts"] as const
export type MenuCommand = (typeof MENU_COMMANDS)[number]

export interface MenuCommandEvent {
  command: MenuCommand
}

const isRec = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === "string"

const isReleaseNote = (v: unknown): v is ReleaseNote =>
  isRec(v) &&
  typeof v.version === "string" &&
  typeof v.text === "string" &&
  v.text.length <= MAX_RELEASE_NOTE_CHARS

export function isUpdateState(v: unknown): v is UpdateState {
  return (
    isRec(v) &&
    (UPDATE_MODES as readonly unknown[]).includes(v.mode) &&
    (UPDATE_PHASES as readonly unknown[]).includes(v.phase) &&
    typeof v.currentVersion === "string" &&
    isStrOrNull(v.version) &&
    isStrOrNull(v.releaseDate) &&
    Array.isArray(v.notes) &&
    v.notes.length <= MAX_RELEASE_NOTES &&
    v.notes.every(isReleaseNote) &&
    typeof v.percent === "number" &&
    v.percent >= 0 &&
    v.percent <= 100 &&
    isCount(v.transferredBytes) &&
    isCount(v.totalBytes) &&
    (v.checkedAt === null || isCount(v.checkedAt)) &&
    isStrOrNull(v.error) &&
    typeof v.auto === "boolean"
  )
}

export const isMenuCommandEvent = (v: unknown): v is MenuCommandEvent =>
  isRec(v) && (MENU_COMMANDS as readonly unknown[]).includes(v.command)
