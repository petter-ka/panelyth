import type { GlyphName } from "@panelyth/ui"
import { ENTRY_ATTRS, type ContentItem } from "@panelyth/contracts"
import { currentLocale, perLocale, type Locale } from "@panelyth/i18n"
import { formatRelative, type Locale as DateFnsLocale } from "date-fns"
import { de, enUS, es, fr, hu, it, pl, ru } from "date-fns/locale"
import type { DateFormat, SizeFormat } from "./settings"

export const IS_WINDOWS = typeof navigator !== "undefined" && /win/i.test(navigator.platform)

// Numbers and dates follow the interface language (ADR-0034).
const integer = perLocale((locale) => new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }))
const dateTime = perLocale(
  (locale) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }),
)
const DATE_FNS: Record<Locale, DateFnsLocale> = { en: enUS, hu, es, it, fr, pl, ru, de }

/**
 * Size column: readable units by default, or bytes with thousands separators
 * (Settings → Panels); folders show <DIR> until calculated (UX-DESIGN "Rows").
 */
export function formatSize(item: ContentItem, format: SizeFormat = "units"): string {
  const bytes = item.kind === "dir" ? item.dirSizeBytes : item.sizeBytes
  if (bytes === undefined) return "<DIR>"
  return format === "units" ? formatBytes(bytes) : integer().format(bytes)
}

const pad = (n: number): string => String(n).padStart(2, "0")

/** Configured date format for Quick View and Commander lists in `configured` mode. */
/** A full date and time: ISO, or as the system shows it (also for the relative setting). */
export function formatDate(ms: number, format: DateFormat = "locale"): string {
  if (ms <= 0) return ""
  if (format !== "iso") return dateTime().format(ms)
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The list's Date column, as Settings → Panels → Dates says ("today at 14:05" by default). */
export function formatListDate(ms: number, format: DateFormat): string {
  if (ms <= 0) return ""
  return format === "relative"
    ? formatRelative(new Date(ms), new Date(), { locale: DATE_FNS[currentLocale()] })
    : formatDate(ms, format)
}

export function formatCount(n: number): string {
  return integer().format(n)
}

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"]

/** Human-readable binary units: bytes below 1 KB, then one decimal place. */
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

export type Glyph = GlyphName

// Pictures and videos the index does not treat as media (no decoder or no
// Chromium playback, so their kind is "file") still get the picture or video icon.
const IMAGES = new Set([
  ..."avif heic heif svg ico psd raw dng cr2 cr3 nef arw orf rw2 tga jxl eps ai".split(" "),
])
const VIDEOS = new Set([
  ..."avi wmv mpg mpeg mpe m2v flv f4v 3gp 3g2 ts mts m2ts vob ogv asf divx rm rmvb".split(" "),
])
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma", "aiff", "mid"])

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
  if (item.ext === "pdf") return "pdf"
  if (IMAGES.has(item.ext)) return "image"
  if (VIDEOS.has(item.ext)) return "video"
  if (AUDIO.has(item.ext)) return "audio"
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

/**
 * Rows from many folders (branch view, search results; Stage C06): the
 * entry's folder relative to the panel's, ending in a separator; "" for the
 * panel's own folder or a row without one.
 */
export function folderPrefix(dirPath: string | undefined, base: string): string {
  if (!dirPath || dirPath === base) return ""
  const sep = dirPath.includes("\\") ? "\\" : "/"
  const root = base.endsWith(sep) ? base : base + sep
  const rel = dirPath.startsWith(root) ? dirPath.slice(root.length) : dirPath
  return rel.endsWith(sep) ? rel : rel + sep
}
