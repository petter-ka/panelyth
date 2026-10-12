// What the effects draw on the canvas (Stage 14): the region an Obscure step
// hides (a box, the ellipse inside it, or a polygon) and the centre and ring
// of a lens. They sit in the frame box, in percent of it, so they follow zoom
// and pan. Every handle is a button: drag it, or move it with the arrow keys
// by one picture pixel (ten with Shift). Strokes are white on black, so they
// show on any picture; nothing here moves by itself.
import { useRef, type KeyboardEvent, type PointerEvent } from "react"
import type { NormalizedRect, ObscureParams } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import type { Size } from "../../features/media/mediaUi"
import { dragHandle, HANDLES, moveRect, nudge, type Handle } from "../../features/editor/crop"
import { endGesture, setParams } from "../../features/editor/editorStore"
import { capturePointer } from "./controls"
import { useOp } from "./ToolPanels"

const pct = (v: number): string => `${v * 100}%`
const clamp01 = (v: number): number => Math.min(Math.max(v, 0), 1)

const handleClass =
  "absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/70 bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"

const HANDLE_AT: Record<Handle, [number, number, string]> = {
  nw: [0, 0, "nwse-resize"],
  n: [0.5, 0, "ns-resize"],
  ne: [1, 0, "nesw-resize"],
  e: [1, 0.5, "ew-resize"],
  se: [1, 1, "nwse-resize"],
  s: [0.5, 1, "ns-resize"],
  sw: [0, 1, "nesw-resize"],
  w: [0, 0.5, "ew-resize"],
}

function handleName(h: Handle): string {
  switch (h) {
    case "nw":
      return t("Top left corner")
    case "n":
      return t("Top edge")
    case "ne":
      return t("Top right corner")
    case "e":
      return t("Right edge")
    case "se":
      return t("Bottom right corner")
    case "s":
      return t("Bottom edge")
    case "sw":
      return t("Bottom left corner")
    case "w":
      return t("Left edge")
  }
}

/** A pointer position as 0..1 of the overlay's root (the frame box). */
function pointIn(e: PointerEvent<HTMLElement>): { x: number; y: number } | null {
  const root = e.currentTarget.closest<HTMLElement>("[data-effect-overlay]")
  const r = root?.getBoundingClientRect()
  if (!r || r.width <= 0 || r.height <= 0) return null
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
}

/** The box (or the ellipse in it) of an Obscure step. */
function BoxRegion({ p, image, box }: { p: ObscureParams; image: Size; box: Size }) {
  const rect: NormalizedRect = p.rect ?? { x: 0.35, y: 0.35, w: 0.3, h: 0.3 }
  const drag = useRef<{
    handle: Handle | "move"
    x: number
    y: number
    start: NormalizedRect
  } | null>(null)
  const put = (next: NormalizedRect, live: boolean): void =>
    setParams({ op: "obscure", p: { ...p, rect: next } }, live)
  const begin = (handle: Handle | "move", e: PointerEvent<HTMLElement>): void => {
    if (e.button !== 0) return
    e.stopPropagation()
    capturePointer(e)
    drag.current = { handle, x: e.clientX, y: e.clientY, start: rect }
  }
  const move = (e: PointerEvent<HTMLElement>): void => {
    const d = drag.current
    if (!d || box.w <= 0 || box.h <= 0) return
    const dx = (e.clientX - d.x) / box.w
    const dy = (e.clientY - d.y) / box.h
    put(
      d.handle === "move"
        ? moveRect(d.start, dx, dy, image)
        : dragHandle(d.start, d.handle, dx, dy, null, image),
      true,
    )
  }
  const end = (): void => {
    if (!drag.current) return
    drag.current = null
    endGesture()
  }
  const onKey = (handle: Handle | "move", e: KeyboardEvent<HTMLElement>): void => {
    const next = nudge(rect, handle, e.key, e.shiftKey, null, image)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    put(next, false)
  }
  return (
    <div
      role="group"
      tabIndex={0}
      aria-label={t("Region to obscure; arrow keys move it")}
      data-testid="obscure-region"
      className={`absolute cursor-move border border-white outline-1 outline-black/70 focus-visible:outline-2 focus-visible:outline-accent ${p.shape === "ellipse" ? "rounded-[50%]" : ""}`}
      style={{ left: pct(rect.x), top: pct(rect.y), width: pct(rect.w), height: pct(rect.h) }}
      onPointerDown={(e) => begin("move", e)}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => onKey("move", e)}
    >
      {HANDLES.map((h) => (
        <button
          key={h}
          type="button"
          aria-label={handleName(h)}
          data-handle={h}
          className={handleClass}
          style={{ left: pct(HANDLE_AT[h][0]), top: pct(HANDLE_AT[h][1]), cursor: HANDLE_AT[h][2] }}
          onPointerDown={(e) => begin(h, e)}
          onPointerMove={move}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={(e) => onKey(h, e)}
        />
      ))}
    </div>
  )
}

/** The points of a polygon region. */
function PolygonRegion({ p, image }: { p: ObscureParams; image: Size }) {
  const points = p.points ?? []
  const dragging = useRef<number | null>(null)
  const put = (index: number, x: number, y: number, live: boolean): void => {
    const next = points.map((q): [number, number] => [q[0], q[1]])
    next[index] = [clamp01(x), clamp01(y)]
    setParams({ op: "obscure", p: { ...p, points: next } }, live)
  }
  const end = (): void => {
    if (dragging.current === null) return
    dragging.current = null
    endGesture()
  }
  const onKey = (index: number, e: KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.shiftKey ? 10 : 1
    const [x, y] = points[index]!
    const dx = step / Math.max(image.w, 1)
    const dy = step / Math.max(image.h, 1)
    switch (e.key) {
      case "ArrowLeft":
        put(index, x - dx, y, false)
        break
      case "ArrowRight":
        put(index, x + dx, y, false)
        break
      case "ArrowUp":
        put(index, x, y - dy, false)
        break
      case "ArrowDown":
        put(index, x, y + dy, false)
        break
      case "Delete":
      case "Backspace":
        // Three points are the least a region has.
        if (points.length > 3) {
          setParams({ op: "obscure", p: { ...p, points: points.filter((_, i) => i !== index) } })
        }
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  const outline = points.map((q) => `${q[0] * 100},${q[1] * 100}`).join(" ")
  return (
    <>
      <svg
        className="pointer-events-none absolute inset-0 size-full"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <polygon
          points={outline}
          fill="none"
          stroke="black"
          strokeOpacity="0.7"
          strokeWidth="3"
          vectorEffect="non-scaling-stroke"
        />
        <polygon
          points={outline}
          fill="none"
          stroke="white"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {points.map((q, i) => (
        <button
          key={i}
          type="button"
          data-point={i}
          aria-label={t("Point {n} of {count} of the region", { n: i + 1, count: points.length })}
          className={`${handleClass} cursor-move rounded-full`}
          style={{ left: pct(q[0]), top: pct(q[1]) }}
          onPointerDown={(e) => {
            if (e.button !== 0) return
            e.stopPropagation()
            capturePointer(e)
            dragging.current = i
          }}
          onPointerMove={(e) => {
            if (dragging.current !== i) return
            const at = pointIn(e)
            if (at) put(i, at.x, at.y, true)
          }}
          onPointerUp={end}
          onPointerCancel={end}
          onKeyDown={(e) => onKey(i, e)}
        />
      ))}
    </>
  )
}

/** Shown while the Obscure tool is open on a step of the list. */
export function RegionOverlay({ image, box }: { image: Size; box: Size }) {
  const op = useOp("obscure")
  if (!op) return null
  return (
    <div className="absolute inset-0" data-effect-overlay data-testid="region-overlay">
      {op.p.shape === "polygon" ? (
        <PolygonRegion p={op.p} image={image} />
      ) : (
        <BoxRegion p={op.p} image={image} box={box} />
      )}
    </div>
  )
}

/** The centre of a lens, and the ring of a bulge or a pinch. */
export function LensOverlay({ image, box }: { image: Size; box: Size }) {
  const op = useOp("lens")
  const dragging = useRef(false)
  if (!op) return null
  const p = op.p
  const cx = p.cx ?? 0.5
  const cy = p.cy ?? 0.5
  const round = (p.mode ?? "bulge") === "bulge" || p.mode === "pinch"
  const radius = ((p.radius ?? 50) / 100) * Math.min(box.w, box.h)
  const put = (x: number, y: number, live: boolean): void =>
    setParams(
      {
        op: "lens",
        p: {
          ...p,
          cx: Math.round(clamp01(x) * 1e5) / 1e5,
          cy: Math.round(clamp01(y) * 1e5) / 1e5,
        },
      },
      live,
    )
  const end = (): void => {
    if (!dragging.current) return
    dragging.current = false
    endGesture()
  }
  const onKey = (e: KeyboardEvent<HTMLButtonElement>): void => {
    const step = e.shiftKey ? 10 : 1
    const dx = step / Math.max(image.w, 1)
    const dy = step / Math.max(image.h, 1)
    switch (e.key) {
      case "ArrowLeft":
        put(cx - dx, cy, false)
        break
      case "ArrowRight":
        put(cx + dx, cy, false)
        break
      case "ArrowUp":
        put(cx, cy - dy, false)
        break
      case "ArrowDown":
        put(cx, cy + dy, false)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  return (
    <div
      className="pointer-events-none absolute inset-0"
      data-effect-overlay
      data-testid="lens-overlay"
    >
      {round && (
        <span
          aria-hidden="true"
          className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full border border-white outline-1 outline-black/70"
          style={{ left: pct(cx), top: pct(cy), width: radius * 2, height: radius * 2 }}
          data-testid="lens-ring"
        />
      )}
      <button
        type="button"
        aria-label={t("Centre of the lens; arrow keys move it")}
        data-testid="lens-centre"
        className={`${handleClass} pointer-events-auto cursor-move rounded-full`}
        style={{ left: pct(cx), top: pct(cy) }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          e.stopPropagation()
          capturePointer(e)
          dragging.current = true
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return
          const at = pointIn(e)
          if (at) put(at.x, at.y, true)
        }}
        onPointerUp={end}
        onPointerCancel={end}
        onDoubleClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      />
    </div>
  )
}
