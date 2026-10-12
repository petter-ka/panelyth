// The pointer of the draw and retouch tools (Stage 15). It sits over the
// picture while Draw, Clone, Heal or Red-eye is open. Ink has to be there
// with the pointer, so the stroke in progress is drawn here at once, as a
// path on a canvas of its own; the same stroke goes to Go as an operation
// (once per frame, the newest only), and Go's frame replaces the ink when it
// arrives. The brush ring and the keyboard crosshair move without React.
// Nothing of the picture is read here: a path, a ring and a cross are drawn.
import { useEffect, useRef, type KeyboardEvent, type PointerEvent } from "react"
import type { EditOp, Stroke, StrokePoint } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { notify } from "../../features/clipboard/clipboard"
import {
  drawnStrokes,
  paintBegin,
  paintEnd,
  paintLive,
  setParams,
  setPaint,
  useEditorStore,
} from "../../features/editor/editorStore"
import type { Size } from "../../features/media/mediaUi"
import {
  cloneOp,
  constrain,
  drawStroke,
  eyeRect,
  healOp,
  isPathTool,
  isShapeTool,
  redEyeOp,
  simplifyPath,
  sourceFor,
  stepBrush,
  STROKE_TOLERANCE,
  strokePoint,
  type PaintSettings,
} from "../../features/editor/paint"
import { capturePointer } from "./controls"

type PaintTool = "draw" | "clone" | "heal" | "redeye"
type Kind = "path" | "shape" | "box" | "click"

interface Drag {
  kind: Kind
  points: StrokePoint[]
  from: [number, number]
  to: [number, number]
  moved: boolean
  raf: number
  /** The strokes of the drawing before this one. */
  base: readonly Stroke[]
  source: [number, number] | null
}

const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1)

/** What a press of the pointer does with the tool as it is set. */
function kindOf(tool: PaintTool, paint: PaintSettings): Kind {
  if (tool === "redeye") return "box"
  if (tool !== "draw") return "path"
  if (isPathTool(paint.drawTool)) return "path"
  return isShapeTool(paint.drawTool) ? "shape" : "click"
}

/** The operation a gesture makes, or null when it makes none (yet). */
function opFor(
  tool: PaintTool,
  paint: PaintSettings,
  d: Drag,
  aspect: number,
  done: boolean,
): EditOp | null {
  if (tool === "redeye") return done ? redEyeOp(paint, eyeRect(d.from, d.to, aspect)) : null
  const points =
    d.kind === "shape"
      ? [strokePoint(d.from[0], d.from[1]), strokePoint(d.to[0], d.to[1])]
      : done || d.points.length > 1500
        ? simplifyPath(d.points, STROKE_TOLERANCE)
        : d.points
  if (tool === "clone") return d.source ? cloneOp(paint, points, d.source) : null
  if (tool === "heal") return healOp(paint, points, d.source)
  return { op: "draw", p: { strokes: [...d.base, drawStroke(paint, points)] } }
}

export function PaintOverlay({ tool, image, box }: { tool: PaintTool; image: Size; box: Size }) {
  const paint = useEditorStore((s) => s.paint)
  const frame = useEditorStore((s) => s.frame?.url)
  const root = useRef<HTMLDivElement>(null)
  const ink = useRef<HTMLCanvasElement>(null)
  const ring = useRef<HTMLSpanElement>(null)
  const cross = useRef<HTMLSpanElement>(null)
  const drag = useRef<Drag | null>(null)
  // Where the keyboard points, 0..1 of the picture.
  const at = useRef<[number, number]>([0.5, 0.5])
  const aspect = image.h > 0 ? image.w / image.h : 1
  const diameter = Math.max((paint.size / 100) * Math.min(box.w, box.h), 2)
  const needsSource = tool === "clone" || (tool === "heal" && paint.healMode === "brush")
  const kind = kindOf(tool, paint)
  const round = kind === "path"

  // Go's frame has the stroke: the ink drawn here goes.
  useEffect(() => {
    if (drag.current) return
    const c = ink.current
    c?.getContext?.("2d")?.clearRect(0, 0, c.width, c.height)
  }, [frame])

  // A stroke that outlives the overlay (the tool closed) still ends.
  useEffect(
    () => () => {
      if (drag.current) {
        cancelAnimationFrame(drag.current.raf)
        drag.current = null
        paintEnd()
      }
    },
    [],
  )

  const pointAt = (e: PointerEvent<HTMLElement>): [number, number] => {
    const r = root.current?.getBoundingClientRect()
    if (!r || r.width <= 0 || r.height <= 0) return [0.5, 0.5]
    return [clamp01((e.clientX - r.left) / r.width), clamp01((e.clientY - r.top) / r.height)]
  }

  /** Draws the gesture in progress as a path, in CSS pixels of the overlay. */
  const drawInk = (d: Drag): void => {
    const c = ink.current
    const ctx = c?.getContext?.("2d")
    if (!c || !ctx) return
    const sx = c.width
    const sy = c.height
    const scale = box.w > 0 ? sx / box.w : 1
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, sx, sy)
    // A text or a fill has no path: Go's frame shows it.
    if (d.kind === "click") return
    ctx.lineCap = "round"
    ctx.lineJoin = "round"
    ctx.lineWidth = diameter * scale
    const drawing = tool === "draw" && paint.drawTool !== "eraser"
    ctx.strokeStyle = drawing ? paint.color : "#ffffff"
    ctx.fillStyle = ctx.strokeStyle
    ctx.globalAlpha = drawing ? paint.opacity / 100 : 0.4
    const [x0, y0] = [d.from[0] * sx, d.from[1] * sy]
    const [x1, y1] = [d.to[0] * sx, d.to[1] * sy]
    ctx.beginPath()
    if (d.kind === "box") {
      ctx.globalAlpha = 1
      ctx.lineWidth = 1.5 * scale
      ctx.setLineDash([4 * scale, 3 * scale])
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      ctx.setLineDash([])
      return
    }
    if (d.kind === "shape") {
      const shape = paint.drawTool
      if (shape === "rect")
        ctx.rect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0))
      else if (shape === "ellipse") {
        ctx.ellipse(
          (x0 + x1) / 2,
          (y0 + y1) / 2,
          Math.abs(x1 - x0) / 2,
          Math.abs(y1 - y0) / 2,
          0,
          0,
          Math.PI * 2,
        )
      } else {
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
      }
      if (paint.filled && (shape === "rect" || shape === "ellipse")) ctx.fill()
      else ctx.stroke()
      return
    }
    const first = d.points[0]!
    ctx.moveTo(first[0] * sx, first[1] * sy)
    // A dot is a line to itself: round caps make it a disc.
    if (d.points.length === 1) ctx.lineTo(first[0] * sx, first[1] * sy)
    for (let i = 1; i < d.points.length; i++) ctx.lineTo(d.points[i]![0] * sx, d.points[i]![1] * sy)
    ctx.stroke()
  }

  /** One message per frame: the stroke as it is now. */
  const send = (d: Drag): void => {
    if (d.raf) return
    d.raf = requestAnimationFrame(() => {
      d.raf = 0
      if (drag.current !== d) return
      const op = opFor(tool, paint, d, aspect, false)
      if (op) paintLive(op)
    })
  }

  const moveRing = (p: readonly [number, number]): void => {
    const el = ring.current
    if (!el) return
    el.style.left = `${p[0] * 100}%`
    el.style.top = `${p[1] * 100}%`
    el.hidden = false
  }

  const begin = (p: [number, number], pressure: number | undefined, alt: boolean): Drag | null => {
    // Alt (or Ctrl) and a click choose where to copy from.
    if (needsSource && alt) {
      setPaint({ source: p, offset: null })
      return null
    }
    let source: [number, number] | null = null
    if (needsSource) {
      const found = sourceFor(paint, p)
      if (!found) {
        notify(t("Hold Alt and click where to copy from first."))
        return null
      }
      source = found.source
      if (!paint.offset) setPaint({ offset: found.offset })
    }
    if (tool === "draw" && paint.drawTool === "text" && !paint.text.trim()) {
      notify(t("Type the text in the panel first."))
      return null
    }
    if (!paintBegin()) return null
    return {
      kind,
      points: [strokePoint(p[0], p[1], pressure)],
      from: p,
      to: p,
      moved: false,
      raf: 0,
      base: drawnStrokes(useEditorStore.getState()),
      source,
    }
  }

  const finish = (d: Drag): void => {
    cancelAnimationFrame(d.raf)
    drag.current = null
    // A shape needs a drag: a click with a shape tool draws nothing.
    if (d.kind === "shape" && !d.moved) {
      paintEnd()
      const c = ink.current
      c?.getContext?.("2d")?.clearRect(0, 0, c.width, c.height)
      return
    }
    const op = opFor(tool, paint, d, aspect, true)
    if (op) {
      if (d.kind === "path" || d.kind === "shape") paintLive(op)
      else setParams(op)
    }
    paintEnd()
  }

  const onPointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    const p = pointAt(e)
    at.current = p
    const d = begin(p, e.pointerType === "pen" ? e.pressure : undefined, e.altKey || e.ctrlKey)
    if (!d) return
    capturePointer(e)
    drag.current = d
    drawInk(d)
    if (d.kind === "path") send(d)
  }

  const onPointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const p = pointAt(e)
    moveRing(p)
    const d = drag.current
    if (!d) return
    if (d.kind === "path") {
      // Every position the pointer reported since the last event, not only the last.
      const events = e.nativeEvent.getCoalescedEvents?.() ?? []
      const r = root.current?.getBoundingClientRect()
      const pen = e.pointerType === "pen"
      if (events.length > 1 && r && r.width > 0) {
        for (const c of events) {
          d.points.push(
            strokePoint(
              clamp01((c.clientX - r.left) / r.width),
              clamp01((c.clientY - r.top) / r.height),
              pen ? c.pressure : undefined,
            ),
          )
        }
      } else d.points.push(strokePoint(p[0], p[1], pen ? e.pressure : undefined))
    }
    d.to = d.kind === "shape" && e.shiftKey ? constrain(paint.drawTool, d.from, p, aspect) : p
    d.moved = true
    drawInk(d)
    if (d.kind === "path" || d.kind === "shape") send(d)
  }

  const onPointerUp = (): void => {
    const d = drag.current
    if (d) finish(d)
  }

  const moveCross = (): void => {
    const el = cross.current
    if (!el) return
    el.style.left = `${at.current[0] * 100}%`
    el.style.top = `${at.current[1] * 100}%`
    el.hidden = false
    moveRing(at.current)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.05 : 0.005
    const [x, y] = at.current
    switch (e.key) {
      case "ArrowLeft":
        at.current = [clamp01(x - step), y]
        break
      case "ArrowRight":
        at.current = [clamp01(x + step), y]
        break
      case "ArrowUp":
        at.current = [x, clamp01(y - step)]
        break
      case "ArrowDown":
        at.current = [x, clamp01(y + step)]
        break
      case "Enter":
      case " ": {
        // What a click at the crosshair does: a dot, a text, a fill, a healed
        // spot, a fixed eye; with Alt, the place to copy from.
        const d = begin([x, y], undefined, e.altKey || e.ctrlKey)
        if (d && d.kind !== "shape") {
          drag.current = d
          finish(d)
        } else if (d) paintEnd()
        break
      }
      case "[":
      case "]":
        setPaint({ size: stepBrush(paint.size, e.key === "]" ? 1 : -1) })
        break
      case "{":
      case "}":
        setPaint({
          hardness: Math.min(Math.max(paint.hardness + (e.key === "}" ? 10 : -10), 0), 100),
        })
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    if (e.key.startsWith("Arrow")) moveCross()
  }

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const label =
    tool === "draw"
      ? t("Drawing area; arrow keys move the cross, Enter draws there, [ and ] change the size")
      : tool === "redeye"
        ? t("Red-eye area; arrow keys move the cross, Enter fixes the eye there")
        : t(
            "Retouch area; arrow keys move the cross, Enter applies there, Alt+Enter sets the source",
          )
  return (
    <div
      ref={root}
      tabIndex={0}
      role="application"
      aria-label={label}
      className={`absolute inset-0 touch-none outline-none ${round ? "cursor-none" : "cursor-crosshair"}`}
      data-testid="paint-overlay"
      data-tool={tool}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (ring.current && !drag.current) ring.current.hidden = true
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <canvas
        ref={ink}
        width={Math.max(1, Math.round(Math.min(box.w * dpr, 2048)))}
        height={Math.max(
          1,
          Math.round(Math.min(box.w * dpr, 2048) * (box.w > 0 ? box.h / box.w : 1)),
        )}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 size-full"
        data-testid="paint-ink"
      />
      {needsSource && paint.source && !paint.offset && (
        // Where the next stroke copies from, until that stroke begins.
        <span
          aria-hidden="true"
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white outline-1 outline-black/70"
          style={{ left: `${paint.source[0] * 100}%`, top: `${paint.source[1] * 100}%` }}
          data-testid="paint-source"
        />
      )}
      {/* The brush: its size on the picture, whatever the zoom. */}
      {round && (
        <span
          ref={ring}
          hidden
          aria-hidden="true"
          className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white outline-1 outline-black/70"
          style={{ width: diameter, height: diameter }}
          data-testid="paint-ring"
        />
      )}
      <span
        ref={cross}
        hidden
        aria-hidden="true"
        className="pointer-events-none absolute size-3 -translate-x-1/2 -translate-y-1/2 border border-white outline-1 outline-black/70"
        data-testid="paint-cross"
      />
    </div>
  )
}
