import type { Properties, SelectionInfo } from "@panelyth/contracts"
import {
  Button,
  describeAttributes,
  DialogWindow,
  EntryProperties,
  PropertyRow,
  SelectionProperties,
  type PropertiesFormat,
  fieldClass as field,
} from "@panelyth/ui"
import { useEffect, useMemo, useState } from "react"
import { bridge, PanelythError } from "../bridge"
import {
  closeAttributes,
  closeProperties,
  cycleBit,
  openAttributes,
  PERMISSION_COLUMNS,
  PERMISSION_ROWS,
  startAttributes,
  toDateInput,
  updateAttributes,
  useAttributesStore,
  WINDOWS_ATTRS,
  type AttributesDialogState,
  type PropertiesTarget,
  type Tri,
} from "../features/attributes"
import { openHashCreate } from "../features/compare"
import { inArchive } from "../features/files"
import { formatBytes, formatCount, formatDate } from "../features/format"
import { useSettingsStore } from "../features/settings"
import { t } from "@panelyth/i18n"

/**
 * Change attributes (Stage C09, CFR-23): the Windows attributes or, on
 * other systems, the permission bits, each set, cleared or left as it is;
 * the modified and accessed dates; optionally everything below the folders.
 */
export function AttributesDialog() {
  const d = useAttributesStore((s) => s.dialog)
  if (!d) return null
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) closeAttributes()
      }}
      title={t("Change attributes of {what}", { what: d.what })}
      contentClassName="w-[min(30rem,calc(100vw-2rem))]"
    >
      <form
        className="flex flex-col gap-3 text-xs"
        data-testid="attributes-dialog"
        onSubmit={(e) => {
          e.preventDefault()
          void startAttributes()
        }}
      >
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-muted">
            {d.windows ? t("Attributes") : t("Permissions")}
          </legend>
          {d.windows ? <WindowsBits d={d} /> : <PermissionBits d={d} />}
          <p className="text-2xs text-muted">
            {t("✓ sets it, an empty box clears it, – leaves it as it is.")}
          </p>
          {d.current && (
            <p className="text-2xs text-muted" data-testid="attributes-current">
              {t("Now: {attributes}", { attributes: describeAttributes(d.current) })}
            </p>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-muted">{t("Dates")}</legend>
          <DateField
            label={t("Modified")}
            value={d.modified}
            onChange={(modified) => updateAttributes({ modified })}
          />
          <DateField
            label={t("Accessed")}
            value={d.accessed}
            onChange={(accessed) => updateAttributes({ accessed })}
          />
          <p className="text-2xs text-muted">{t("An empty date stays as it is.")}</p>
        </fieldset>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={d.recursive}
            onChange={(e) => updateAttributes({ recursive: e.target.checked })}
          />
          {t("Also everything inside the folders")}
        </label>
        {d.error && (
          <p role="alert" className="text-danger">
            {d.error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button onClick={closeAttributes}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" disabled={d.busy}>
            {t("Change")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}

/** A box with three states: set (✓), clear (empty), keep (–). */
function TriBox({
  value,
  label,
  onCycle,
  autoFocus,
}: {
  value: Tri
  label: string
  onCycle(): void
  autoFocus?: boolean
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={value === "keep" ? "mixed" : value === "set"}
      aria-label={label}
      autoFocus={autoFocus}
      onClick={onCycle}
      className="group flex items-center gap-2 rounded outline-none"
    >
      <span
        aria-hidden="true"
        className="grid size-4 place-items-center rounded border border-border bg-canvas text-2xs leading-none group-focus-visible:border-accent"
      >
        {value === "set" ? "✓" : value === "keep" ? "–" : ""}
      </span>
    </button>
  )
}

function WindowsBits({ d }: { d: AttributesDialogState }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
      {WINDOWS_ATTRS.map((a, i) => (
        <span key={a.bit} className="flex items-center gap-2">
          <TriBox
            value={d.bits[a.bit] ?? "keep"}
            label={t(a.label)}
            autoFocus={i === 0}
            onCycle={() => cycleBit(a.bit)}
          />
          <span aria-hidden="true">{t(a.label)}</span>
        </span>
      ))}
    </div>
  )
}

function PermissionBits({ d }: { d: AttributesDialogState }) {
  return (
    <div className="grid grid-cols-[auto_repeat(3,minmax(0,1fr))] items-center gap-x-4 gap-y-1.5">
      <span />
      {PERMISSION_COLUMNS.map((c) => (
        <span key={c} className="text-muted" aria-hidden="true">
          {t(c)}
        </span>
      ))}
      {PERMISSION_ROWS.map((row, r) => (
        <span key={row.first} className="contents">
          <span>{t(row.label)}</span>
          {PERMISSION_COLUMNS.map((c, i) => {
            const bit = row.first >> i
            return (
              <TriBox
                key={bit}
                value={d.bits[bit] ?? "keep"}
                label={`${t(row.label)}: ${t(c)}`}
                autoFocus={r === 0 && i === 0}
                onCycle={() => cycleBit(bit)}
              />
            )
          })}
        </span>
      ))}
    </div>
  )
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange(value: string): void
}) {
  return (
    <label className="grid grid-cols-[5.5rem_minmax(0,1fr)_auto] items-center gap-2">
      <span>{label}</span>
      <input
        type="datetime-local"
        step={1}
        aria-label={label}
        className={`${field} tabular-nums`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <Button size="sm" onClick={() => onChange(toDateInput(Date.now()))}>
        {t("Now")}
      </Button>
    </label>
  )
}

type Loaded =
  | { kind: "entry"; props: Properties }
  | { kind: "selection"; info: SelectionInfo }
  | { kind: "error"; message: string }

function load(target: PropertiesTarget): Promise<Loaded> {
  return target.kind === "entry"
    ? bridge.properties(target.id).then((props) => ({ kind: "entry" as const, props }))
    : bridge.selectionInfo(target.selection).then((info) => ({ kind: "selection" as const, info }))
}

/**
 * Properties (Alt+Enter, Stage C09): the rows the viewer's dialog shows
 * (`@panelyth/ui`), with attributes or permissions and where a link points,
 * and buttons to change the attributes and to create checksums.
 */
export function PropertiesDialog() {
  const open = useAttributesStore((s) => s.properties)
  const dateFormat = useSettingsStore((s) => s.settings.dateFormat)
  const format = useMemo<PropertiesFormat>(
    () => ({ bytes: formatBytes, count: formatCount, date: (ms) => formatDate(ms, dateFormat) }),
    [dateFormat],
  )
  const target = open?.target ?? null
  const [loaded, setLoaded] = useState<{ for: PropertiesTarget; value: Loaded } | null>(null)

  useEffect(() => {
    if (!target) return
    let live = true
    load(target)
      .catch((error: unknown) => ({
        kind: "error" as const,
        message: error instanceof PanelythError ? error.message : String(error),
      }))
      .then((value) => live && setLoaded({ for: target, value }))
    return () => {
      live = false
    }
  }, [target])

  if (!open || !target) return null
  const value = loaded && loaded.for === target ? loaded.value : null
  let title = t("Properties")
  if (value?.kind === "entry") title = value.props.name
  else if (target.kind === "selection")
    title = t("{count, plural, one {# item} other {# items}} marked", { count: target.count })
  // Inside an archive nothing can be changed or hashed in place.
  const changeable = !inArchive(open.side) && value?.kind !== "error"
  const then = (next: () => void): void => {
    closeProperties()
    next()
  }

  return (
    <DialogWindow open onOpenChange={(next) => !next && closeProperties()} title={title}>
      <div className="flex flex-col gap-4">
        <dl
          className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs"
          data-testid="properties"
          aria-busy={value === null}
        >
          {value === null && <PropertyRow label="">{t("Loading…")}</PropertyRow>}
          {value?.kind === "entry" && (
            <EntryProperties p={value.props} format={format} attributes />
          )}
          {value?.kind === "selection" && <SelectionProperties info={value.info} format={format} />}
          {value?.kind === "error" && <PropertyRow label={t("Error")}>{value.message}</PropertyRow>}
        </dl>
        <div className="flex justify-end gap-2 text-xs">
          <Button disabled={!changeable} onClick={() => then(() => openAttributes(open.side))}>
            {t("Change attributes…")}
          </Button>
          <Button disabled={!changeable} onClick={() => then(() => openHashCreate(open.side))}>
            {t("Checksums…")}
          </Button>
          <Button variant="primary" autoFocus onClick={closeProperties}>
            {t("Done")}
          </Button>
        </div>
      </div>
    </DialogWindow>
  )
}
