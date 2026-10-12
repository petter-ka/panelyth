// The properties of an entry or of a selection, as the rows of a definition
// list (Stage 05; shared with the commander in Stage C09, ADR-0031). Each app
// brings its own dialog, formatters and extra rows.
import type { Properties, SelectionInfo } from "@panelyth/contracts"
import type { ReactNode } from "react"
import { msg, t } from "@panelyth/i18n"

const KIND = {
  dir: msg("Folder"),
  image: msg("Image"),
  video: msg("Video"),
  file: msg("File"),
  link: msg("Link"),
} as const

// Properties.attrs bits (ENTRY_ATTRS in @panelyth/contracts; this package
// imports its types only).
const ATTR_NAMES: readonly [number, string][] = [
  [4, msg("Read-only")],
  [1, msg("Hidden")],
  [2, msg("System")],
  [8, msg("Archive")],
]

/** How an app writes sizes, counts and dates. */
export interface PropertiesFormat {
  bytes(n: number): string
  count(n: number): string
  date(ms: number): string
}

export function PropertyRow({
  label,
  children,
  mono = false,
}: {
  label: string
  children: ReactNode
  mono?: boolean
}) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className={`min-w-0 break-words select-text ${mono ? "font-mono" : ""}`}>{children}</dd>
    </>
  )
}

/** Permission bits as `rwxr-xr-x`. */
export function formatPermissions(mode: number): string {
  let out = ""
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (mode >> shift) & 7
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-")
  }
  return out
}

/** "Read-only, Hidden", or permissions as `rwxr-xr-x (755)` outside Windows. */
export function describeAttributes(p: Pick<Properties, "attrs" | "permissions">): string {
  if (p.permissions !== null)
    return `${formatPermissions(p.permissions)} (${p.permissions.toString(8).padStart(3, "0")})`
  const names = ATTR_NAMES.filter(([bit]) => ((p.attrs ?? 0) & bit) !== 0).map(([, name]) =>
    t(name),
  )
  return names.length > 0 ? names.join(", ") : t("None")
}

/**
 * The rows of one entry. `user` goes between what the entry is and its
 * dates (the viewer's favorite, rating, label and tags); `attributes` adds
 * the attributes or permissions and where a link points.
 */
export function EntryProperties({
  p,
  format,
  user,
  attributes = false,
}: {
  p: Properties
  format: PropertiesFormat
  user?: ReactNode
  attributes?: boolean
}) {
  const date = (ms: number | null) => (ms === null ? t("Not available") : format.date(ms))
  return (
    <>
      <PropertyRow label={t("Type")}>
        {p.kind === "dir" ? (
          t("Folder")
        ) : p.ext === "" ? (
          t(KIND[p.kind])
        ) : (
          <>
            {t(KIND[p.kind])} (<span className="font-mono">{p.ext.toUpperCase()}</span>)
          </>
        )}
      </PropertyRow>
      <PropertyRow label={t("Location")} mono>
        <span data-testid="props-path">{p.path}</span>
      </PropertyRow>
      {attributes && p.linkTarget !== null && (
        <PropertyRow label={t("Points to")} mono>
          <span data-testid="props-link">{p.linkTarget}</span>
        </PropertyRow>
      )}
      {p.kind !== "dir" && (
        <PropertyRow label={t("Size")} mono>
          {t("{size} ({bytes} bytes)", {
            size: format.bytes(p.sizeBytes),
            bytes: format.count(p.sizeBytes),
          })}
        </PropertyRow>
      )}
      {p.width !== null && p.height !== null && (
        <PropertyRow label={t("Dimensions")} mono>
          {format.count(p.width)} × {format.count(p.height)}
        </PropertyRow>
      )}
      {p.kind === "dir" && (
        <PropertyRow label={t("Contains")} mono>
          {p.childFolders === null || p.childMedia === null
            ? t("Not listed yet")
            : t(
                "{folders, plural, one {# folder} other {# folders}}, {media, plural, one {# image or video} other {# images and videos}}",
                { folders: p.childFolders, media: p.childMedia },
              )}
        </PropertyRow>
      )}
      {user}
      {attributes && (
        <PropertyRow label={p.permissions !== null ? t("Permissions") : t("Attributes")} mono>
          <span data-testid="props-attrs">{describeAttributes(p)}</span>
        </PropertyRow>
      )}
      <PropertyRow label={t("Created")} mono>
        {date(p.createdMs)}
      </PropertyRow>
      <PropertyRow label={t("Modified")} mono>
        {format.date(p.modifiedMs)}
      </PropertyRow>
      <PropertyRow label={t("Accessed")} mono>
        {date(p.accessedMs)}
      </PropertyRow>
      {!p.exists && (
        <PropertyRow label={t("Status")}>
          {t("The file was moved or deleted since it was indexed.")}
        </PropertyRow>
      )}
    </>
  )
}

/** The rows of a selection: what is in it and its size from the index. */
export function SelectionProperties({
  info,
  format,
}: {
  info: SelectionInfo
  format: PropertiesFormat
}) {
  const others = info.count - info.folders - info.images - info.videos
  const parts = [
    info.folders > 0 &&
      t("{count, plural, one {# folder} other {# folders}}", { count: info.folders }),
    info.images > 0 && t("{count, plural, one {# image} other {# images}}", { count: info.images }),
    info.videos > 0 && t("{count, plural, one {# video} other {# videos}}", { count: info.videos }),
    others > 0 && t("{count, plural, one {# other file} other {# other files}}", { count: others }),
  ].filter(Boolean)
  return (
    <>
      <PropertyRow label={t("Selected")} mono>
        {parts.join(", ") || t("Nothing")}
      </PropertyRow>
      <PropertyRow label={t("Total size")} mono>
        {t("{size} ({bytes} bytes)", {
          size: format.bytes(info.bytes),
          bytes: format.count(info.bytes),
        })}
      </PropertyRow>
      {info.folders > 0 && (
        <PropertyRow label={t("Note")}>{t("Folder sizes are not included.")}</PropertyRow>
      )}
    </>
  )
}
