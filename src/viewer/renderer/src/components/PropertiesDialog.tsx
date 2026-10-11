import type { Properties, SelectionInfo } from "@panelyth/contracts"
import { useEffect, useState, type ReactNode } from "react"
import { bridge } from "../bridge"
import { describeError } from "../features/folder/folderStore"
import { labelColor, labelName } from "../features/labels/labels"
import {
  closeProperties,
  usePropertiesStore,
  type PropertiesTarget,
} from "../features/properties/propertiesStore"
import { formatBytes, formatCount, formatDate } from "../lib/format"
import { DialogWindow } from "./ui/dialog"
import { msg, t } from "@panelyth/i18n"

const KIND = {
  dir: msg("Folder"),
  image: msg("Image"),
  video: msg("Video"),
  file: msg("File"),
  link: msg("Link"),
} as const

type Loaded =
  | { kind: "entry"; props: Properties }
  | { kind: "selection"; info: SelectionInfo }
  | { kind: "error"; message: string }

function Row({
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

function EntryRows({ p }: { p: Properties }) {
  const date = (ms: number | null) => (ms === null ? t("Not available") : formatDate(ms))
  return (
    <>
      <Row label={t("Type")}>
        {p.kind === "dir" ? (
          t("Folder")
        ) : (
          <>
            {t(KIND[p.kind])} (<span className="font-mono">{p.ext.toUpperCase()}</span>)
          </>
        )}
      </Row>
      <Row label={t("Location")} mono>
        <span data-testid="props-path">{p.path}</span>
      </Row>
      {p.kind !== "dir" && (
        <Row label={t("Size")} mono>
          {t("{size} ({bytes} bytes)", {
            size: formatBytes(p.sizeBytes),
            bytes: formatCount(p.sizeBytes),
          })}
        </Row>
      )}
      {p.width !== null && p.height !== null && (
        <Row label={t("Dimensions")} mono>
          {formatCount(p.width)} × {formatCount(p.height)}
        </Row>
      )}
      {p.kind === "dir" && (
        <Row label={t("Contains")} mono>
          {p.childFolders === null || p.childMedia === null
            ? t("Not listed yet")
            : t(
                "{folders, plural, one {# folder} other {# folders}}, {media, plural, one {# image or video} other {# images and videos}}",
                { folders: p.childFolders, media: p.childMedia },
              )}
        </Row>
      )}
      {p.kind !== "dir" && (
        <>
          <Row label={t("Favorite")}>{p.favorite ? t("Yes") : t("No")}</Row>
          <Row label={t("Rating")}>{p.rating > 0 ? "★".repeat(p.rating) : t("Not rated")}</Row>
          <Row label={t("Label")}>
            {p.label > 0 ? (
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden="true"
                  className="size-2.5 rounded-full"
                  style={{ background: labelColor(p.label) ?? undefined }}
                />
                {labelName(p.label)}
              </span>
            ) : (
              t("None")
            )}
          </Row>
          <Row label={t("Tags")}>{p.tags.length > 0 ? p.tags.join(", ") : t("None")}</Row>
        </>
      )}
      <Row label={t("Created")} mono>
        {date(p.createdMs)}
      </Row>
      <Row label={t("Modified")} mono>
        {formatDate(p.modifiedMs)}
      </Row>
      <Row label={t("Accessed")} mono>
        {date(p.accessedMs)}
      </Row>
      {!p.exists && (
        <Row label={t("Status")}>{t("The file was moved or deleted since it was indexed.")}</Row>
      )}
    </>
  )
}

function SelectionRows({ info }: { info: SelectionInfo }) {
  const parts = [
    info.folders > 0 &&
      t("{count, plural, one {# folder} other {# folders}}", { count: info.folders }),
    info.images > 0 && t("{count, plural, one {# image} other {# images}}", { count: info.images }),
    info.videos > 0 && t("{count, plural, one {# video} other {# videos}}", { count: info.videos }),
  ].filter(Boolean)
  return (
    <>
      <Row label={t("Selected")} mono>
        {parts.join(", ") || t("Nothing")}
      </Row>
      <Row label={t("Total size")} mono>
        {t("{size} ({bytes} bytes)", {
          size: formatBytes(info.bytes),
          bytes: formatCount(info.bytes),
        })}
      </Row>
      {info.folders > 0 && <Row label={t("Note")}>{t("Folder sizes are not included.")}</Row>}
    </>
  )
}

function load(target: PropertiesTarget): Promise<Loaded> {
  return target.kind === "entry"
    ? bridge.properties(target.id).then((props) => ({ kind: "entry" as const, props }))
    : bridge.selectionInfo(target.selection).then((info) => ({ kind: "selection" as const, info }))
}

/** Properties for one entry (live stat) or a multi-selection (count and size from the index). */
export function PropertiesDialog() {
  const target = usePropertiesStore((s) => s.target)
  const [loaded, setLoaded] = useState<{ for: PropertiesTarget; value: Loaded } | null>(null)

  useEffect(() => {
    if (!target) return
    let live = true
    load(target)
      .catch((error: unknown) => ({ kind: "error" as const, message: describeError(error) }))
      .then((value) => live && setLoaded({ for: target, value }))
    return () => {
      live = false
    }
  }, [target])

  const value = loaded && loaded.for === target ? loaded.value : null
  let title = t("Properties")
  if (value?.kind === "entry") title = value.props.name
  else if (target?.kind === "selection")
    title = t("{count, plural, one {# item} other {# items}} selected", { count: target.count })

  return (
    <DialogWindow
      open={target !== null}
      onOpenChange={(open) => !open && closeProperties()}
      title={title}
    >
      <dl
        className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"
        data-testid="properties"
        aria-busy={value === null}
      >
        {value === null && <Row label="">{t("Loading…")}</Row>}
        {value?.kind === "entry" && <EntryRows p={value.props} />}
        {value?.kind === "selection" && <SelectionRows info={value.info} />}
        {value?.kind === "error" && <Row label={t("Error")}>{value.message}</Row>}
      </dl>
    </DialogWindow>
  )
}
