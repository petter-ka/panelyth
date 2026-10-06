import { ENTRY_ATTRS, type ContentItem } from "@fastview/contracts"
import { formatRelative } from "date-fns"
import type { DateFormat, SizeFormat } from "./settings"

const IS_WINDOWS = typeof navigator !== "undefined" && /win/i.test(navigator.platform)

const integer = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 })
const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" })

/**
 * Size column: bytes with thousands separators, or KB/MB/GB (Settings →
 * Panels); folders show <DIR> until calculated (UX-DESIGN "Rows").
 */
export function formatSize(item: ContentItem, format: SizeFormat = "bytes"): string {
  const bytes = item.kind === "dir" ? item.dirSizeBytes : item.sizeBytes
  if (bytes === undefined) return "<DIR>"
  return format === "units" ? formatBytes(bytes) : integer.format(bytes)
}

const pad = (n: number): string => String(n).padStart(2, "0")

/** Configured date format for Quick View and Commander lists in `configured` mode. */
export function formatDate(ms: number, format: DateFormat = "locale"): string {
  if (ms <= 0) return ""
  if (format === "locale") return dateTime.format(ms)
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Switch to `configured` to use the existing locale/ISO date setting in Commander lists. */
export type ListDateMode = "relative" | "configured"
export const COMMANDER_LIST_DATE_MODE: ListDateMode = "relative"

/** Commander list dates use relative labels by default; Quick View keeps the configured formatter. */
export function formatListDate(
  ms: number,
  configuredFormat: DateFormat,
  mode: ListDateMode = COMMANDER_LIST_DATE_MODE,
): string {
  if (ms <= 0) return ""
  return mode === "relative"
    ? formatRelative(new Date(ms), new Date())
    : formatDate(ms, configuredFormat)
}

export function formatCount(n: number): string {
  return integer.format(n)
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

/** Status line sizes: 1 decimal from KB up. */
export function formatBytes(bytes: number): string {
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`
}

/**
 * Attr column: `rhsa` on Windows (dashes for unset bits); elsewhere the
 * owner's read-only and executable bits as `r-x` / `rwx` plus h for hidden.
 */
export function formatAttrs(attrs = 0, windows = IS_WINDOWS): string {
  const has = (bit: number): boolean => (attrs & bit) !== 0
  if (windows) {
    return [
      has(ENTRY_ATTRS.readOnly) ? "r" : "-",
      has(ENTRY_ATTRS.hidden) ? "h" : "-",
      has(ENTRY_ATTRS.system) ? "s" : "-",
      has(ENTRY_ATTRS.archive) ? "a" : "-",
    ].join("")
  }
  return [
    "r",
    has(ENTRY_ATTRS.readOnly) ? "-" : "w",
    has(ENTRY_ATTRS.executable) ? "x" : "-",
    has(ENTRY_ATTRS.hidden) ? "h" : "-",
  ].join("")
}

/** Hidden and system entries are shown muted (UX-DESIGN "Rows"). */
export const isMuted = (item: ContentItem): boolean =>
  ((item.attrs ?? 0) & (ENTRY_ATTRS.hidden | ENTRY_ATTRS.system)) !== 0

export type Glyph = "folder" | "image" | "video" | "archive" | "text" | "program" | "link" | "other"

const ARCHIVES = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"])
const TEXTS = new Set(["txt", "md", "log", "csv", "json", "xml", "yaml", "yml", "ini", "toml"])
const PROGRAMS = new Set(["exe", "msi", "bat", "cmd", "ps1", "com", "sh", "app"])

/** The type glyph per row (no per-file OS icons in the first release). */
export function glyphOf(item: ContentItem): Glyph {
  switch (item.kind) {
    case "dir":
      return "folder"
    case "image":
      return "image"
    case "video":
      return "video"
    case "link":
      return "link"
  }
  if (ARCHIVES.has(item.ext)) return "archive"
  if (TEXTS.has(item.ext)) return "text"
  if (PROGRAMS.has(item.ext) || ((item.attrs ?? 0) & ENTRY_ATTRS.executable) !== 0) return "program"
  return "other"
}

/** Name without the extension; the extension has its own column. */
export function baseName(item: ContentItem): string {
  if (item.kind === "dir" || item.ext === "") return item.name
  const cut = item.name.length - item.ext.length - 1
  return cut > 0 && item.name[cut] === "." ? item.name.slice(0, cut) : item.name
}
