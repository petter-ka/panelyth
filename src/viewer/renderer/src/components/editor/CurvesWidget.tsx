// The curves tool (Stage 13). The curve is drawn on a canvas over the
// histogram of the picture the tool is given; its control points are
// buttons laid over the canvas, so Tab walks them and the arrow keys move
// the focused one. A drag is coalesced to one store update per frame. The
// pixels are Go's work: the widget only edits a few points of the edit list.
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react"
import type { CurvePoint, CurvesParams, LevelsChannelName } from "@panelyth/contracts"
import { MAX_CURVE_POINTS } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { endGesture, setParams, useEditorStore } from "../../features/editor/editorStore"
import { curveLut, movePoint, withPoint } from "../../features/editor/tone"
import { CURVE_PRESETS, IDENTITY_CURVE } from "../../features/editor/tools"
import { channelBins, CHANNEL_OPTIONS } from "./ColorPanels"
import { capturePointer, NumberField, PanelSection, Segmented, Select } from "./controls"
import { useOp } from "./ToolPanels"

const SIZE = 256

const STROKE: Record<LevelsChannelName, string> = {
  l: "rgba(240, 240, 240, 0.95)",
  r: "rgba(240, 90, 90, 0.95)",
  g: "rgba(90, 210, 120, 0.95)",
  b: "rgba(100, 150, 250, 0.95)",
}

function draw(
  ctx: CanvasRenderingContext2D,
  points: readonly CurvePoint[],
  bins: readonly number[] | null,
  channel: LevelsChannelName,
): void {
  ctx.clearRect(0, 0, SIZE, SIZE)
  if (bins) {
    // The ends hold the clipped pixels and would flatten everything else.
    let peak = 1
    for (let i = 1; i < 255; i++) peak = Math.max(peak, bins[i]!)
    ctx.fillStyle = "rgba(150, 150, 150, 0.35)"
    for (let i = 0; i < 256; i++) {
      const bar = Math.min(1, bins[i]! / peak) * SIZE
      if (bar > 0) ctx.fillRect(i, SIZE - bar, 1, bar)
    }
  }
  ctx.lineWidth = 1
  ctx.strokeStyle = "rgba(128, 128, 128, 0.35)"
  ctx.beginPath()
  for (let i = 1; i < 4; i++) {
    const v = Math.round((i * SIZE) / 4) + 0.5
    ctx.moveTo(v, 0)
    ctx.lineTo(v, SIZE)
    ctx.moveTo(0, v)
    ctx.lineTo(SIZE, v)
  }
  // The straight line: where the curve changes nothing.
  ctx.moveTo(0, SIZE)
  ctx.lineTo(SIZE, 0)
  ctx.stroke()
  const lut = curveLut(points)
  ctx.lineWidth = 1.5
  ctx.strokeStyle = STROKE[channel]
  ctx.beginPath()
  for (let v = 0; v < 256; v++) {
    const y = SIZE - 1 - (lut[v]! * (SIZE - 1)) / 255
    if (v === 0) ctx.moveTo(v, y)
    else ctx.lineTo(v, y)
  }
  ctx.stroke()
}

const samePoints = (a: readonly CurvePoint[], b: readonly CurvePoint[]): boolean =>
  a.length === b.length && a.every((p, i) => p[0] === b[i]![0] && p[1] === b[i]![1])

export function CurvesPanel() {
  const op = useOp("curves")
  const before = useEditorStore((s) => s.before)
  const [channel, setChannel] = useState<LevelsChannelName>("l")
  const [selected, setSelected] = useState(0)
  const canvas = useRef<HTMLCanvasElement>(null)
  const drag = useRef<{
    index: number
    pending: { x: number; y: number } | null
    raf: number
  } | null>(null)
  const points: readonly CurvePoint[] = op?.p[channel] ?? IDENTITY_CURVE
  const bins = channelBins(before, channel)
  // The drag reads the newest points, not those of the render it began in.
  const latest = useRef({ points, p: op?.p ?? {}, channel })
  useEffect(() => {
    latest.current = { points, p: op?.p ?? {}, channel }
  })

  useEffect(() => {
    const ctx = canvas.current?.getContext?.("2d")
    if (ctx) draw(ctx, points, bins, channel)
  }, [points, bins, channel])

  // A drag that outlives the widget (the panel closed) still ends.
  useEffect(
    () => () => {
      if (drag.current) {
        cancelAnimationFrame(drag.current.raf)
        endGesture()
      }
    },
    [],
  )

  if (!op) return null
  const at = Math.min(selected, points.length - 1)
  const point = points[at]!

  const put = (next: CurvePoint[], live = false): void => {
    const { p, channel: ch } = latest.current
    const params: CurvesParams = { ...p, [ch]: next }
    latest.current = { points: next, p: params, channel: ch }
    setParams({ op: "curves", p: params }, live)
  }

  /** A pointer position as curve values (input, output). */
  const valuesAt = (e: PointerEvent<HTMLElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    const w = r.width || SIZE
    const h = r.height || SIZE
    return {
      x: ((e.clientX - r.left) / w) * 255,
      y: (1 - (e.clientY - r.top) / h) * 255,
    }
  }

  const flush = (): void => {
    const d = drag.current
    if (!d?.pending) return
    const { x, y } = d.pending
    d.pending = null
    put(movePoint(latest.current.points, d.index, x, y), true)
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-point]")
    let index: number
    if (handle) index = Number(handle.dataset.point)
    else {
      if (points.length >= MAX_CURVE_POINTS) return
      const v = valuesAt(e)
      const next = withPoint(points, v.x, v.y)
      index = next.findIndex((p) => p[0] === Math.round(Math.min(Math.max(v.x, 0), 255)))
      put(next, true)
    }
    capturePointer(e)
    setSelected(index)
    drag.current = { index, pending: null, raf: 0 }
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    d.pending = valuesAt(e)
    if (!d.raf) {
      d.raf = requestAnimationFrame(() => {
        d.raf = 0
        if (drag.current === d) flush()
      })
    }
  }
  const onPointerUp = (): void => {
    const d = drag.current
    if (!d) return
    cancelAnimationFrame(d.raf)
    flush()
    drag.current = null
    endGesture()
  }

  const remove = (index: number): void => {
    if (points.length <= 2) return
    put(points.filter((_, i) => i !== index))
    setSelected(Math.max(0, index - 1))
  }

  const onPointKey = (index: number, e: KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.shiftKey ? 10 : 1
    const p = points[index]!
    let next: CurvePoint[]
    switch (e.key) {
      case "ArrowLeft":
        next = movePoint(points, index, p[0] - step, p[1])
        break
      case "ArrowRight":
        next = movePoint(points, index, p[0] + step, p[1])
        break
      case "ArrowUp":
        next = movePoint(points, index, p[0], p[1] + step)
        break
      case "ArrowDown":
        next = movePoint(points, index, p[0], p[1] - step)
        break
      case "Delete":
      case "Backspace":
        e.preventDefault()
        e.stopPropagation()
        remove(index)
        return
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    if (!samePoints(next, points)) put(next)
  }

  const preset = CURVE_PRESETS.find((c) => samePoints(c.points, points))?.id ?? ""

  return (
    <>
      <PanelSection>
        <Segmented<LevelsChannelName>
          label={t("Channel")}
          value={channel}
          options={CHANNEL_OPTIONS.map((o) => ({ ...o, title: t(o.title) }))}
          onChange={(next) => {
            setChannel(next)
            setSelected(0)
          }}
        />
        <div
          role="group"
          aria-label={t("Tone curve; click to add a point, drag or use the arrow keys to move it")}
          className="relative aspect-square w-full touch-none rounded bg-canvas"
          data-testid="curves"
          data-points={points.length}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <canvas
            ref={canvas}
            width={SIZE}
            height={SIZE}
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 size-full rounded"
          />
          {points.map((p, i) => (
            <button
              key={i}
              type="button"
              data-point={i}
              aria-label={t("Point {n} of {count}: input {x}, output {y}", {
                n: i + 1,
                count: points.length,
                x: p[0],
                y: p[1],
              })}
              aria-pressed={i === at}
              onFocus={() => setSelected(i)}
              onKeyDown={(e) => onPointKey(i, e)}
              className="absolute size-3 -translate-x-1/2 -translate-y-1/2 cursor-grab rounded-full border border-black/60 bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent aria-pressed:bg-accent"
              style={{ left: `${(p[0] / 255) * 100}%`, top: `${(1 - p[1] / 255) * 100}%` }}
            />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-x-3">
          <NumberField
            label={t("Input")}
            value={point[0]}
            min={0}
            max={255}
            onChange={(x) => put(movePoint(points, at, x, point[1]))}
          />
          <NumberField
            label={t("Output")}
            value={point[1]}
            min={0}
            max={255}
            onChange={(y) => put(movePoint(points, at, point[0], y))}
          />
        </div>
        <p className="text-[0.6875rem] text-muted">
          {t("Arrow keys move the point (Shift: by ten). Delete removes it.")}
        </p>
      </PanelSection>
      <PanelSection>
        <Select
          label={t("Preset")}
          value={preset}
          options={[
            ...(preset === "" ? [{ value: "", label: t("Custom") }] : []),
            ...CURVE_PRESETS.map((c) => ({ value: c.id, label: t(c.label) })),
          ]}
          onChange={(id) => {
            const chosen = CURVE_PRESETS.find((c) => c.id === id)
            if (!chosen) return
            put(chosen.points.map((p): CurvePoint => [p[0], p[1]]))
            setSelected(0)
          }}
        />
        <div className="flex items-center gap-3">
          <button
            type="button"
            className="text-[0.6875rem] text-muted underline-offset-2 hover:text-text hover:underline disabled:opacity-40 disabled:hover:no-underline"
            disabled={points.length <= 2}
            onClick={() => remove(at)}
          >
            {t("Remove the point")}
          </button>
          <button
            type="button"
            className="text-[0.6875rem] text-muted underline-offset-2 hover:text-text hover:underline"
            onClick={() => {
              latest.current = { points: IDENTITY_CURVE, p: {}, channel }
              setParams({ op: "curves", p: {} })
              setSelected(0)
            }}
          >
            {t("Reset this tool")}
          </button>
        </div>
      </PanelSection>
    </>
  )
}
