// Tool options for draw and retouch (Stage 15). These tools do not edit one
// operation with sliders: the pointer makes strokes on the picture and each
// becomes an edit. The panel holds the brush (kept while the editor is
// open), says what the pointer does, and gives every result that is not a
// free-hand stroke a way by numbers and buttons.
import { useEffect, useState } from "react"
import type { DrawTool, StrokePoint } from "@panelyth/contracts"
import { MAX_WATERMARK_CHARS } from "@panelyth/contracts"
import { Button, fieldLook } from "@panelyth/ui"
import { msg, t } from "@panelyth/i18n"
import {
  drawnStrokes,
  findEyes,
  loadFonts,
  paintOnce,
  removeLastStroke,
  setPaint,
  startPick,
  cancelPick,
  useEditorStore,
} from "../../features/editor/editorStore"
import {
  cloneOp,
  drawStroke,
  eyeRect,
  healOp,
  isPathTool,
  isShapeTool,
  MAX_BRUSH,
  MIN_BRUSH,
  redEyeOp,
  sourceFor,
  strokePoint,
} from "../../features/editor/paint"
import { toHex } from "../../features/editor/tone"
import { ColorWell, note } from "./ColorPanels"
import { Check, NumberField, PanelSection, Segmented, Select, Slider } from "./controls"

const DRAW_TOOLS: readonly { value: DrawTool; label: string }[] = [
  { value: "brush", label: msg("Brush") },
  { value: "eraser", label: msg("Eraser") },
  { value: "line", label: msg("Line") },
  { value: "arrow", label: msg("Arrow") },
  { value: "rect", label: msg("Rectangle") },
  { value: "ellipse", label: msg("Ellipse") },
  { value: "text", label: msg("Text") },
  { value: "fill", label: msg("Fill") },
]

const pctOf = (v: number): number => Math.round(v * 1000) / 10

/** Brush size, and what goes with it for the tool. */
function BrushSliders({ hardness, opacity }: { hardness: boolean; opacity: boolean }) {
  const paint = useEditorStore((s) => s.paint)
  return (
    <>
      <Slider
        label={t("Size")}
        value={paint.size}
        min={MIN_BRUSH}
        max={MAX_BRUSH}
        step={0.05}
        unit="%"
        defaultValue={2}
        onChange={(size) => setPaint({ size })}
      />
      {hardness && (
        <Slider
          label={t("Hardness")}
          value={paint.hardness}
          min={0}
          max={100}
          unit="%"
          defaultValue={80}
          onChange={(v) => setPaint({ hardness: v })}
        />
      )}
      {opacity && (
        <Slider
          label={t("Opacity")}
          value={paint.opacity}
          min={1}
          max={100}
          unit="%"
          defaultValue={100}
          onChange={(v) => setPaint({ opacity: v })}
        />
      )}
    </>
  )
}

/** A place on the picture by numbers, in percent across and down. */
function PointFields({
  across,
  down,
  value,
  onChange,
}: {
  across: string
  down: string
  value: readonly [number, number]
  onChange(next: [number, number]): void
}) {
  return (
    <div className="grid grid-cols-2 gap-x-3">
      <NumberField
        label={across}
        value={pctOf(value[0])}
        min={0}
        max={100}
        step={0.5}
        unit="%"
        onChange={(v) => onChange([v / 100, value[1]])}
      />
      <NumberField
        label={down}
        value={pctOf(value[1])}
        min={0}
        max={100}
        step={0.5}
        unit="%"
        onChange={(v) => onChange([value[0], v / 100])}
      />
    </div>
  )
}

// --- draw ---

export function DrawPanel() {
  const paint = useEditorStore((s) => s.paint)
  const strokes = useEditorStore((s) => drawnStrokes(s).length)
  const activeId = useEditorStore((s) => s.activeId)
  const fonts = useEditorStore((s) => s.fonts)
  const picker = useEditorStore((s) => s.picker)
  const [from, setFrom] = useState<[number, number]>([0.25, 0.25])
  const [to, setTo] = useState<[number, number]>([0.75, 0.75])
  const tool = paint.drawTool
  useEffect(() => {
    if (tool === "text") void loadFonts()
  }, [tool])
  useEffect(() => cancelPick, [])
  const shape = isShapeTool(tool)
  const add = (): void => {
    const s = useEditorStore.getState()
    const points: StrokePoint[] = shape
      ? [strokePoint(from[0], from[1]), strokePoint(to[0], to[1])]
      : [strokePoint(from[0], from[1])]
    paintOnce({ op: "draw", p: { strokes: [...drawnStrokes(s), drawStroke(s.paint, points)] } })
  }
  return (
    <>
      <PanelSection>
        <div role="radiogroup" aria-label={t("What to draw")} className="grid grid-cols-4 gap-1">
          {DRAW_TOOLS.map((d) => (
            <button
              key={d.value}
              type="button"
              role="radio"
              aria-checked={tool === d.value}
              data-draw-tool={d.value}
              onClick={() => setPaint({ drawTool: d.value })}
              className="h-7 truncate rounded border border-border px-1 text-2xs text-muted hover:border-muted hover:text-text aria-checked:border-accent aria-checked:bg-raised aria-checked:text-accent"
            >
              {t(d.label)}
            </button>
          ))}
        </div>
        {tool !== "eraser" && (
          <>
            <ColorWell
              label={t("Color")}
              value={paint.color}
              onChange={(color) => setPaint({ color })}
            />
            <Button
              size="sm"
              className="w-full"
              aria-pressed={picker === "draw-color"}
              onClick={() =>
                picker === "draw-color"
                  ? cancelPick()
                  : startPick("draw-color", (rgba) => setPaint({ color: toHex(rgba) }))
              }
            >
              {picker === "draw-color"
                ? t("Click the picture. Esc cancels.")
                : t("Pick from the picture")}
            </Button>
          </>
        )}
        {tool !== "fill" && <BrushSliders hardness={isPathTool(tool)} opacity />}
        {(tool === "rect" || tool === "ellipse") && (
          <Check
            label={t("Filled")}
            checked={paint.filled}
            onChange={(filled) => setPaint({ filled })}
          />
        )}
        {tool === "text" && (
          <>
            <label className="block space-y-1 text-2xs text-muted">
              <span>{t("Text")}</span>
              <textarea
                rows={2}
                maxLength={MAX_WATERMARK_CHARS}
                value={paint.text}
                onChange={(e) => setPaint({ text: e.target.value })}
                className={`block w-full resize-y px-2 py-1 text-xs ${fieldLook}`}
                data-testid="draw-text"
              />
            </label>
            <Select
              label={t("Font")}
              value={paint.font}
              options={[
                { value: "", label: t("Built-in (Go)") },
                ...(fonts ?? []).filter((f) => f !== "Go").map((f) => ({ value: f, label: f })),
              ]}
              onChange={(font) => setPaint({ font })}
            />
            <Check label={t("Bold")} checked={paint.bold} onChange={(bold) => setPaint({ bold })} />
          </>
        )}
        {tool === "fill" && (
          <>
            <Slider
              label={t("Tolerance")}
              value={paint.tolerance}
              min={0}
              max={100}
              defaultValue={20}
              onChange={(tolerance) => setPaint({ tolerance })}
            />
            <Slider
              label={t("Opacity")}
              value={paint.opacity}
              min={1}
              max={100}
              unit="%"
              defaultValue={100}
              onChange={(v) => setPaint({ opacity: v })}
            />
          </>
        )}
        <p className={note}>
          {isPathTool(tool)
            ? t(
                "Drag on the picture. Free-hand strokes need a mouse, a pen or a finger; [ and ] change the size.",
              )
            : shape
              ? t(
                  "Drag on the picture; Shift keeps it straight or square. Or place it by numbers below.",
                )
              : tool === "text"
                ? t("Click where the text starts, or place it by numbers below.")
                : t("Click the area to fill, or place the fill by numbers below.")}
        </p>
      </PanelSection>
      {!isPathTool(tool) && (
        <PanelSection title={t("By numbers")}>
          <PointFields
            across={shape ? t("From across") : t("Across")}
            down={shape ? t("From down") : t("Down")}
            value={from}
            onChange={setFrom}
          />
          {shape && (
            <PointFields across={t("To across")} down={t("To down")} value={to} onChange={setTo} />
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={tool === "text" && !paint.text.trim()}
            onClick={add}
          >
            {tool === "text"
              ? t("Add the text")
              : tool === "fill"
                ? t("Fill there")
                : t("Add the shape")}
          </Button>
        </PanelSection>
      )}
      <PanelSection>
        <p className="text-2xs text-text" data-testid="draw-count">
          {activeId === null || strokes === 0
            ? t("Nothing drawn yet.")
            : t("Strokes in this drawing: {count}", { count: strokes })}
        </p>
        <Button size="sm" className="w-full" disabled={strokes === 0} onClick={removeLastStroke}>
          {t("Remove the last stroke")}
        </Button>
        <p className={note}>
          {t(
            "Strokes stay strokes until you save: the eraser removes ink, never the picture under it.",
          )}
        </p>
      </PanelSection>
    </>
  )
}

// --- clone and heal ---

/** Where a clone or a heal brush copies from: Alt+click on the picture, or by numbers. */
function SourceSection() {
  const paint = useEditorStore((s) => s.paint)
  const set = paint.source !== null
  return (
    <PanelSection title={t("Copy from")}>
      <p className="text-2xs text-text" data-testid="paint-source-state" role="status">
        {set ? t("The source is set; it moves with the brush.") : t("No source yet.")}
      </p>
      <p className={note}>{t("Hold Alt and click the picture where to copy from.")}</p>
      <PointFields
        across={t("Across")}
        down={t("Down")}
        value={paint.source ?? [0.5, 0.5]}
        onChange={(source) => setPaint({ source, offset: null })}
      />
    </PanelSection>
  )
}

/** A stroke at a point by numbers: the keyboard's way to a dab. */
function DabSection({ label, onDab }: { label: string; onDab(at: [number, number]): void }) {
  const [at, setAt] = useState<[number, number]>([0.5, 0.5])
  return (
    <PanelSection title={t("By numbers")}>
      <PointFields across={t("Across")} down={t("Down")} value={at} onChange={setAt} />
      <Button size="sm" className="w-full" onClick={() => onDab(at)}>
        {label}
      </Button>
    </PanelSection>
  )
}

export function ClonePanel() {
  const dab = (at: [number, number]): void => {
    const paint = useEditorStore.getState().paint
    const found = sourceFor(paint, at)
    if (!found) return
    if (!paint.offset) setPaint({ offset: found.offset })
    paintOnce(cloneOp(paint, [strokePoint(at[0], at[1])], found.source))
  }
  return (
    <>
      <PanelSection>
        <BrushSliders hardness opacity />
        <p className={note}>
          {t(
            "Drag on the picture to paint a copy of what is at the source. Each stroke is one edit.",
          )}
        </p>
      </PanelSection>
      <SourceSection />
      <DabSection label={t("Stamp there")} onDab={dab} />
    </>
  )
}

export function HealPanel() {
  const paint = useEditorStore((s) => s.paint)
  const dab = (at: [number, number]): void => {
    const now = useEditorStore.getState().paint
    const found = now.healMode === "brush" ? sourceFor(now, at) : null
    if (now.healMode === "brush" && !found) return
    if (found && !now.offset) setPaint({ offset: found.offset })
    paintOnce(healOp(now, [strokePoint(at[0], at[1])], found?.source ?? null))
  }
  return (
    <>
      <PanelSection>
        <Segmented<"spot" | "brush">
          label={t("Kind of healing")}
          value={paint.healMode}
          options={[
            { value: "spot", label: t("Spot"), title: t("Finds clean texture nearby by itself") },
            {
              value: "brush",
              label: t("From a source"),
              title: t("Copies texture from where you choose"),
            },
          ]}
          onChange={(healMode) => setPaint({ healMode })}
        />
        <BrushSliders hardness={false} opacity={false} />
        <p className={note}>
          {paint.healMode === "spot"
            ? t(
                "Click a blemish, or paint over a scratch. The texture comes from nearby, the light from around the stroke.",
              )
            : t(
                "Paint over what to repair. The texture comes from the source, the light from around the stroke.",
              )}
        </p>
      </PanelSection>
      {paint.healMode === "brush" && <SourceSection />}
      <DabSection label={t("Heal there")} onDab={dab} />
    </>
  )
}

// --- red-eye ---

export function RedEyePanel() {
  const paint = useEditorStore((s) => s.paint)
  const session = useEditorStore((s) => s.session)
  const [busy, setBusy] = useState(false)
  const aspect = session && session.height > 0 ? session.width / session.height : 1
  return (
    <>
      <PanelSection>
        <p className={note}>{t("Click an eye, or drag a box around it. Each eye is one edit.")}</p>
        <Slider
          label={t("Strength")}
          value={paint.redStrength}
          min={1}
          max={100}
          unit="%"
          defaultValue={100}
          onChange={(redStrength) => setPaint({ redStrength })}
        />
        <Slider
          label={t("Pupil size")}
          value={paint.redPupil}
          min={-50}
          max={50}
          defaultValue={0}
          onChange={(redPupil) => setPaint({ redPupil })}
        />
      </PanelSection>
      <PanelSection title={t("Find them for me")}>
        <Button
          size="sm"
          className="w-full"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            void findEyes().finally(() => setBusy(false))
          }}
        >
          {busy ? t("Looking…") : t("Fix red eyes automatically")}
        </Button>
        <p className={note}>
          {t("Finds pairs of red pupils that are level. Each one becomes an edit you can remove.")}
        </p>
      </PanelSection>
      <DabSection
        label={t("Fix the eye there")}
        onDab={(at) =>
          paintOnce(redEyeOp(useEditorStore.getState().paint, eyeRect(at, at, aspect)))
        }
      />
    </>
  )
}
