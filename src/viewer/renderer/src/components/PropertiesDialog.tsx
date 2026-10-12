import type { Properties, SelectionInfo } from "@panelyth/contracts"
import {
  EntryProperties,
  PropertyRow,
  SelectionProperties,
  type PropertiesFormat,
} from "@panelyth/ui"
import { useEffect, useState } from "react"
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
import { t } from "@panelyth/i18n"

type Loaded =
  | { kind: "entry"; props: Properties }
  | { kind: "selection"; info: SelectionInfo }
  | { kind: "error"; message: string }

const FORMAT: PropertiesFormat = { bytes: formatBytes, count: formatCount, date: formatDate }

/** The viewer's own rows: favorite, rating, label and tags (files only). */
function UserRows({ p }: { p: Properties }) {
  if (p.kind === "dir") return null
  return (
    <>
      <PropertyRow label={t("Favorite")}>{p.favorite ? t("Yes") : t("No")}</PropertyRow>
      <PropertyRow label={t("Rating")}>
        {p.rating > 0 ? "★".repeat(p.rating) : t("Not rated")}
      </PropertyRow>
      <PropertyRow label={t("Label")}>
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
      </PropertyRow>
      <PropertyRow label={t("Tags")}>
        {p.tags.length > 0 ? p.tags.join(", ") : t("None")}
      </PropertyRow>
    </>
  )
}

function load(target: PropertiesTarget): Promise<Loaded> {
  return target.kind === "entry"
    ? bridge.properties(target.id).then((props) => ({ kind: "entry" as const, props }))
    : bridge.selectionInfo(target.selection).then((info) => ({ kind: "selection" as const, info }))
}

/**
 * Properties for one entry (live stat) or a multi-selection (count and size
 * from the index). The rows are shared with the commander (`@panelyth/ui`).
 */
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
        {value === null && <PropertyRow label="">{t("Loading…")}</PropertyRow>}
        {value?.kind === "entry" && (
          <EntryProperties p={value.props} format={FORMAT} user={<UserRows p={value.props} />} />
        )}
        {value?.kind === "selection" && <SelectionProperties info={value.info} format={FORMAT} />}
        {value?.kind === "error" && <PropertyRow label={t("Error")}>{value.message}</PropertyRow>}
      </dl>
    </DialogWindow>
  )
}
