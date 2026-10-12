// Tool options for tone, color and detail (Stage 13). Like the geometry
// panels, each edits one operation of the edit list through the store.
// Sliders come from small tables of their ranges, so a tool is its
// parameters, not a component of its own.
import { useEffect, useRef, useState } from "react"
import type {
  BalanceTriple,
  BlurParams,
  ColorBalance,
  ColorsParams,
  DenoiseParams,
  Dither,
  EditHistogram,
  EditOp,
  EditOpKind,
  GrayscaleParams,
  LevelsChannel,
  LevelsChannelName,
  LevelsParams,
  LightingParams,
  Quantizer,
  ReduceColorsParams,
  ReplaceColorParams,
  SepiaParams,
  SharpenParams,
} from "@panelyth/contracts"
import { CHANNEL_ORDERS } from "@panelyth/contracts"
import { Button, Tooltip } from "@panelyth/ui"
import { msg, t } from "@panelyth/i18n"
import { bridge } from "../../bridge"
import { notify } from "../../features/clipboard/clipboard"
import {
  addOp,
  applyLook,
  cancelPick,
  countColors,
  endGesture,
  panelOp,
  setParams,
  startPick,
  useEditorStore,
} from "../../features/editor/editorStore"
import {
  autoLevels,
  levelsFromPick,
  NEUTRAL,
  toHex,
  type Eyedropper,
} from "../../features/editor/tone"
import { defaultOp, LOOKS } from "../../features/editor/tools"
import { formatPercent } from "../../lib/format"
import { Check, NumberField, PanelSection, Segmented, Select, Slider } from "./controls"
import { useOp } from "./ToolPanels"

export const note = "text-2xs text-muted"

export interface Spec<K extends string> {
  key: K
  label: string
  min: number
  max: number
  step?: number
  unit?: string
  /** The value that changes nothing (0 unless given). */
  neutral?: number
}

/** A column of sliders over an object's numeric fields. */
export function Sliders<P>({
  specs,
  value,
  onChange,
}: {
  specs: readonly Spec<Extract<keyof P, string>>[]
  value: P
  onChange(patch: Partial<P>, live: boolean): void
}) {
  return (
    <>
      {specs.map((s) => (
        <Slider
          key={s.key}
          label={t(s.label)}
          value={(value[s.key] as number | undefined) ?? s.neutral ?? 0}
          min={s.min}
          max={s.max}
          {...(s.step !== undefined && { step: s.step })}
          {...(s.unit !== undefined && { unit: s.unit })}
          defaultValue={s.neutral ?? 0}
          onChange={(v, live) => onChange({ [s.key]: v } as Partial<P>, live)}
          onCommit={endGesture}
        />
      ))}
    </>
  )
}

/** Back to the tool's neutral state. */
export function ResetButton({ kind }: { kind: EditOpKind }) {
  return (
    <button
      type="button"
      className="text-2xs text-muted underline-offset-2 hover:text-text hover:underline"
      onClick={() => setParams(defaultOp(kind, { width: 1, height: 1, dpi: 0 }))}
    >
      {t("Reset this tool")}
    </button>
  )
}

const pct = { min: -100, max: 100 } as const

const LIGHTING: readonly Spec<Extract<keyof LightingParams, string>>[] = [
  { key: "exposure", label: msg("Exposure"), min: -3, max: 3, step: 0.05, unit: "EV" },
  { key: "brightness", label: msg("Brightness"), ...pct },
  { key: "contrast", label: msg("Contrast"), ...pct },
  { key: "highlights", label: msg("Highlights"), ...pct },
  { key: "shadows", label: msg("Shadows"), ...pct },
  { key: "whites", label: msg("Whites"), ...pct },
  { key: "blacks", label: msg("Blacks"), ...pct },
  { key: "gamma", label: msg("Gamma"), min: 0.1, max: 5, step: 0.01, neutral: 1 },
]

export function LightingPanel() {
  const op = useOp("lighting")
  const histogram = useEditorStore((s) => s.histogram)
  if (!op) return null
  return (
    <>
      <PanelSection>
        <Sliders<LightingParams>
          specs={LIGHTING}
          value={op.p}
          onChange={(patch, live) => setParams({ op: "lighting", p: { ...op.p, ...patch } }, live)}
        />
      </PanelSection>
      <PanelSection>
        <Button
          size="sm"
          className="w-full"
          disabled={!histogram}
          onClick={() => {
            // Ordinary levels values, so the result can be tuned afterwards.
            if (histogram) {
              addOp({
                op: "levels",
                p: autoLevels(histogram, { clip: 0.1, mode: "rgb", gamma: true }),
              })
            }
          }}
        >
          {t("Auto enhance")}
        </Button>
        <p className={note}>{t("Adds a Levels step fitted to this picture; adjust it there.")}</p>
        <ResetButton kind="lighting" />
      </PanelSection>
    </>
  )
}

const COLORS: readonly Spec<Extract<keyof ColorsParams, string>>[] = [
  { key: "saturation", label: msg("Saturation"), ...pct },
  { key: "vibrance", label: msg("Vibrance"), ...pct },
  { key: "temperature", label: msg("Temperature"), ...pct },
  { key: "tint", label: msg("Tint"), ...pct },
  { key: "hue", label: msg("Hue"), min: -180, max: 180, unit: "°" },
]

const NO_BALANCE: ColorBalance = {
  shadows: [0, 0, 0],
  midtones: [0, 0, 0],
  highlights: [0, 0, 0],
}

function BalanceRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: BalanceTriple
  onChange(v: BalanceTriple, live: boolean): void
}) {
  const names = [t("Red"), t("Green"), t("Blue")]
  return (
    <fieldset className="space-y-1">
      <legend className="text-2xs font-medium text-muted">{label}</legend>
      {names.map((name, i) => (
        <Slider
          key={name}
          label={name}
          value={value[i]!}
          min={-100}
          max={100}
          defaultValue={0}
          onChange={(v, live) => {
            const next: BalanceTriple = [value[0], value[1], value[2]]
            next[i] = v
            onChange(next, live)
          }}
          onCommit={endGesture}
        />
      ))}
    </fieldset>
  )
}

export function ColorsPanel() {
  const op = useOp("colors")
  const [open, setOpen] = useState(false)
  if (!op) return null
  const balance = op.p.balance ?? NO_BALANCE
  const update = (patch: Partial<ColorsParams>, live: boolean): void =>
    setParams({ op: "colors", p: { ...op.p, ...patch } }, live)
  return (
    <>
      <PanelSection>
        <Sliders<ColorsParams> specs={COLORS} value={op.p} onChange={update} />
      </PanelSection>
      <PanelSection>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="flex w-full items-center gap-1 text-left text-2xs font-medium text-muted hover:text-text"
        >
          <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          {t("Color balance")}
        </button>
        {open &&
          (
            [
              ["shadows", t("Shadows")],
              ["midtones", t("Midtones")],
              ["highlights", t("Highlights")],
            ] as const
          ).map(([key, label]) => (
            <BalanceRow
              key={key}
              label={label}
              value={balance[key]}
              onChange={(v, live) => update({ balance: { ...balance, [key]: v } }, live)}
            />
          ))}
        <ResetButton kind="colors" />
      </PanelSection>
    </>
  )
}

const HIST_W = 256
const HIST_H = 56

/** The histogram a tool is given, with the tool's own marks drawn over it. */
const NO_MARKS: readonly number[] = []

export function BeforeHistogram({
  bins,
  marks = NO_MARKS,
  label,
}: {
  bins: readonly number[] | null
  /** Input values (0..255) to mark with a vertical line. */
  marks?: readonly number[]
  label: string
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const ctx = canvas.current?.getContext?.("2d")
    if (!ctx) return
    ctx.clearRect(0, 0, HIST_W, HIST_H)
    if (bins) {
      let peak = 1
      for (let i = 1; i < 255; i++) peak = Math.max(peak, bins[i]!)
      ctx.fillStyle = "rgba(160, 160, 160, 0.85)"
      for (let i = 0; i < 256; i++) {
        const bar = Math.min(1, bins[i]! / peak) * HIST_H
        if (bar > 0) ctx.fillRect(i, HIST_H - bar, 1, bar)
      }
    }
    ctx.fillStyle = "rgba(255, 255, 255, 0.95)"
    for (const m of marks) ctx.fillRect(Math.round(m), 0, 1, HIST_H)
  }, [bins, marks])
  return (
    <canvas
      ref={canvas}
      width={HIST_W}
      height={HIST_H}
      role="img"
      aria-label={label}
      className="block h-14 w-full rounded bg-canvas"
      data-testid="before-histogram"
      data-ready={bins ? "true" : "false"}
    />
  )
}

export function channelBins(h: EditHistogram | null, channel: LevelsChannelName): number[] | null {
  if (!h) return null
  return channel === "l" ? h.lum : h[channel]
}

export const CHANNEL_OPTIONS: readonly {
  value: LevelsChannelName
  label: string
  title: string
}[] = [
  { value: "l", label: "RGB", title: msg("All channels") },
  { value: "r", label: "R", title: msg("Red") },
  { value: "g", label: "G", title: msg("Green") },
  { value: "b", label: "B", title: msg("Blue") },
]

export function LevelsPanel() {
  const op = useOp("levels")
  const before = useEditorStore((s) => s.before)
  const picker = useEditorStore((s) => s.picker)
  const [channel, setChannel] = useState<LevelsChannelName>("l")
  const [clip, setClip] = useState(0.1)
  const [mode, setMode] = useState<"rgb" | "lum">("rgb")
  // An eyedropper left armed must not outlive its panel.
  useEffect(() => cancelPick, [])
  if (!op) return null
  const p: LevelsParams = op.p
  const c: LevelsChannel = { ...NEUTRAL, ...p[channel] }
  const put = (next: LevelsParams, live = false): void => setParams({ op: "levels", p: next }, live)
  const update = (patch: Partial<LevelsChannel>, live: boolean): void => {
    const { auto: _auto, ...rest } = p
    put({ ...rest, [channel]: { ...c, ...patch } }, live)
  }
  const pick = (kind: Eyedropper): void => {
    const id = `levels-${kind}`
    if (picker === id) return cancelPick()
    startPick(id, (rgba) => {
      // The values as they are when the color arrives, not when the eyedropper was armed.
      const now = panelOp(useEditorStore.getState())
      put(levelsFromPick(now?.op === "levels" ? now.p : {}, kind, [rgba[0], rgba[1], rgba[2]]))
    })
  }
  const droppers: readonly { kind: Eyedropper; label: string; swatch: string }[] = [
    { kind: "black", label: t("Pick the black point"), swatch: "#000000" },
    { kind: "gray", label: t("Pick a neutral gray"), swatch: "#808080" },
    { kind: "white", label: t("Pick the white point"), swatch: "#ffffff" },
  ]
  return (
    <>
      <PanelSection>
        <Segmented<LevelsChannelName>
          label={t("Channel")}
          value={channel}
          options={CHANNEL_OPTIONS.map((o) => ({ ...o, title: t(o.title) }))}
          onChange={setChannel}
        />
        <BeforeHistogram
          bins={channelBins(before, channel)}
          marks={[c.inBlack, c.inWhite]}
          label={t("Histogram of the picture before Levels")}
        />
        <Slider
          label={t("Black point")}
          value={c.inBlack}
          min={0}
          max={254}
          defaultValue={0}
          onChange={(v, live) => update({ inBlack: Math.min(v, c.inWhite - 1) }, live)}
          onCommit={endGesture}
        />
        <Slider
          label={t("Midtones")}
          value={c.gamma ?? 1}
          min={0.1}
          max={9.99}
          step={0.01}
          defaultValue={1}
          onChange={(v, live) => update({ gamma: v }, live)}
          onCommit={endGesture}
        />
        <Slider
          label={t("White point")}
          value={c.inWhite}
          min={1}
          max={255}
          defaultValue={255}
          onChange={(v, live) => update({ inWhite: Math.max(v, c.inBlack + 1) }, live)}
          onCommit={endGesture}
        />
      </PanelSection>
      <PanelSection title={t("Output")}>
        <Slider
          label={t("Output black")}
          value={c.outBlack}
          min={0}
          max={255}
          defaultValue={0}
          onChange={(v, live) => update({ outBlack: v }, live)}
          onCommit={endGesture}
        />
        <Slider
          label={t("Output white")}
          value={c.outWhite}
          min={0}
          max={255}
          defaultValue={255}
          onChange={(v, live) => update({ outWhite: v }, live)}
          onCommit={endGesture}
        />
      </PanelSection>
      <PanelSection title={t("From the picture")}>
        <div role="group" aria-label={t("Eyedroppers")} className="flex gap-1.5">
          {droppers.map((d) => (
            <Tooltip key={d.kind} content={d.label}>
              <button
                type="button"
                aria-label={d.label}
                aria-pressed={picker === `levels-${d.kind}`}
                data-dropper={d.kind}
                onClick={() => pick(d.kind)}
                className="grid h-7 flex-1 place-items-center rounded-md border border-border hover:border-muted aria-pressed:border-accent"
              >
                <span
                  aria-hidden="true"
                  className="size-3 rounded-full border border-border"
                  style={{ background: d.swatch }}
                />
              </button>
            </Tooltip>
          ))}
        </div>
        {picker?.startsWith("levels-") && (
          <p className={note} role="status">
            {t("Click the picture. Esc cancels.")}
          </p>
        )}
        <div className="flex items-end gap-1.5">
          <NumberField
            label={t("Clip")}
            value={clip}
            min={0}
            max={5}
            step={0.1}
            unit="%"
            onChange={setClip}
            className="flex-1"
          />
          <Button
            size="sm"
            disabled={!before}
            onClick={() => before && put(autoLevels(before, { clip, mode, gamma: false }))}
          >
            {t("Auto")}
          </Button>
        </div>
        <Segmented<"rgb" | "lum">
          label={t("Auto levels work on")}
          value={mode}
          options={[
            { value: "rgb", label: t("Each channel"), title: t("Also removes a color cast") },
            { value: "lum", label: t("Brightness"), title: t("Keeps the colors as they are") },
          ]}
          onChange={setMode}
        />
        <ResetButton kind="levels" />
      </PanelSection>
    </>
  )
}

const MIXER: readonly Spec<"0" | "1" | "2">[] = [
  { key: "0", label: msg("Red"), min: -200, max: 200, unit: "%" },
  { key: "1", label: msg("Green"), min: -200, max: 200, unit: "%" },
  { key: "2", label: msg("Blue"), min: -200, max: 200, unit: "%" },
]

export function GrayscalePanel() {
  const op = useOp("grayscale")
  if (!op) return null
  const p: GrayscaleParams = op.p
  const mix = p.mix ?? [21, 72, 7]
  return (
    <PanelSection>
      <Select<NonNullable<GrayscaleParams["method"]>>
        label={t("Method")}
        value={p.method ?? "luminance"}
        options={[
          { value: "luminance", label: t("Luminance") },
          { value: "average", label: t("Average") },
          { value: "desaturate", label: t("Desaturate") },
          { value: "mixer", label: t("Channel mixer") },
        ]}
        onChange={(method) =>
          setParams({
            op: "grayscale",
            p: method === "mixer" ? { method, mix } : { method },
          })
        }
      />
      {p.method === "mixer" && (
        <Sliders<Record<"0" | "1" | "2", number>>
          specs={MIXER}
          value={{ 0: mix[0], 1: mix[1], 2: mix[2] }}
          onChange={(patch, live) => {
            const next: [number, number, number] = [mix[0], mix[1], mix[2]]
            for (const [k, v] of Object.entries(patch)) next[Number(k)] = v
            setParams({ op: "grayscale", p: { method: "mixer", mix: next } }, live)
          }}
        />
      )}
    </PanelSection>
  )
}

const SEPIA: readonly Spec<Extract<keyof SepiaParams, string>>[] = [
  { key: "strength", label: msg("Strength"), min: 0, max: 100, unit: "%", neutral: 0 },
  { key: "tone", label: msg("Tone (cool to warm)"), ...pct },
]

export function SepiaPanel() {
  const op = useOp("sepia")
  if (!op) return null
  return (
    <PanelSection>
      <Sliders<SepiaParams>
        specs={SEPIA}
        value={op.p}
        onChange={(patch, live) => setParams({ op: "sepia", p: { ...op.p, ...patch } }, live)}
      />
    </PanelSection>
  )
}

export function NegativePanel() {
  const op = useOp("negative")
  if (!op) return null
  const channels = op.p.channels ?? "rgb"
  const names: readonly [string, string][] = [
    ["r", t("Red")],
    ["g", t("Green")],
    ["b", t("Blue")],
  ]
  return (
    <PanelSection title={t("Channels to invert")}>
      {names.map(([c, label]) => (
        <Check
          key={c}
          label={label}
          checked={channels.includes(c)}
          // At least one channel: with none the step would do nothing.
          disabled={channels === c}
          onChange={(on) => {
            const next = ["r", "g", "b"]
              .filter((k) => (k === c ? on : channels.includes(k)))
              .join("")
            setParams({ op: "negative", p: next === "rgb" ? {} : { channels: next } })
          }}
        />
      ))}
    </PanelSection>
  )
}

export function SwapChannelsPanel() {
  const op = useOp("swapChannels")
  if (!op) return null
  return (
    <PanelSection>
      <Select
        label={t("Red, green and blue come from")}
        value={op.p.order}
        options={CHANNEL_ORDERS.map((order) => ({
          value: order,
          label: order.toUpperCase().split("").join(" · "),
        }))}
        onChange={(order) => setParams({ op: "swapChannels", p: { order } })}
      />
      <p className={note}>{t("B · G · R swaps red and blue.")}</p>
    </PanelSection>
  )
}

export function ColorWell({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange(hex: string): void
}) {
  return (
    <label className="flex items-center gap-2 text-2xs text-muted">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs text-text tabular-nums">{value}</span>
      <input
        type="color"
        value={value}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-10 rounded border border-border bg-canvas"
      />
    </label>
  )
}

const REPLACE: readonly Spec<Extract<keyof ReplaceColorParams, string>>[] = [
  { key: "tolerance", label: msg("Tolerance"), min: 0, max: 100 },
  { key: "softness", label: msg("Softness"), min: 0, max: 100 },
]

export function ReplaceColorPanel() {
  const op = useOp("replaceColor")
  const picker = useEditorStore((s) => s.picker)
  useEffect(() => cancelPick, [])
  if (!op) return null
  const p = op.p
  const update = (patch: Partial<ReplaceColorParams>, live = false): void =>
    setParams({ op: "replaceColor", p: { ...p, ...patch } }, live)
  return (
    <>
      <PanelSection>
        <ColorWell label={t("Replace")} value={p.from} onChange={(from) => update({ from })} />
        <Button
          size="sm"
          className="w-full"
          aria-pressed={picker === "replace-from"}
          data-dropper="replace"
          onClick={() =>
            picker === "replace-from"
              ? cancelPick()
              : startPick("replace-from", (rgba) => {
                  const now = panelOp(useEditorStore.getState())
                  setParams({
                    op: "replaceColor",
                    p: { ...(now?.op === "replaceColor" ? now.p : p), from: toHex(rgba) },
                  })
                })
          }
        >
          {picker === "replace-from"
            ? t("Click the picture. Esc cancels.")
            : t("Pick from the picture")}
        </Button>
        <ColorWell label={t("With")} value={p.to} onChange={(to) => update({ to })} />
      </PanelSection>
      <PanelSection>
        <Sliders<ReplaceColorParams> specs={REPLACE} value={p} onChange={update} />
        <Check
          label={t("Keep the shading")}
          description={t("Each pixel keeps its own brightness.")}
          checked={p.keepLuminance ?? false}
          onChange={(keepLuminance) => update({ keepLuminance })}
        />
      </PanelSection>
    </>
  )
}

const SHARPEN: readonly Spec<Extract<keyof SharpenParams, string>>[] = [
  { key: "amount", label: msg("Amount"), min: 0, max: 500, unit: "%" },
  { key: "radius", label: msg("Radius"), min: 0.1, max: 20, step: 0.1, unit: "px", neutral: 1 },
  { key: "threshold", label: msg("Threshold"), min: 0, max: 255 },
]

export function SharpenPanel() {
  const op = useOp("sharpen")
  if (!op) return null
  return (
    <PanelSection>
      <Sliders<SharpenParams>
        specs={SHARPEN}
        value={op.p}
        onChange={(patch, live) => setParams({ op: "sharpen", p: { ...op.p, ...patch } }, live)}
      />
      <p className={note}>
        {t("The radius is in pixels of the full picture; the preview shows it at its own scale.")}
      </p>
    </PanelSection>
  )
}

export function BlurPanel() {
  const op = useOp("blur")
  if (!op) return null
  const p: BlurParams = op.p
  const update = (patch: Partial<BlurParams>, live = false): void =>
    setParams({ op: "blur", p: { ...p, ...patch } }, live)
  return (
    <PanelSection>
      <Segmented<NonNullable<BlurParams["type"]>>
        label={t("Kind of blur")}
        value={p.type ?? "gaussian"}
        options={[
          { value: "gaussian", label: t("Gaussian") },
          { value: "box", label: t("Box") },
          { value: "motion", label: t("Motion") },
        ]}
        onChange={(type) => update({ type })}
      />
      <Slider
        label={p.type === "motion" ? t("Length") : t("Radius")}
        value={p.radius}
        min={0}
        max={100}
        step={0.5}
        unit="px"
        defaultValue={0}
        onChange={(radius, live) => update({ radius }, live)}
        onCommit={endGesture}
      />
      {p.type === "motion" && (
        <Slider
          label={t("Angle")}
          value={p.angle ?? 0}
          min={-180}
          max={180}
          unit="°"
          defaultValue={0}
          onChange={(angle, live) => update({ angle }, live)}
          onCommit={endGesture}
        />
      )}
    </PanelSection>
  )
}

const DENOISE: readonly Spec<Extract<keyof DenoiseParams, string>>[] = [
  { key: "luminance", label: msg("Luminance noise"), min: 0, max: 100 },
  { key: "color", label: msg("Color noise"), min: 0, max: 100 },
  { key: "detail", label: msg("Keep detail"), min: 0, max: 100, neutral: 50 },
]

export function DenoisePanel() {
  const op = useOp("denoise")
  if (!op) return null
  const update = (patch: Partial<DenoiseParams>, live = false): void =>
    setParams({ op: "denoise", p: { ...op.p, ...patch } }, live)
  return (
    <PanelSection>
      <Sliders<DenoiseParams> specs={DENOISE} value={op.p} onChange={update} />
      <Segmented<NonNullable<DenoiseParams["quality"]>>
        label={t("Quality")}
        value={op.p.quality ?? "fast"}
        options={[
          { value: "fast", label: t("Fast") },
          { value: "high", label: t("High quality"), title: t("Slower; keeps texture better") },
        ]}
        onChange={(quality) => update({ quality })}
      />
    </PanelSection>
  )
}

function copyText(text: string): void {
  void bridge
    .copyText(text)
    .then(() => notify(t("Copied")))
    .catch(() => undefined)
}

/** Color swatches with their share; a click copies the color. */
export function Swatches({ palette }: { palette: readonly { hex: string; share: number }[] }) {
  return (
    <ul className="grid grid-cols-8 gap-1" data-testid="swatches">
      {palette.map((s) => (
        <li key={s.hex}>
          <Tooltip content={`${s.hex} · ${formatPercent(s.share)}`}>
            <button
              type="button"
              aria-label={t("Copy {name}: {value}", { name: s.hex, value: formatPercent(s.share) })}
              onClick={() => copyText(s.hex)}
              className="block aspect-square w-full rounded border border-border"
              style={{ background: s.hex }}
            />
          </Tooltip>
        </li>
      ))}
    </ul>
  )
}

export function ReduceColorsPanel() {
  const op = useOp("reduceColors")
  const items = useEditorStore((s) => s.items)
  const counted = useEditorStore((s) => s.colors.preview)
  const busy = useEditorStore((s) => s.colorsBusy === "preview")
  const format = useEditorStore((s) => s.saveOptions.format)
  if (!op) return null
  const p: ReduceColorsParams = op.p
  const update = (patch: Partial<ReduceColorsParams>, live = false): void =>
    setParams({ op: "reduceColors", p: { ...p, ...patch } }, live)
  // The palette belongs to the list it was counted for.
  const palette = counted && counted.items === items ? counted.result : null
  return (
    <>
      <PanelSection>
        <Slider
          label={t("Number of colors")}
          value={p.count}
          min={2}
          max={256}
          defaultValue={16}
          onChange={(count, live) => update({ count }, live)}
          onCommit={endGesture}
        />
        <Select<Quantizer>
          label={t("Palette")}
          value={p.quantizer ?? "median"}
          options={[
            { value: "median", label: t("Fitted (median cut)") },
            { value: "octree", label: t("Fitted (octree)") },
            { value: "web", label: t("Web colors (216)") },
            { value: "gray", label: t("Gray levels") },
          ]}
          onChange={(quantizer) => update({ quantizer })}
        />
        <Select<Dither>
          label={t("Dithering")}
          value={p.dither ?? "none"}
          options={[
            { value: "none", label: t("None") },
            { value: "fs", label: t("Floyd–Steinberg") },
            { value: "ordered4", label: t("Ordered 4×4") },
            { value: "ordered8", label: t("Ordered 8×8") },
          ]}
          onChange={(dither) => update({ dither })}
        />
        <Check
          label={t("Keep transparency")}
          description={t("Otherwise the picture is placed on white.")}
          checked={p.keepTransparency ?? false}
          onChange={(keepTransparency) => update({ keepTransparency })}
        />
      </PanelSection>
      <PanelSection title={t("Palette of the preview")}>
        {palette ? (
          <Swatches palette={palette.palette} />
        ) : (
          <Button
            size="sm"
            className="w-full"
            disabled={busy}
            onClick={() => void countColors("preview", 32)}
          >
            {busy ? t("Counting…") : t("Show the palette")}
          </Button>
        )}
        <p className={note}>
          {format === "png" || format === "gif"
            ? t("Saved as {format}, the picture is stored with this palette.", {
                format: format.toUpperCase(),
              })
            : t("Save as PNG or GIF to keep the palette; other formats store full color.")}
        </p>
      </PanelSection>
    </>
  )
}

/** Presets, each shown on the current picture. A click adds its steps to the edit stack. */
export function LooksPanel() {
  const looks = useEditorStore((s) => s.looks)
  return (
    <PanelSection>
      <ul className="grid grid-cols-2 gap-2" data-testid="looks">
        {LOOKS.map((look, i) => {
          const thumb = looks?.[i] ?? null
          return (
            <li key={look.id}>
              <button
                type="button"
                data-look={look.id}
                onClick={() => applyLook(look)}
                className="block w-full rounded-md border border-border p-1 text-left hover:border-muted focus-visible:border-accent"
              >
                <span className="block aspect-4/3 w-full overflow-hidden rounded bg-canvas">
                  {thumb && (
                    <img
                      src={thumb.url}
                      alt=""
                      draggable={false}
                      className="size-full object-contain"
                    />
                  )}
                </span>
                <span className="mt-1 block truncate text-2xs">{t(look.label)}</span>
              </button>
            </li>
          )
        })}
      </ul>
      <p className={note}>{t("A look adds ordinary steps you can change in the edit stack.")}</p>
    </PanelSection>
  )
}

/** The operation kinds whose panel this file has. */
export type ColorToolKind = Extract<
  EditOp["op"],
  | "lighting"
  | "colors"
  | "levels"
  | "grayscale"
  | "sepia"
  | "negative"
  | "swapChannels"
  | "replaceColor"
  | "sharpen"
  | "blur"
  | "denoise"
  | "reduceColors"
>
