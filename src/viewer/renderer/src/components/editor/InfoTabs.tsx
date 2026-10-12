// The editor's read-only panels: EXIF tags and file properties (Stage 12),
// and Count colors (Stage 13).
import { useEffect, useState } from "react"
import type { ColorScope, EditInfoGroup, EditInfoGroupName, Properties } from "@panelyth/contracts"
import { Button, EntryProperties, PropertyRow, Tooltip, type PropertiesFormat } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { bridge } from "../../bridge"
import { notify } from "../../features/clipboard/clipboard"
import {
  countColors,
  loadInfo,
  refreshEstimate,
  setSaveOptions,
  useEditorStore,
} from "../../features/editor/editorStore"
import { formatBytes, formatCount, formatDate, formatPercent } from "../../lib/format"
import { Swatches } from "./ColorPanels"
import { Check, Segmented } from "./controls"

const FORMAT: PropertiesFormat = { bytes: formatBytes, count: formatCount, date: formatDate }

function groupName(name: EditInfoGroupName): string {
  switch (name) {
    case "camera":
      return t("Camera")
    case "lens":
      return t("Lens")
    case "exposure":
      return t("Exposure")
    case "date":
      return t("Date")
    case "gps":
      return t("Location")
    case "software":
      return t("Software and author")
    case "image":
      return t("Image")
  }
}

/** Tag names; an unknown tag shows its EXIF name. */
function tagName(id: string): string {
  switch (id) {
    case "Make":
      return t("Maker")
    case "Model":
      return t("Model")
    case "LensMake":
      return t("Lens maker")
    case "LensModel":
      return t("Lens")
    case "FocalLength":
      return t("Focal length")
    case "FocalLength35":
      return t("Focal length (35 mm)")
    case "ExposureTime":
      return t("Shutter speed")
    case "FNumber":
      return t("Aperture")
    case "ISO":
      return "ISO"
    case "ExposureBias":
      return t("Exposure compensation")
    case "ExposureProgram":
      return t("Exposure program")
    case "MeteringMode":
      return t("Metering")
    case "Flash":
      return t("Flash")
    case "WhiteBalance":
      return t("White balance")
    case "DateTimeOriginal":
      return t("Taken")
    case "DateTimeDigitized":
      return t("Digitized")
    case "DateTime":
      return t("Changed")
    case "GPSLatitude":
      return t("Latitude")
    case "GPSLongitude":
      return t("Longitude")
    case "GPSAltitude":
      return t("Altitude")
    case "Software":
      return t("Software")
    case "Artist":
      return t("Author")
    case "Copyright":
      return t("Copyright")
    case "ImageDescription":
      return t("Description")
    case "ExifImageSize":
      return t("Recorded size")
    case "Resolution":
      return t("Resolution")
    case "ColorSpace":
      return t("Color space")
  }
  return id
}

/** Values from fixed lists; anything else is shown as Go formatted it. */
function codeText(code: string): string | null {
  switch (code) {
    case "manual":
      return t("Manual")
    case "program":
      return t("Program")
    case "aperturePriority":
      return t("Aperture priority")
    case "shutterPriority":
      return t("Shutter priority")
    case "creative":
      return t("Creative")
    case "action":
      return t("Action")
    case "portrait":
      return t("Portrait")
    case "landscape":
      return t("Landscape")
    case "average":
      return t("Average")
    case "centerWeighted":
      return t("Center-weighted")
    case "spot":
      return t("Spot")
    case "multiSpot":
      return t("Multi-spot")
    case "pattern":
      return t("Matrix")
    case "partial":
      return t("Partial")
    case "auto":
      return t("Auto")
    case "flashFired":
      return t("Fired")
    case "flashOff":
      return t("Did not fire")
    case "sRGB":
      return "sRGB"
    case "uncalibrated":
      return t("Uncalibrated")
  }
  return null
}

const valueOf = (item: { value: string; code?: string }): string =>
  (item.code ? codeText(item.code) : null) ?? item.value

function copy(text: string): void {
  void bridge
    .copyText(text)
    .then(() => notify(t("Copied")))
    .catch(() => undefined)
}

function ExifTab({ groups }: { groups: readonly EditInfoGroup[] | null }) {
  const metadata = useEditorStore((s) => s.saveOptions.metadata)
  if (groups === null) return <p className="px-3 py-3 text-2xs text-muted">{t("Loading…")}</p>
  if (groups.length === 0) {
    return (
      <p className="px-3 py-3 text-2xs text-muted" data-testid="exif-empty">
        {t("This picture has no EXIF data.")}
      </p>
    )
  }
  const all = groups
    .flatMap((g) => g.items.map((i) => `${tagName(i.id)}: ${valueOf(i)}`))
    .join("\n")
  return (
    <div className="space-y-3 px-3 py-2.5" data-testid="exif">
      {groups.map((g) => (
        <section key={g.name} aria-label={groupName(g.name)}>
          <h4 className="mb-1 text-2xs font-medium text-muted">{groupName(g.name)}</h4>
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-2 gap-y-1 text-xs">
            {g.items.map((item) => (
              <div key={item.id} className="contents">
                <dt className="truncate text-muted">{tagName(item.id)}</dt>
                <dd className="min-w-0">
                  <Tooltip content={t("Copy")}>
                    <button
                      type="button"
                      className="max-w-full truncate text-left hover:underline"
                      aria-label={t("Copy {name}: {value}", {
                        name: tagName(item.id),
                        value: valueOf(item),
                      })}
                      onClick={() => copy(valueOf(item))}
                    >
                      {valueOf(item)}
                    </button>
                  </Tooltip>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <div className="flex items-center gap-3 border-t border-border pt-2">
        <button
          type="button"
          className="text-2xs text-muted underline-offset-2 hover:text-text hover:underline"
          onClick={() => copy(all)}
        >
          {t("Copy all")}
        </button>
      </div>
      <Check
        label={t("Remove this data when saving")}
        description={t("The color profile is kept.")}
        checked={metadata === "strip"}
        onChange={(strip) => setSaveOptions({ metadata: strip ? "strip" : "keep" })}
      />
    </div>
  )
}

function FileTab() {
  const entry = useEditorStore((s) => s.entry)
  const output = useEditorStore((s) => s.output)
  const estimate = useEditorStore((s) => s.estimate)
  const items = useEditorStore((s) => s.items)
  const options = useEditorStore((s) => s.saveOptions)
  const [props, setProps] = useState<Properties | null>(null)
  const id = entry?.id
  useEffect(() => {
    if (id === undefined) return
    let live = true
    void bridge
      .properties(id)
      .then((p) => live && setProps(p))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [id])
  // The estimate follows the list and the save options, after a pause.
  useEffect(() => {
    const timer = setTimeout(() => void refreshEstimate(), 400)
    return () => clearTimeout(timer)
  }, [items, options])
  return (
    <dl
      className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 px-3 py-2.5 text-xs"
      data-testid="editor-file"
    >
      {output && (
        <PropertyRow label={t("Edited size")}>
          {t("{w} × {h} pixels", { w: formatCount(output.width), h: formatCount(output.height) })}
        </PropertyRow>
      )}
      {output && output.dpi.x > 0 && (
        <PropertyRow label={t("Resolution")}>{`${Math.round(output.dpi.x)} dpi`}</PropertyRow>
      )}
      <PropertyRow label={t("Saved size")}>
        {estimate === null ? "…" : t("about {size}", { size: formatBytes(estimate) })}
      </PropertyRow>
      {props && <EntryProperties p={props} format={FORMAT} user={null} />}
    </dl>
  )
}

/**
 * Count colors: the exact number of distinct colors and the dominant ones.
 * It reads the whole picture, so it runs when asked, never by itself; the
 * answer belongs to the edit list it was counted for.
 */
function ColorsTab() {
  const [scope, setScope] = useState<Exclude<ColorScope, "preview">>("edited")
  const mine = useEditorStore((s) => s.colors[scope]) ?? null
  const busy = useEditorStore((s) => s.colorsBusy)
  const items = useEditorStore((s) => s.items)
  // The original never changes; the edited picture does with every edit.
  const stale = mine !== null && scope === "edited" && mine.items !== items
  const result = mine && !stale ? mine.result : null
  const list = result
    ? result.palette.map((s) => `${s.hex}\t${formatPercent(s.share)}`).join("\n")
    : ""
  return (
    <div className="space-y-2 px-3 py-2.5" data-testid="editor-colors">
      <Segmented<Exclude<ColorScope, "preview">>
        label={t("Picture to count")}
        value={scope}
        options={[
          { value: "edited", label: t("Edited") },
          { value: "original", label: t("Original") },
        ]}
        onChange={setScope}
      />
      <Button
        size="sm"
        className="w-full"
        disabled={busy !== null}
        onClick={() => void countColors(scope, 32)}
      >
        {busy === scope ? t("Counting…") : t("Count colors")}
      </Button>
      {busy === scope && (
        <span
          role="progressbar"
          aria-label={t("Counting…")}
          className="editor-progress block h-0.5 w-full"
        />
      )}
      {stale && (
        <p className="text-2xs text-muted">{t("The picture has changed since the last count.")}</p>
      )}
      {result && (
        <div className="space-y-2" data-testid="colors-result" role="status">
          <p className="text-xs">
            <span className="text-base font-medium tabular-nums" data-testid="colors-distinct">
              {formatCount(result.distinct)}
            </span>{" "}
            {t("distinct colors")}
          </p>
          <p className="text-2xs text-muted">
            {t("{w} × {h} pixels", {
              w: formatCount(result.width),
              h: formatCount(result.height),
            })}
            {result.hasAlpha && ` · ${t("with transparency")}`}
          </p>
          <h4 className="text-2xs font-medium text-muted">{t("Most common colors")}</h4>
          <Swatches palette={result.palette} />
          <button
            type="button"
            className="text-2xs text-muted underline-offset-2 hover:text-text hover:underline"
            onClick={() => copy(list)}
          >
            {t("Copy the list")}
          </button>
        </div>
      )}
    </div>
  )
}

type Tab = "exif" | "file" | "colors"

export function InfoTabs() {
  const [tab, setTab] = useState<Tab>("exif")
  const info = useEditorStore((s) => s.info)
  const ready = useEditorStore((s) => s.status === "ready")
  useEffect(() => {
    if (ready && tab === "exif") void loadInfo()
  }, [ready, tab])
  const tabs: readonly { id: Tab; label: string }[] = [
    { id: "exif", label: "EXIF" },
    { id: "file", label: t("File") },
    { id: "colors", label: t("Colors") },
  ]
  return (
    <section aria-label={t("Picture information")} data-testid="editor-info">
      <div role="tablist" aria-label={t("Picture information")} className="flex gap-1 px-3 pt-2">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`editor-tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`editor-tabpanel-${item.id}`}
            onClick={() => setTab(item.id)}
            className="h-7 rounded-md px-2.5 text-2xs text-muted hover:text-text aria-selected:bg-raised aria-selected:text-text"
          >
            {item.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`editor-tabpanel-${tab}`} aria-labelledby={`editor-tab-${tab}`}>
        {tab === "exif" ? (
          <ExifTab groups={info} />
        ) : !ready ? null : tab === "file" ? (
          <FileTab />
        ) : (
          <ColorsTab />
        )}
      </div>
    </section>
  )
}
