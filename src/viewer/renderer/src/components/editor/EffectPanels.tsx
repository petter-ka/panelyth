// Tool options for the effects (Stage 14): border, frame mask, watermark,
// obscure, lens, bump map, sketch and oil painting. As everywhere in the
// editor a panel edits one operation of the edit list; sizes are percentages
// of the picture's shorter edge, so the same values fit any picture. A
// picture for a watermark, a mask or a texture is picked in Electron main's
// dialog: the panel only ever holds its id and a thumbnail token.
import { useEffect, useRef } from "react"
import type {
  BorderParams,
  BorderStyle,
  BumpParams,
  CanvasAnchor,
  FrameMaskParams,
  FrameShape,
  LensMode,
  LensParams,
  NormalizedRect,
  ObscureMethod,
  ObscureParams,
  ObscureShape,
  OilParams,
  SketchParams,
  SketchStyle,
  WatermarkBlend,
  WatermarkParams,
} from "@panelyth/contracts"
import { CANVAS_ANCHORS, MAX_POLYGON_POINTS, MAX_WATERMARK_CHARS } from "@panelyth/contracts"
import { Button, fieldLook } from "@panelyth/ui"
import { msg, t } from "@panelyth/i18n"
import {
  endGesture,
  loadFonts,
  pickAsset,
  setParams,
  useEditorStore,
} from "../../features/editor/editorStore"
import { ColorWell, note, ResetButton, Sliders, type Spec } from "./ColorPanels"
import { Check, FillField, NumberField, PanelSection, Segmented, Select, Slider } from "./controls"
import { useOp } from "./ToolPanels"

const pct = { min: 0, max: 100 } as const

/** The picture an effect uses, and the button that picks one in the native dialog. */
function AssetPicker({
  assetId,
  label,
  onPick,
}: {
  assetId: string | undefined
  label: string
  onPick(assetId: string): void
}) {
  const asset = useEditorStore((s) => (assetId ? s.assets[assetId] : undefined))
  const busy = useEditorStore((s) => s.picking)
  return (
    <div className="space-y-1.5" data-testid="asset-picker">
      <div className="flex items-center gap-2">
        <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded border border-border bg-canvas">
          {asset && (
            <img src={asset.thumbUrl} alt="" draggable={false} className="max-h-full max-w-full" />
          )}
        </span>
        <span className="min-w-0 flex-1 text-2xs">
          <span className="block truncate text-text" data-testid="asset-name">
            {asset
              ? asset.name
              : assetId
                ? t("A picture from another session")
                : t("No picture chosen")}
          </span>
          {asset && (
            <span className="block text-muted tabular-nums">
              {asset.width} × {asset.height}
            </span>
          )}
        </span>
      </div>
      <Button
        size="sm"
        className="w-full"
        disabled={busy}
        onClick={() =>
          void pickAsset().then((picked) => {
            if (picked) onPick(picked.assetId)
          })
        }
      >
        {label}
      </Button>
    </div>
  )
}

/** The nine places a mark can sit. */
function AnchorGrid({
  label,
  value,
  onChange,
}: {
  label: string
  value: CanvasAnchor
  onChange(anchor: CanvasAnchor): void
}) {
  const arrows: Record<CanvasAnchor, string> = {
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
  const names: Record<CanvasAnchor, string> = {
    nw: t("Top left"),
    n: t("Top"),
    ne: t("Top right"),
    w: t("Left"),
    c: t("Center"),
    e: t("Right"),
    sw: t("Bottom left"),
    s: t("Bottom"),
    se: t("Bottom right"),
  }
  return (
    <div role="radiogroup" aria-label={label} className="mx-auto grid w-24 grid-cols-3 gap-0.5">
      {CANVAS_ANCHORS.map((a) => (
        <button
          key={a}
          type="button"
          role="radio"
          aria-checked={value === a}
          aria-label={names[a]}
          onClick={() => onChange(a)}
          className="grid size-7 place-items-center rounded border border-border text-xs text-muted hover:border-muted aria-checked:border-accent aria-checked:bg-raised aria-checked:text-accent"
        >
          <span aria-hidden="true">{arrows[a]}</span>
        </button>
      ))}
    </div>
  )
}

// --- border ---

export function BorderPanel() {
  const op = useOp("border")
  if (!op) return null
  const p: BorderParams = op.p
  const style = p.style ?? "solid"
  const px = p.unit === "px"
  const update = (patch: Partial<BorderParams>, live = false): void =>
    setParams({ op: "border", p: { ...p, ...patch } }, live)
  return (
    <>
      <PanelSection>
        <Select<BorderStyle>
          label={t("Style")}
          value={style}
          options={[
            { value: "solid", label: t("Plain") },
            { value: "double", label: t("Double line") },
            { value: "bevel", label: t("Bevel") },
            { value: "rounded", label: t("Rounded corners") },
            { value: "shadow", label: t("Drop shadow") },
            { value: "polaroid", label: t("Instant photo") },
          ]}
          onChange={(next) =>
            // A style comes with what makes it that style.
            update({
              style: next,
              ...(next === "rounded" && !p.radius && { radius: 8 }),
              ...(next === "shadow" && !p.blur && !p.offset && { blur: 3, offset: 1.5 }),
              ...((next === "polaroid" || next === "solid") && p.width === 0 && { width: 4 }),
            })
          }
        />
        <Slider
          label={t("Width")}
          value={p.width}
          min={0}
          max={px ? 400 : 50}
          step={px ? 1 : 0.5}
          unit={px ? "px" : "%"}
          defaultValue={0}
          onChange={(width, live) => update({ width }, live)}
          onCommit={endGesture}
        />
        <Segmented<"percent" | "px">
          label={t("Width is measured in")}
          value={px ? "px" : "percent"}
          options={[
            { value: "percent", label: "%", title: t("Percent of the shorter edge") },
            { value: "px", label: "px", title: t("Pixels of the full picture") },
          ]}
          onChange={(unit) => update({ unit, width: 0 })}
        />
        <ColorWell
          label={t("Frame color")}
          value={p.color ?? "#ffffff"}
          onChange={(color) => update({ color })}
        />
        {style === "double" && (
          <ColorWell
            label={t("Line between")}
            value={p.color2 ?? "#000000"}
            onChange={(color2) => update({ color2 })}
          />
        )}
        <Check
          label={t("Inside the picture")}
          description={t("The frame covers the edge instead of growing the picture.")}
          checked={p.inside ?? false}
          onChange={(inside) => update({ inside })}
        />
        {p.inside && (
          <Slider
            label={t("Opacity")}
            value={p.opacity ?? 100}
            {...pct}
            unit="%"
            defaultValue={100}
            onChange={(opacity, live) => update({ opacity }, live)}
            onCommit={endGesture}
          />
        )}
      </PanelSection>
      <PanelSection title={t("Corners and shadow")}>
        <Slider
          label={t("Corner radius")}
          value={p.radius ?? 0}
          min={0}
          max={50}
          step={0.5}
          unit="%"
          defaultValue={0}
          onChange={(radius, live) => update({ radius }, live)}
          onCommit={endGesture}
        />
        {!p.inside && (
          <>
            <Slider
              label={t("Shadow softness")}
              value={p.blur ?? 0}
              min={0}
              max={20}
              step={0.5}
              unit="%"
              defaultValue={0}
              onChange={(blur, live) => update({ blur }, live)}
              onCommit={endGesture}
            />
            <Slider
              label={t("Shadow distance")}
              value={p.offset ?? 0}
              min={0}
              max={20}
              step={0.5}
              unit="%"
              defaultValue={0}
              onChange={(offset, live) => update({ offset }, live)}
              onCommit={endGesture}
            />
            <FillField
              label={t("Around the picture")}
              value={p.background ?? "transparent"}
              named={[{ value: "transparent", label: t("Transparent") }]}
              onChange={(background) => update({ background })}
            />
          </>
        )}
        <p className={note}>
          {t("Sizes follow the picture: the same frame fits a small and a large one.")}
        </p>
      </PanelSection>
    </>
  )
}

// --- frame mask ---

export function FrameMaskPanel() {
  const op = useOp("frameMask")
  if (!op) return null
  const p: FrameMaskParams = op.p
  const shape = p.shape ?? "rounded"
  const update = (patch: Partial<FrameMaskParams>, live = false): void =>
    setParams({ op: "frameMask", p: { ...p, ...patch } }, live)
  const setShape = (next: FrameShape): void => {
    const { assetId: _asset, ...rest } = p
    if (next === "custom") {
      // A custom mask is nothing without its picture: ask for it now.
      void pickAsset().then((picked) => {
        if (picked)
          setParams({ op: "frameMask", p: { ...rest, shape: next, assetId: picked.assetId } })
      })
      return
    }
    setParams({
      op: "frameMask",
      p: {
        ...rest,
        shape: next,
        ...(next === "vignette" && !p.strength && { strength: 50, feather: 30 }),
        ...(next === "feather" && !p.feather && { feather: 10 }),
      },
    })
  }
  return (
    <>
      <PanelSection>
        <Select<FrameShape>
          label={t("Shape")}
          value={shape}
          options={[
            { value: "rounded", label: t("Rounded rectangle") },
            { value: "ellipse", label: t("Ellipse") },
            { value: "circle", label: t("Circle") },
            { value: "feather", label: t("Soft edge") },
            { value: "vignette", label: t("Vignette") },
            { value: "custom", label: t("From a picture…") },
          ]}
          onChange={setShape}
        />
        {shape === "custom" && (
          <>
            <AssetPicker
              assetId={p.assetId}
              label={t("Choose the mask picture…")}
              onPick={(assetId) => update({ assetId })}
            />
            <p className={note}>{t("White shows the picture, black hides it.")}</p>
          </>
        )}
        {shape === "vignette" ? (
          <Slider
            label={t("Strength")}
            value={p.strength ?? 0}
            {...pct}
            unit="%"
            defaultValue={0}
            onChange={(strength, live) => update({ strength }, live)}
            onCommit={endGesture}
          />
        ) : (
          shape !== "custom" && (
            <Slider
              label={t("Inset")}
              value={p.inset ?? 0}
              min={0}
              max={45}
              step={0.5}
              unit="%"
              defaultValue={0}
              onChange={(inset, live) => update({ inset }, live)}
              onCommit={endGesture}
            />
          )
        )}
        {shape === "rounded" && (
          <Slider
            label={t("Corner radius")}
            value={p.radius ?? 0}
            min={0}
            max={50}
            step={0.5}
            unit="%"
            defaultValue={0}
            onChange={(radius, live) => update({ radius }, live)}
            onCommit={endGesture}
          />
        )}
        <Slider
          label={shape === "vignette" ? t("Reach") : t("Feather")}
          value={p.feather ?? 0}
          min={0}
          max={50}
          step={0.5}
          unit="%"
          defaultValue={0}
          onChange={(feather, live) => update({ feather }, live)}
          onCommit={endGesture}
        />
      </PanelSection>
      <PanelSection title={t("Outside the shape")}>
        <FillField
          label={t("Outside the shape")}
          value={p.background ?? (shape === "vignette" ? "#000000" : "transparent")}
          named={[{ value: "transparent", label: t("Transparent") }]}
          onChange={(background) => update({ background })}
        />
        <Check
          label={t("Invert")}
          description={t("Hide the inside of the shape instead.")}
          checked={p.invert ?? false}
          onChange={(invert) => update({ invert })}
        />
        {(p.background ?? "transparent") === "transparent" && shape !== "vignette" && (
          <p className={note}>{t("Save as PNG to keep the transparent part.")}</p>
        )}
      </PanelSection>
    </>
  )
}

// --- watermark ---

/** Tokens offered as chips; the text field takes any other by typing. */
const TOKENS: readonly { token: string; label: string }[] = [
  { token: "{name}", label: msg("File name") },
  { token: "{date}", label: msg("Date") },
  { token: "{year}", label: msg("Year") },
  { token: "{exif.model}", label: msg("Camera") },
  { token: "{exif.artist}", label: msg("Author") },
  { token: "{width}×{height}", label: msg("Size") },
]

const MARK_SLIDERS: readonly Spec<Extract<keyof WatermarkParams, string>>[] = [
  { key: "size", label: msg("Size"), min: 0.5, max: 100, step: 0.5, unit: "%", neutral: 5 },
  { key: "opacity", label: msg("Opacity"), ...pct, unit: "%", neutral: 100 },
  { key: "margin", label: msg("Distance from the edge"), min: 0, max: 50, step: 0.5, unit: "%" },
  { key: "rotation", label: msg("Rotation"), min: -180, max: 180, unit: "°" },
]

export function WatermarkPanel() {
  const op = useOp("watermark")
  const fonts = useEditorStore((s) => s.fonts)
  const area = useRef<HTMLTextAreaElement>(null)
  useEffect(() => void loadFonts(), [])
  if (!op) return null
  const p: WatermarkParams = op.p
  const kind = p.kind ?? "text"
  const update = (patch: Partial<WatermarkParams>, live = false): void =>
    setParams({ op: "watermark", p: { ...p, ...patch } }, live)
  const insert = (token: string): void => {
    const el = area.current
    const text = p.text ?? ""
    const at = el ? el.selectionStart : text.length
    const next = (text.slice(0, at) + token + text.slice(el ? el.selectionEnd : at)).slice(
      0,
      MAX_WATERMARK_CHARS,
    )
    update({ text: next })
    el?.focus()
  }
  const setKind = (next: "text" | "image"): void => {
    if (next === kind) return
    if (next === "text") {
      const { assetId: _asset, ...rest } = p
      setParams({ op: "watermark", p: { ...rest, kind: "text", size: Math.min(p.size, 10) } })
      return
    }
    void pickAsset().then((picked) => {
      if (!picked) return
      setParams({
        op: "watermark",
        p: { ...p, kind: "image", assetId: picked.assetId, size: Math.max(p.size, 20) },
      })
    })
  }
  return (
    <>
      <PanelSection>
        <Segmented<"text" | "image">
          label={t("Kind of watermark")}
          value={kind}
          options={[
            { value: "text", label: t("Text") },
            { value: "image", label: t("Picture") },
          ]}
          onChange={setKind}
        />
        {kind === "text" ? (
          <>
            <label className="block space-y-1 text-2xs text-muted">
              <span>{t("Text")}</span>
              <textarea
                ref={area}
                rows={2}
                maxLength={MAX_WATERMARK_CHARS}
                value={p.text ?? ""}
                onChange={(e) => update({ text: e.target.value })}
                className={`block w-full resize-y px-2 py-1 text-xs ${fieldLook}`}
                data-testid="watermark-text"
              />
            </label>
            <div
              role="group"
              aria-label={t("Insert a fact about the picture")}
              className="flex flex-wrap gap-1"
            >
              {TOKENS.map((tk) => (
                <button
                  key={tk.token}
                  type="button"
                  data-token={tk.token}
                  onClick={() => insert(tk.token)}
                  className="h-6 rounded-full border border-border px-2 text-2xs text-muted hover:border-muted hover:text-text"
                >
                  {t(tk.label)}
                </button>
              ))}
            </div>
            <p className={note}>
              {t("Words in braces are filled in for each picture; the picture shows the result.")}
            </p>
            <Select
              label={t("Font")}
              value={p.font ?? ""}
              options={[
                { value: "", label: t("Built-in (Go)") },
                ...(fonts ?? []).filter((f) => f !== "Go").map((f) => ({ value: f, label: f })),
                // A font of a list made elsewhere: named, drawn with the default.
                ...(p.font && fonts && !fonts.includes(p.font)
                  ? [{ value: p.font, label: t("{name} (not installed)", { name: p.font }) }]
                  : []),
              ]}
              onChange={(font) => {
                const { font: _font, ...rest } = p
                setParams({ op: "watermark", p: font ? { ...rest, font } : rest })
              }}
            />
            <div className="flex gap-4">
              <Check
                label={t("Bold")}
                checked={p.bold ?? false}
                onChange={(bold) => update({ bold })}
              />
              <Check
                label={t("Italic")}
                checked={p.italic ?? false}
                onChange={(italic) => update({ italic })}
              />
            </div>
            <ColorWell
              label={t("Text color")}
              value={p.color ?? "#ffffff"}
              onChange={(color) => update({ color })}
            />
          </>
        ) : (
          <AssetPicker
            assetId={p.assetId}
            label={t("Choose another picture…")}
            onPick={(assetId) => update({ assetId })}
          />
        )}
      </PanelSection>
      <PanelSection title={t("Size and place")}>
        <AnchorGrid
          label={t("Position of the watermark")}
          value={p.anchor ?? "se"}
          onChange={(anchor) => update({ anchor })}
        />
        <Sliders<WatermarkParams> specs={MARK_SLIDERS} value={p} onChange={update} />
      </PanelSection>
      {kind === "text" && (
        <PanelSection title={t("Outline and shadow")}>
          <Slider
            label={t("Outline")}
            value={p.outline ?? 0}
            min={0}
            max={20}
            step={0.5}
            unit="%"
            defaultValue={0}
            onChange={(outline, live) => update({ outline }, live)}
            onCommit={endGesture}
          />
          {(p.outline ?? 0) > 0 && (
            <ColorWell
              label={t("Outline color")}
              value={p.outlineColor ?? "#000000"}
              onChange={(outlineColor) => update({ outlineColor })}
            />
          )}
          <Check
            label={t("Shadow")}
            checked={p.shadow ?? false}
            onChange={(shadow) => update({ shadow })}
          />
        </PanelSection>
      )}
      <PanelSection title={t("Repeat and blend")}>
        <Check
          label={t("Repeat over the picture")}
          checked={p.tile ?? false}
          onChange={(tile) =>
            update({ tile, ...(tile && p.spacing === undefined && { spacing: 60 }) })
          }
        />
        {p.tile && (
          <>
            <Slider
              label={t("Spacing")}
              value={p.spacing ?? 0}
              min={0}
              max={500}
              step={5}
              unit="%"
              defaultValue={60}
              onChange={(spacing, live) => update({ spacing }, live)}
              onCommit={endGesture}
            />
            <Check
              label={t("Shift every other row")}
              checked={p.stagger ?? false}
              onChange={(stagger) => update({ stagger })}
            />
          </>
        )}
        <Select<WatermarkBlend>
          label={t("Blend")}
          value={p.blend ?? "normal"}
          options={[
            { value: "normal", label: t("Normal") },
            { value: "multiply", label: t("Multiply (darkens)") },
            { value: "screen", label: t("Screen (lightens)") },
          ]}
          onChange={(blend) => update({ blend })}
        />
      </PanelSection>
    </>
  )
}

// --- obscure ---

const half = (v: number): number => Math.round(v * 1000) / 10

export function ObscurePanel() {
  const op = useOp("obscure")
  if (!op) return null
  const p: ObscureParams = op.p
  const shape = p.shape ?? "rect"
  const update = (patch: Partial<ObscureParams>, live = false): void =>
    setParams({ op: "obscure", p: { ...p, ...patch } }, live)
  const rect: NormalizedRect = p.rect ?? { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }
  const points = p.points ?? []
  const setShape = (next: ObscureShape): void => {
    if (next === shape) return
    if (next === "polygon") {
      // The box's corners become the first points.
      const { rect: _rect, ...rest } = p
      setParams({
        op: "obscure",
        p: {
          ...rest,
          shape: next,
          points: [
            [rect.x, rect.y],
            [rect.x + rect.w, rect.y],
            [rect.x + rect.w, rect.y + rect.h],
            [rect.x, rect.y + rect.h],
          ],
        },
      })
      return
    }
    // A polygon becomes the box around it.
    const { points: _points, ...rest } = p
    let box = rect
    if (points.length > 0) {
      const xs = points.map((q) => q[0])
      const ys = points.map((q) => q[1])
      const x = Math.max(0, Math.min(...xs))
      const y = Math.max(0, Math.min(...ys))
      box = { x, y, w: Math.min(1, Math.max(...xs)) - x, h: Math.min(1, Math.max(...ys)) - y }
    }
    setParams({ op: "obscure", p: { ...rest, shape: next, rect: box } })
  }
  const setRect = (patch: Partial<NormalizedRect>): void => {
    const next = { ...rect, ...patch }
    next.w = Math.min(Math.max(next.w, 0.005), 1 - next.x)
    next.h = Math.min(Math.max(next.h, 0.005), 1 - next.y)
    update({ rect: next })
  }
  const addPoint = (): void => {
    if (points.length >= MAX_POLYGON_POINTS) return
    // Between the last point and the first, so the outline keeps its shape.
    const a = points[points.length - 1]!
    const b = points[0]!
    update({ points: [...points, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]] })
  }
  return (
    <>
      <PanelSection>
        <Segmented<ObscureMethod>
          label={t("How to obscure")}
          value={p.method ?? "blur"}
          options={[
            { value: "blur", label: t("Blur") },
            { value: "pixelate", label: t("Pixelate") },
            { value: "mosaic", label: t("Mosaic") },
          ]}
          onChange={(method) => update({ method })}
        />
        <Slider
          label={t("Strength")}
          value={p.strength}
          min={1}
          max={100}
          unit="%"
          defaultValue={60}
          onChange={(strength, live) => update({ strength }, live)}
          onCommit={endGesture}
        />
        <Slider
          label={t("Soft edge")}
          value={p.feather ?? 0}
          {...pct}
          unit="%"
          defaultValue={0}
          onChange={(feather, live) => update({ feather }, live)}
          onCommit={endGesture}
        />
      </PanelSection>
      <PanelSection title={t("Region")}>
        <Segmented<ObscureShape>
          label={t("Shape of the region")}
          value={shape}
          options={[
            { value: "rect", label: t("Rectangle") },
            { value: "ellipse", label: t("Ellipse") },
            { value: "polygon", label: t("Polygon") },
          ]}
          onChange={setShape}
        />
        {shape === "polygon" ? (
          <>
            <Button
              size="sm"
              className="w-full"
              disabled={points.length >= MAX_POLYGON_POINTS}
              onClick={addPoint}
            >
              {t("Add a point")}
            </Button>
            <p className={note}>
              {t(
                "Drag the points on the picture. Arrow keys move the focused point; Delete removes it.",
              )}
            </p>
          </>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <NumberField
                label={t("Left")}
                value={half(rect.x)}
                min={0}
                max={99.5}
                step={0.5}
                unit="%"
                onChange={(v) => setRect({ x: v / 100 })}
              />
              <NumberField
                label={t("Top")}
                value={half(rect.y)}
                min={0}
                max={99.5}
                step={0.5}
                unit="%"
                onChange={(v) => setRect({ y: v / 100 })}
              />
              <NumberField
                label={t("Width")}
                value={half(rect.w)}
                min={0.5}
                max={100}
                step={0.5}
                unit="%"
                onChange={(v) => setRect({ w: v / 100 })}
              />
              <NumberField
                label={t("Height")}
                value={half(rect.h)}
                min={0.5}
                max={100}
                step={0.5}
                unit="%"
                onChange={(v) => setRect({ h: v / 100 })}
              />
            </div>
            <p className={note}>
              {t("Drag the box on the picture, or move it with the arrow keys.")}
            </p>
          </>
        )}
        <Check
          label={t("Obscure everything else")}
          checked={p.invert ?? false}
          onChange={(invert) => update({ invert })}
        />
      </PanelSection>
      <PanelSection>
        <p className={note} role="note" data-testid="obscure-note">
          {t(
            "Once saved, what is obscured cannot be brought back from the saved file. The original stays as it is unless you replace it.",
          )}
        </p>
      </PanelSection>
    </>
  )
}

// --- lens ---

export function LensPanel() {
  const op = useOp("lens")
  if (!op) return null
  const p: LensParams = op.p
  const mode = p.mode ?? "bulge"
  const round = mode === "bulge" || mode === "pinch"
  const update = (patch: Partial<LensParams>, live = false): void =>
    setParams({ op: "lens", p: { ...p, ...patch } }, live)
  return (
    <>
      <PanelSection>
        <Select<LensMode>
          label={t("Kind of lens")}
          value={mode}
          options={[
            { value: "bulge", label: t("Magnify (bulge)") },
            { value: "pinch", label: t("Pinch") },
            { value: "barrel", label: t("Barrel") },
            { value: "pincushion", label: t("Pincushion") },
          ]}
          onChange={(next) => update({ mode: next })}
        />
        <Slider
          label={t("Amount")}
          value={p.amount}
          {...pct}
          unit="%"
          defaultValue={0}
          onChange={(amount, live) => update({ amount }, live)}
          onCommit={endGesture}
        />
        {round && (
          <>
            <Slider
              label={t("Radius")}
              value={p.radius ?? 50}
              min={1}
              max={200}
              unit="%"
              defaultValue={50}
              onChange={(radius, live) => update({ radius }, live)}
              onCommit={endGesture}
            />
            <Slider
              label={t("Soft rim")}
              value={p.soft ?? 0}
              {...pct}
              unit="%"
              defaultValue={30}
              onChange={(soft, live) => update({ soft }, live)}
              onCommit={endGesture}
            />
          </>
        )}
      </PanelSection>
      <PanelSection title={t("Centre")}>
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField
            label={t("Across")}
            value={half(p.cx ?? 0.5)}
            min={0}
            max={100}
            step={0.5}
            unit="%"
            onChange={(v) => update({ cx: v / 100 })}
          />
          <NumberField
            label={t("Down")}
            value={half(p.cy ?? 0.5)}
            min={0}
            max={100}
            step={0.5}
            unit="%"
            onChange={(v) => update({ cy: v / 100 })}
          />
        </div>
        <p className={note}>
          {t("Drag the centre on the picture, or move it with the arrow keys.")}
        </p>
        <ResetButton kind="lens" />
      </PanelSection>
    </>
  )
}

// --- bump map ---

const BUMP: readonly Spec<Extract<keyof BumpParams, string>>[] = [
  { key: "height", label: msg("Depth"), ...pct, unit: "%" },
  { key: "angle", label: msg("Light from"), min: 0, max: 360, unit: "°", neutral: 135 },
  { key: "elevation", label: msg("Light height"), min: 5, max: 90, unit: "°", neutral: 45 },
  { key: "smooth", label: msg("Smoothness"), min: 0, max: 20, step: 0.5, unit: "px", neutral: 1 },
  { key: "color", label: msg("Keep the colors"), ...pct, unit: "%" },
]

export function BumpPanel() {
  const op = useOp("bump")
  if (!op) return null
  const p: BumpParams = op.p
  const source = p.source ?? "picture"
  const update = (patch: Partial<BumpParams>, live = false): void =>
    setParams({ op: "bump", p: { ...p, ...patch } }, live)
  const setSource = (next: "picture" | "texture"): void => {
    if (next === source) return
    if (next === "picture") {
      const { assetId: _asset, tile: _tile, ...rest } = p
      setParams({ op: "bump", p: { ...rest, source: "picture" } })
      return
    }
    void pickAsset().then((picked) => {
      if (!picked) return
      setParams({
        op: "bump",
        p: { ...p, source: "texture", assetId: picked.assetId, tile: true, height: p.height || 50 },
      })
    })
  }
  return (
    <>
      <PanelSection>
        <Segmented<"picture" | "texture">
          label={t("Relief from")}
          value={source}
          options={[
            { value: "picture", label: t("This picture"), title: t("Bright parts stand out") },
            { value: "texture", label: t("A texture…"), title: t("Canvas, paper or any picture") },
          ]}
          onChange={setSource}
        />
        {source === "texture" && (
          <>
            <AssetPicker
              assetId={p.assetId}
              label={t("Choose another texture…")}
              onPick={(assetId) => update({ assetId })}
            />
            <Check
              label={t("Repeat the texture")}
              description={t("Otherwise it is stretched over the picture.")}
              checked={p.tile ?? false}
              onChange={(tile) => update({ tile })}
            />
          </>
        )}
      </PanelSection>
      <PanelSection>
        <Sliders<BumpParams> specs={BUMP} value={p} onChange={update} />
        <ResetButton kind="bump" />
      </PanelSection>
    </>
  )
}

// --- sketch and oil ---

const SKETCH: readonly Spec<Extract<keyof SketchParams, string>>[] = [
  { key: "detail", label: msg("Detail"), ...pct, neutral: 60 },
  { key: "strength", label: msg("Line strength"), ...pct, neutral: 40 },
  { key: "paper", label: msg("Paper tone"), ...pct },
]

export function SketchPanel() {
  const op = useOp("sketch")
  if (!op) return null
  const p: SketchParams = op.p
  const update = (patch: Partial<SketchParams>, live = false): void =>
    setParams({ op: "sketch", p: { ...p, ...patch } }, live)
  return (
    <PanelSection>
      <Segmented<SketchStyle>
        label={t("Kind of sketch")}
        value={p.style ?? "pencil"}
        options={[
          { value: "pencil", label: t("Pencil") },
          { value: "ink", label: t("Ink") },
          { value: "color", label: t("Colored pencil") },
        ]}
        onChange={(style) => update({ style })}
      />
      <Sliders<SketchParams> specs={SKETCH} value={p} onChange={update} />
      {p.style === "color" && (
        <Slider
          label={t("Color amount")}
          value={p.color ?? 60}
          {...pct}
          unit="%"
          defaultValue={60}
          onChange={(color, live) => update({ color }, live)}
          onCommit={endGesture}
        />
      )}
    </PanelSection>
  )
}

const OIL: readonly Spec<Extract<keyof OilParams, string>>[] = [
  { key: "radius", label: msg("Brush size"), min: 1, max: 12, step: 0.5, unit: "px", neutral: 4 },
  { key: "levels", label: msg("Shades"), min: 4, max: 64, neutral: 20 },
]

export function OilPanel() {
  const op = useOp("oil")
  if (!op) return null
  return (
    <PanelSection>
      <Sliders<OilParams>
        specs={OIL}
        value={op.p}
        onChange={(patch, live) => setParams({ op: "oil", p: { ...op.p, ...patch } }, live)}
      />
      <p className={note}>{t("The brush is measured in pixels of the full picture.")}</p>
    </PanelSection>
  )
}
