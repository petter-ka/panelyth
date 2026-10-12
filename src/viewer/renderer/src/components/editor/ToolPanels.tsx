// Tool options (Stage 12: geometry). Each panel edits one operation of the
// edit list through the store; a panel never renders pixels itself. The
// color tools are in ColorPanels.tsx and CurvesWidget.tsx; ToolList.tsx
// picks the panel of the open tool.
import { useMemo } from "react"
import type {
  EditOp,
  EditOpKind,
  CanvasAnchor,
  CanvasParams,
  DpiParams,
  ResizeAlgorithm,
  ResizeMode,
  ResizeParams,
  RotateMode,
  RotateParams,
} from "@panelyth/contracts"
import { CANVAS_ANCHORS, MAX_DPI, MAX_EDIT_EDGE } from "@panelyth/contracts"
import { Button } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import {
  CROP_RATIOS,
  fitRatio,
  fromPixels,
  FULL,
  ratioValue,
  toPixels,
} from "../../features/editor/crop"
import {
  addOp,
  applyCrop,
  cancelCrop,
  endGesture,
  panelOp,
  setCropRect,
  setParams,
  setStraighten,
  useEditorStore,
} from "../../features/editor/editorStore"
import { Check, FillField, NumberField, PanelSection, Segmented, Select, Slider } from "./controls"

const note = "text-[0.6875rem] text-muted"

/**
 * The operation the open panel edits: the active one from the list, or the
 * tool's default until the first change. The default is made once per panel
 * (a selector must not return a new object on every call).
 */
export function useOp<K extends EditOpKind>(kind: K): Extract<EditOp, { op: K }> | null {
  const active = useEditorStore((s) =>
    s.tool === kind && s.activeId !== null
      ? (s.items.find((i) => i.id === s.activeId)?.op ?? null)
      : null,
  )
  const open = useEditorStore((s) => s.tool === kind)
  const fresh = useMemo(
    () => (open ? panelOp(useEditorStore.getState()) : null),
    // A new default when the panel opens again.
    [open],
  )
  const op = active ?? fresh
  return op && op.op === kind ? (op as Extract<EditOp, { op: K }>) : null
}

/** The picture the open panel's operation receives: its size before the operation. */
function useImage(): { width: number; height: number; dpi: number } {
  const output = useEditorStore((s) => s.output)
  const session = useEditorStore((s) => s.session)
  return {
    width: output?.width ?? session?.width ?? 1,
    height: output?.height ?? session?.height ?? 1,
    dpi: output?.dpi.x ?? session?.dpi.x ?? 0,
  }
}

export function RotatePanel() {
  const op = useOp("rotate")
  const straighten = useEditorStore((s) => s.straighten)
  if (!op) return null
  const p = op.p
  const update = (patch: Partial<RotateParams>, live = false): void =>
    setParams({ op: "rotate", p: { ...p, ...patch } }, live)
  const fine = p.angle % 90 !== 0
  return (
    <>
      <PanelSection title={t("Quarter turns")}>
        <div className="grid grid-cols-3 gap-1.5">
          <Button size="sm" onClick={() => addOp({ op: "rotate", p: { angle: -90 } })}>
            {t("Left")}
          </Button>
          <Button size="sm" onClick={() => addOp({ op: "rotate", p: { angle: 90 } })}>
            {t("Right")}
          </Button>
          <Button size="sm" onClick={() => addOp({ op: "rotate", p: { angle: 180 } })}>
            180°
          </Button>
        </div>
      </PanelSection>
      <PanelSection title={t("Any angle")}>
        <Slider
          label={t("Angle")}
          value={p.angle}
          min={-45}
          max={45}
          step={0.1}
          unit="°"
          defaultValue={0}
          onChange={(angle, live) => update({ angle }, live)}
          onCommit={endGesture}
        />
        <Button
          size="sm"
          className="w-full"
          aria-pressed={straighten}
          onClick={() => setStraighten(!straighten)}
        >
          {straighten ? t("Draw a line along the horizon…") : t("Straighten")}
        </Button>
        <p className={note}>{t("Draw a line along something that should be level or upright.")}</p>
      </PanelSection>
      <PanelSection title={t("Corners")}>
        <Segmented<RotateMode>
          label={t("Corners")}
          value={p.mode ?? "crop"}
          disabled={!fine}
          options={[
            { value: "crop", label: t("Crop"), title: t("Cut the empty corners off") },
            {
              value: "expand",
              label: t("Expand"),
              title: t("Grow the picture to keep everything"),
            },
            {
              value: "fill",
              label: t("Keep size"),
              title: t("Keep the size and fill the corners"),
            },
          ]}
          onChange={(mode) => update({ mode })}
        />
        {(p.mode ?? "crop") !== "crop" && (
          <FillField
            label={t("Corner fill")}
            value={p.fill ?? "transparent"}
            named={[{ value: "transparent", label: t("Transparent") }]}
            onChange={(fill) => update({ fill })}
          />
        )}
      </PanelSection>
    </>
  )
}

export function FlipPanel() {
  return (
    <PanelSection title={t("Flip")}>
      <div className="grid grid-cols-2 gap-1.5">
        <Button size="sm" onClick={() => addOp({ op: "flip", p: { axis: "h" } })}>
          {t("Horizontal")}
        </Button>
        <Button size="sm" onClick={() => addOp({ op: "flip", p: { axis: "v" } })}>
          {t("Vertical")}
        </Button>
      </div>
      <p className={note}>{t("Horizontal mirrors left and right; vertical, top and bottom.")}</p>
    </PanelSection>
  )
}

export function CropPanel({
  ratioId,
  onRatio,
  overlay,
  onOverlay,
}: {
  ratioId: string
  onRatio(id: string): void
  overlay: CropGuide
  onOverlay(guide: CropGuide): void
}) {
  const crop = useEditorStore((s) => s.crop)
  const image = useImage()
  // The box is drawn on the picture as it is before the crop.
  const frame = useEditorStore((s) => s.frame)
  const session = useEditorStore((s) => s.session)
  if (!crop) return null
  // While the box is open the output is the picture under it.
  const size = { w: image.width, h: image.height }
  const px = toPixels(crop.rect, size)
  const setPx = (patch: Partial<typeof px>): void =>
    setCropRect(fromPixels({ ...px, ...patch }, size))
  const pick = (id: string): void => {
    onRatio(id)
    const choice = CROP_RATIOS.find((r) => r.id === id)
    const ratio = choice ? ratioValue(choice, size) : null
    if (ratio !== null) setCropRect(fitRatio(crop.rect, ratio, size))
  }
  return (
    <>
      <PanelSection title={t("Aspect ratio")}>
        <div className="grid grid-cols-3 gap-1">
          {CROP_RATIOS.map((r) => (
            <button
              key={r.id}
              type="button"
              aria-pressed={ratioId === r.id}
              onClick={() => pick(r.id)}
              className="h-6 rounded border border-border text-[0.6875rem] text-muted hover:border-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent"
            >
              {t(r.label)}
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("Crop box (pixels)")}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <NumberField
            label={t("Left")}
            value={px.x}
            min={0}
            max={size.w - 1}
            onChange={(x) => setPx({ x, w: Math.min(px.w, size.w - x) })}
          />
          <NumberField
            label={t("Top")}
            value={px.y}
            min={0}
            max={size.h - 1}
            onChange={(y) => setPx({ y, h: Math.min(px.h, size.h - y) })}
          />
          <NumberField
            label={t("Width")}
            value={px.w}
            min={1}
            max={size.w - px.x}
            onChange={(w) => setPx({ w })}
          />
          <NumberField
            label={t("Height")}
            value={px.h}
            min={1}
            max={size.h - px.y}
            onChange={(h) => setPx({ h })}
          />
        </div>
      </PanelSection>
      <PanelSection title={t("Guides")}>
        <Segmented<CropGuide>
          label={t("Guides")}
          value={overlay}
          options={[
            { value: "thirds", label: t("Thirds") },
            { value: "golden", label: t("Golden") },
            { value: "none", label: t("None") },
          ]}
          onChange={onOverlay}
        />
      </PanelSection>
      <PanelSection>
        {crop.editing !== null && (
          <p className={note}>{t("Later edits are hidden while you adjust the crop.")}</p>
        )}
        <div className="flex gap-1.5">
          <Button size="sm" variant="primary" className="flex-1" onClick={applyCrop}>
            {t("Apply")}
          </Button>
          <Button size="sm" className="flex-1" onClick={cancelCrop}>
            {t("Cancel")}
          </Button>
        </div>
        <button
          type="button"
          className="text-[0.6875rem] text-muted underline-offset-2 hover:text-text hover:underline"
          onClick={() => setCropRect(FULL)}
          disabled={!frame || !session}
        >
          {t("Select everything")}
        </button>
      </PanelSection>
    </>
  )
}

export type CropGuide = "thirds" | "golden" | "none"

export function ResizePanel() {
  const op = useOp("resize")
  if (!op) return null
  const p = op.p
  const update = (patch: Partial<ResizeParams>): void =>
    setParams({ op: "resize", p: { ...p, ...patch } })
  const setMode = (mode: ResizeMode): void => {
    // Sensible numbers for the new mode instead of pixels read as percent.
    switch (mode) {
      case "percent":
        return update({ mode, w: 100, h: 0 })
      case "print":
        return update({ mode, w: 10, h: 0, unit: p.unit ?? "cm", dpi: p.dpi ?? 300 })
      case "fit":
      case "fill":
        return update({ mode, w: 1920, h: 1080 })
      case "pixels":
        return update({ mode, w: 1920, h: 0 })
    }
  }
  const both = p.mode === "fit" || p.mode === "fill"
  const unit = p.mode === "percent" ? "%" : p.mode === "print" ? (p.unit ?? "cm") : "px"
  const max = p.mode === "percent" ? 10000 : p.mode === "print" ? 10000 : MAX_EDIT_EDGE
  const step = p.mode === "print" ? 0.1 : 1
  return (
    <>
      <PanelSection title={t("Size")}>
        <Select<ResizeMode>
          label={t("Resize by")}
          value={p.mode}
          options={[
            { value: "pixels", label: t("Pixels") },
            { value: "percent", label: t("Percent") },
            { value: "fit", label: t("Fit within") },
            { value: "fill", label: t("Fill and crop") },
            { value: "print", label: t("Print size") },
          ]}
          onChange={setMode}
        />
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <NumberField
            label={t("Width")}
            value={p.w}
            min={both ? 1 : 0}
            max={max}
            step={step}
            unit={unit}
            onChange={(w) => update({ w })}
          />
          <NumberField
            label={t("Height")}
            value={p.h}
            min={both ? 1 : 0}
            max={max}
            step={step}
            unit={unit}
            onChange={(h) => update({ h })}
          />
        </div>
        {!both && <p className={note}>{t("Leave one side at 0 to keep the proportions.")}</p>}
        {p.mode === "print" && (
          <>
            <Segmented<"cm" | "in">
              label={t("Unit")}
              value={p.unit ?? "cm"}
              options={[
                { value: "cm", label: "cm" },
                { value: "in", label: "in" },
              ]}
              onChange={(u) => update({ unit: u })}
            />
            <NumberField
              label={t("Resolution")}
              value={p.dpi ?? 300}
              min={1}
              max={MAX_DPI}
              unit="dpi"
              onChange={(dpi) => update({ dpi })}
            />
          </>
        )}
      </PanelSection>
      <PanelSection title={t("Quality")}>
        <Select<ResizeAlgorithm>
          label={t("Resampling")}
          value={p.algo ?? "lanczos3"}
          options={[
            { value: "lanczos3", label: t("Lanczos (sharpest)") },
            { value: "catmull", label: t("Bicubic") },
            { value: "bilinear", label: t("Bilinear") },
            { value: "nearest", label: t("Nearest (pixel art)") },
          ]}
          onChange={(algo) => update({ algo })}
        />
        <Check
          label={t("Never enlarge")}
          description={t("A picture that is already smaller stays as it is.")}
          checked={p.noEnlarge ?? false}
          onChange={(noEnlarge) => update({ noEnlarge })}
        />
      </PanelSection>
    </>
  )
}

const ANCHOR_LABELS: Record<CanvasAnchor, string> = {
  nw: "↖",
  n: "↑",
  ne: "↗",
  w: "←",
  c: "•",
  e: "→",
  sw: "↙",
  s: "↓",
  se: "↘",
}

function anchorName(a: CanvasAnchor): string {
  switch (a) {
    case "nw":
      return t("Top left")
    case "n":
      return t("Top")
    case "ne":
      return t("Top right")
    case "w":
      return t("Left")
    case "c":
      return t("Center")
    case "e":
      return t("Right")
    case "sw":
      return t("Bottom left")
    case "s":
      return t("Bottom")
    case "se":
      return t("Bottom right")
  }
}

export function CanvasPanel() {
  const op = useOp("canvas")
  if (!op) return null
  const p = op.p
  const update = (patch: Partial<CanvasParams>): void =>
    setParams({ op: "canvas", p: { ...p, ...patch } })
  return (
    <>
      <PanelSection title={t("Canvas size")}>
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <NumberField
            label={t("Width")}
            value={p.w}
            min={0}
            max={MAX_EDIT_EDGE}
            unit="px"
            onChange={(w) => update({ w })}
          />
          <NumberField
            label={t("Height")}
            value={p.h}
            min={0}
            max={MAX_EDIT_EDGE}
            unit="px"
            onChange={(h) => update({ h })}
          />
        </div>
        <p className={note}>
          {t("A larger canvas adds space around the picture; a smaller one cuts it.")}
        </p>
      </PanelSection>
      <PanelSection title={t("Picture position")}>
        <div
          role="radiogroup"
          aria-label={t("Picture position")}
          className="mx-auto grid w-24 grid-cols-3 gap-0.5"
        >
          {CANVAS_ANCHORS.map((a) => (
            <button
              key={a}
              type="button"
              role="radio"
              aria-checked={(p.anchor ?? "c") === a}
              aria-label={anchorName(a)}
              onClick={() => update({ anchor: a })}
              className="grid size-7 place-items-center rounded border border-border text-xs text-muted hover:border-muted aria-checked:border-accent aria-checked:bg-raised aria-checked:text-accent"
            >
              <span aria-hidden="true">{ANCHOR_LABELS[a]}</span>
            </button>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t("New area")}>
        <FillField
          label={t("New area")}
          value={p.fill ?? "transparent"}
          named={[
            { value: "transparent", label: t("Transparent") },
            { value: "edge", label: t("Edge") },
          ]}
          onChange={(fill) => update({ fill })}
        />
      </PanelSection>
    </>
  )
}

export function DpiPanel() {
  const op = useOp("dpi")
  const image = useImage()
  if (!op) return null
  const p = op.p
  const update = (patch: Partial<DpiParams>): void =>
    setParams({ op: "dpi", p: { ...p, ...patch } })
  const inches = (px: number): string => (px / p.x).toFixed(2)
  const cm = (px: number): string => ((px / p.x) * 2.54).toFixed(1)
  return (
    <PanelSection title={t("Resolution")}>
      <NumberField
        label={t("Pixels per inch")}
        value={p.x}
        min={1}
        max={MAX_DPI}
        unit="dpi"
        onChange={(x) => update({ x })}
      />
      <Check
        label={t("Resample to keep the print size")}
        description={t("Otherwise only the number written to the file changes.")}
        checked={p.resample ?? false}
        onChange={(resample) => update({ resample })}
      />
      <p className={note}>
        {t("Prints at {w} × {h} cm ({wi} × {hi} in).", {
          w: cm(image.width),
          h: cm(image.height),
          wi: inches(image.width),
          hi: inches(image.height),
        })}
      </p>
    </PanelSection>
  )
}
