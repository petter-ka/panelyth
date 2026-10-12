// The editor's canvas (Stage 12): the frame Go rendered, with zoom and pan
// (the viewer's zoom math), the crop box, the straighten line and the
// eyedropper with its loupe (Stage 13). The frame is an <img> on a token
// URL; a new frame is swapped in only once it has loaded, so the canvas
// never goes blank while a control moves.
import {
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type Ref,
} from "react"
import type { NormalizedRect } from "@panelyth/contracts"
import { MAX_FRAME_EDGE } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import {
  clampOffset,
  clampZoom,
  displaySize,
  fitZoom,
  useViewerImage,
  zoomAt,
  ZOOM_STEP,
  type Size,
  type ZoomState,
} from "../../features/media/mediaUi"
import { useThumb } from "../../features/previews/thumbStore"
import {
  dragHandle,
  HANDLES,
  moveRect,
  nudge,
  straightenAngle,
  type Handle,
} from "../../features/editor/crop"
import { surroundColor, useEditorSettings } from "../../features/editor/editorSettings"
import {
  panelOp,
  pickAt,
  probeAt,
  setCropRect,
  setParams,
  setStraighten,
  setViewEdge,
  useEditorStore,
} from "../../features/editor/editorStore"
import type { CropGuide } from "./ToolPanels"
import { capturePointer } from "./controls"
import { LensOverlay, RegionOverlay } from "./EffectOverlays"
import { PaintOverlay } from "./PaintOverlay"

export interface CanvasController {
  fit(): void
  actualSize(): void
  zoomIn(): void
  zoomOut(): void
}

type Mode = { kind: "fit" } | ({ kind: "free" } & ZoomState)

const WHEEL_SENSITIVITY = 0.0015
const PLACEHOLDER_SCALE = 16
/** Space around a fitted picture, so handles at its edge stay reachable. */
const FIT_MARGIN = 24

function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1)
  useEffect(() => {
    const media = window.matchMedia?.(`(resolution: ${dpr}dppx)`)
    const onChange = (): void => setDpr(window.devicePixelRatio || 1)
    media?.addEventListener("change", onChange)
    return () => media?.removeEventListener("change", onChange)
  }, [dpr])
  return dpr
}

/** The frame and the one before it: the old one stays until the new one has loaded. */
function FrameLayers({ url }: { url: string }) {
  const [shown, setShown] = useState(url)
  const pending = url !== shown ? url : null
  return (
    <>
      <img
        key={shown}
        src={shown}
        alt=""
        draggable={false}
        className="absolute inset-0 size-full select-none"
        data-testid="editor-frame"
      />
      {pending && (
        <img
          key={pending}
          src={pending}
          alt=""
          draggable={false}
          // Laid over the old frame but invisible until it can be painted.
          className="absolute inset-0 size-full opacity-0 select-none"
          onLoad={() => setShown(pending)}
          onError={() => setShown(pending)}
        />
      )}
    </>
  )
}

const HANDLE_POS: Record<Handle, { left: string; top: string; cursor: string }> = {
  nw: { left: "0%", top: "0%", cursor: "nwse-resize" },
  n: { left: "50%", top: "0%", cursor: "ns-resize" },
  ne: { left: "100%", top: "0%", cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: "0%", top: "100%", cursor: "nesw-resize" },
  w: { left: "0%", top: "50%", cursor: "ew-resize" },
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

const GUIDES: Record<CropGuide, readonly number[]> = {
  thirds: [1 / 3, 2 / 3],
  golden: [0.382, 0.618],
  none: [],
}

/**
 * The crop box, in percent of the frame box, so it follows zoom and pan for
 * free. Pointer deltas are divided by the box's size on screen; arrow keys
 * move the box, or a focused handle, by one picture pixel (ten with Shift).
 */
function CropOverlay({
  rect,
  image,
  box,
  ratio,
  guide,
}: {
  rect: NormalizedRect
  image: Size
  /** The frame box on screen, in CSS px. */
  box: Size
  ratio: number | null
  guide: CropGuide
}) {
  const drag = useRef<{
    handle: Handle | "move"
    x: number
    y: number
    start: NormalizedRect
  } | null>(null)
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
    setCropRect(
      d.handle === "move"
        ? moveRect(d.start, dx, dy, image)
        : dragHandle(d.start, d.handle, dx, dy, ratio, image),
    )
  }
  const end = (): void => {
    drag.current = null
  }
  const onKey = (handle: Handle | "move", e: KeyboardEvent<HTMLElement>): void => {
    const next = nudge(rect, handle, e.key, e.shiftKey, ratio, image)
    if (!next) return
    e.preventDefault()
    e.stopPropagation()
    setCropRect(next)
  }
  const pct = (v: number): string => `${v * 100}%`
  const lines = GUIDES[guide]
  return (
    <div className="absolute inset-0" data-testid="crop-overlay">
      {/* What the crop removes, dimmed: four bands around the box. */}
      <div className="absolute inset-x-0 top-0 bg-black/55" style={{ height: pct(rect.y) }} />
      <div
        className="absolute inset-x-0 bottom-0 bg-black/55"
        style={{ height: pct(1 - rect.y - rect.h) }}
      />
      <div
        className="absolute left-0 bg-black/55"
        style={{ top: pct(rect.y), height: pct(rect.h), width: pct(rect.x) }}
      />
      <div
        className="absolute right-0 bg-black/55"
        style={{ top: pct(rect.y), height: pct(rect.h), width: pct(1 - rect.x - rect.w) }}
      />
      <div
        role="group"
        tabIndex={0}
        aria-label={t("Crop box; arrow keys move it, Enter applies")}
        data-testid="crop-box"
        className="absolute cursor-move outline-1 outline-white/90 focus-visible:outline-2 focus-visible:outline-accent"
        style={{
          left: pct(rect.x),
          top: pct(rect.y),
          width: pct(rect.w),
          height: pct(rect.h),
        }}
        onPointerDown={(e) => begin("move", e)}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onKeyDown={(e) => onKey("move", e)}
      >
        {lines.map((v) => (
          <span key={`v${v}`} aria-hidden="true">
            <span className="absolute inset-y-0 w-px bg-white/45" style={{ left: pct(v) }} />
            <span className="absolute inset-x-0 h-px bg-white/45" style={{ top: pct(v) }} />
          </span>
        ))}
        {HANDLES.map((h) => (
          <button
            key={h}
            type="button"
            aria-label={handleName(h)}
            data-handle={h}
            className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-sm border border-black/60 bg-white focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
            style={{
              left: HANDLE_POS[h].left,
              top: HANDLE_POS[h].top,
              cursor: HANDLE_POS[h].cursor,
            }}
            onPointerDown={(e) => begin(h, e)}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            onKeyDown={(e) => onKey(h, e)}
          />
        ))}
      </div>
    </div>
  )
}

/** Draw a line; its angle becomes the rotation that levels it. */
function StraightenOverlay() {
  const [line, setLine] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const point = (e: PointerEvent<HTMLDivElement>): { x: number; y: number } => {
    const r = e.currentTarget.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const finish = (): void => {
    if (line) {
      const dx = line.x1 - line.x0
      const dy = line.y1 - line.y0
      if (Math.hypot(dx, dy) >= 12) {
        const op = panelOp(useEditorStore.getState())
        const current = op?.op === "rotate" ? op.p : { angle: 0 }
        const angle = Math.round((current.angle + straightenAngle(dx, dy)) * 10) / 10
        setParams({
          op: "rotate",
          p: {
            mode: "crop",
            fill: "#ffffff",
            ...current,
            angle: Math.min(Math.max(angle, -45), 45),
          },
        })
      }
    }
    setLine(null)
    setStraighten(false)
  }
  return (
    <div
      className="absolute inset-0 cursor-crosshair"
      data-testid="straighten-overlay"
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.stopPropagation()
        capturePointer(e)
        const p = point(e)
        setLine({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
      }}
      onPointerMove={(e) => {
        if (!line) return
        const p = point(e)
        setLine({ ...line, x1: p.x, y1: p.y })
      }}
      onPointerUp={finish}
      onPointerCancel={() => setLine(null)}
    >
      {line && (
        <svg className="pointer-events-none absolute inset-0 size-full" aria-hidden="true">
          <line
            x1={line.x0}
            y1={line.y0}
            x2={line.x1}
            y2={line.y1}
            stroke="white"
            strokeWidth="1.5"
            style={{ filter: "drop-shadow(0 0 1px black)" }}
          />
        </svg>
      )}
    </div>
  )
}

/** Picture pixels the loupe shows along each side, and how large each is drawn. */
const LOUPE_PIXELS = 11
const LOUPE_SCALE = 8
const LOUPE_SIZE = LOUPE_PIXELS * LOUPE_SCALE

/**
 * An eyedropper is waiting for a click. The loupe follows the pointer: the
 * magnified pixels are painted from the frame that is on screen, the
 * numbers come from Go (`edit.probe`), so no pixel is read here. With the
 * keyboard the arrow keys move the point and Enter takes the color.
 */
function PickerOverlay() {
  const root = useRef<HTMLDivElement>(null)
  const loupe = useRef<HTMLDivElement>(null)
  const zoomed = useRef<HTMLCanvasElement>(null)
  const [color, setColor] = useState<{ hex: string; rgba: readonly number[] } | null>(null)
  // Where the eyedropper points, 0..1 of the picture.
  const at = useRef({ x: 0.5, y: 0.5 })
  const wanted = useRef<{ x: number; y: number } | null>(null)
  const probing = useRef(false)
  const alive = useRef(true)

  // The keyboard reaches the picture at once; the focus goes back afterwards.
  useEffect(() => {
    alive.current = true
    const previous = document.activeElement
    root.current?.focus({ preventScroll: true })
    return () => {
      alive.current = false
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus()
    }
  }, [])

  // One probe at a time; only the newest position waits.
  const probe = (x: number, y: number): void => {
    wanted.current = { x, y }
    if (probing.current) return
    probing.current = true
    void (async () => {
      while (wanted.current && alive.current) {
        const next = wanted.current
        wanted.current = null
        const found = await probeAt(next.x, next.y)
        if (found && alive.current) setColor(found)
      }
      probing.current = false
    })()
  }

  /** Moves the loupe to a point of the picture and repaints it. */
  const show = (x: number, y: number): void => {
    at.current = { x, y }
    const el = root.current
    const box = loupe.current
    if (!el || !box) return
    const r = el.getBoundingClientRect()
    const view = el.closest('[data-testid="editor-canvas"]')?.getBoundingClientRect() ?? r
    const px = x * r.width
    const py = y * r.height
    // Beside the pointer, on the side that has room.
    const right = r.left + px + 16 + LOUPE_SIZE + 12 <= view.right
    const below = r.top + py + 16 + LOUPE_SIZE + 44 <= view.bottom
    box.style.left = `${right ? px + 16 : px - 28 - LOUPE_SIZE}px`
    box.style.top = `${below ? py + 16 : py - 60 - LOUPE_SIZE}px`
    box.hidden = false
    const frame = el.parentElement?.querySelector<HTMLImageElement>('[data-testid="editor-frame"]')
    const ctx = zoomed.current?.getContext?.("2d")
    if (ctx && frame && frame.naturalWidth > 0) {
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE)
      ctx.drawImage(
        frame,
        Math.round(x * frame.naturalWidth) - (LOUPE_PIXELS - 1) / 2,
        Math.round(y * frame.naturalHeight) - (LOUPE_PIXELS - 1) / 2,
        LOUPE_PIXELS,
        LOUPE_PIXELS,
        0,
        0,
        LOUPE_SIZE,
        LOUPE_SIZE,
      )
    }
    probe(x, y)
  }

  const point = (e: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    const unit = (v: number, size: number): number =>
      size > 0 ? Math.min(Math.max(v / size, 0), 1) : 0.5
    return { x: unit(e.clientX - r.left, r.width), y: unit(e.clientY - r.top, r.height) }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const step = e.shiftKey ? 0.05 : 0.005
    const { x, y } = at.current
    const clamp = (v: number): number => Math.min(Math.max(v, 0), 1)
    switch (e.key) {
      case "ArrowLeft":
        show(clamp(x - step), y)
        break
      case "ArrowRight":
        show(clamp(x + step), y)
        break
      case "ArrowUp":
        show(x, clamp(y - step))
        break
      case "ArrowDown":
        show(x, clamp(y + step))
        break
      case "Enter":
      case " ":
        void pickAt(x, y)
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const mid = (LOUPE_SIZE - LOUPE_SCALE) / 2
  return (
    <div
      ref={root}
      tabIndex={0}
      role="application"
      aria-label={t("Eyedropper; arrow keys move it, Enter takes the color, Esc cancels")}
      className="absolute inset-0 cursor-crosshair outline-none"
      data-testid="picker-overlay"
      onPointerDown={(e) => e.stopPropagation()}
      onPointerMove={(e) => {
        const p = point(e)
        show(p.x, p.y)
      }}
      onPointerLeave={() => {
        if (loupe.current && document.activeElement !== root.current) loupe.current.hidden = true
      }}
      onFocus={() => show(at.current.x, at.current.y)}
      onClick={(e) => {
        e.stopPropagation()
        const p = point(e)
        void pickAt(p.x, p.y)
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
    >
      <div
        ref={loupe}
        hidden
        className="pointer-events-none absolute z-10 rounded-md border border-border bg-raised p-1 text-[0.625rem] text-text tabular-nums"
        data-testid="loupe"
      >
        <div className="relative" style={{ width: LOUPE_SIZE, height: LOUPE_SIZE }}>
          <canvas
            ref={zoomed}
            width={LOUPE_SIZE}
            height={LOUPE_SIZE}
            className="block rounded-sm"
          />
          {/* The pixel the color is taken around. */}
          <span
            aria-hidden="true"
            className="absolute border border-white outline-1 outline-black/70"
            style={{ left: mid, top: mid, width: LOUPE_SCALE, height: LOUPE_SCALE }}
          />
        </div>
        <div className="mt-1 flex items-center gap-1.5" aria-live="polite">
          <span
            aria-hidden="true"
            className="size-3 rounded-sm border border-border"
            style={{ background: color?.hex ?? "transparent" }}
          />
          <span data-testid="loupe-hex">{color?.hex ?? "…"}</span>
        </div>
        <div data-testid="loupe-rgb">
          {color ? `R ${color.rgba[0]}  G ${color.rgba[1]}  B ${color.rgba[2]}` : " "}
        </div>
      </div>
    </div>
  )
}

export function EditorCanvas({
  controllerRef,
  onZoomChange,
  ratio,
  guide,
}: {
  controllerRef?: Ref<CanvasController>
  onZoomChange?: (zoom: number, isFit: boolean) => void
  /** The crop ratio lock (width over height in pixels), or null. */
  ratio: number | null
  guide: CropGuide
}) {
  const dpr = useDevicePixelRatio()
  const entry = useEditorStore((s) => s.entry)
  const session = useEditorStore((s) => s.session)
  const frame = useEditorStore((s) => s.frame)
  const output = useEditorStore((s) => s.output)
  const crop = useEditorStore((s) => s.crop)
  const straighten = useEditorStore((s) => s.straighten)
  const picker = useEditorStore((s) => s.picker)
  const tool = useEditorStore((s) => s.tool)
  const compare = useEditorStore((s) => s.compare)
  const surround = useEditorSettings((s) => s.settings.surround)
  const thumb = useThumb(entry?.id ?? -1)
  const fit = useViewerImage(entry?.id ?? null).fit
  // Until the first frame: the viewer's cached preview, else the tile thumbnail.
  const placeholder =
    fit?.status === "ready" ? fit.thumb : thumb?.status === "ready" ? thumb.thumb : null

  const viewportRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState<Size>({ w: 0, h: 0 })
  const [mode, setMode] = useState<Mode>({ kind: "fit" })

  useLayoutEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      setViewport((v) => (v.w === r.width && v.h === r.height ? v : { w: r.width, h: r.height }))
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // The logical size is the full-resolution size of what is shown, so 100 %
  // means one picture pixel per device pixel whatever size the frame has.
  const logical: Size | null = output
    ? { w: output.width, h: output.height }
    : session
      ? { w: session.width, h: session.height }
      : placeholder
        ? { w: placeholder.width * PLACEHOLDER_SCALE, h: placeholder.height * PLACEHOLDER_SCALE }
        : null
  const inner = {
    w: Math.max(viewport.w - 2 * FIT_MARGIN, 1),
    h: Math.max(viewport.h - 2 * FIT_MARGIN, 1),
  }
  const fitZ = logical ? fitZoom(logical, inner, dpr) : 1
  const state: ZoomState =
    mode.kind === "fit" || !logical
      ? { zoom: fitZ, x: 0, y: 0 }
      : clampOffset({ zoom: mode.zoom, x: mode.x, y: mode.y }, logical, viewport, dpr)

  useEffect(
    () => onZoomChange?.(state.zoom, mode.kind === "fit"),
    [state.zoom, mode.kind, onZoomChange],
  )

  // Ask for as many pixels as the picture takes on screen, no more.
  const needed = logical ? Math.max(logical.w, logical.h) * state.zoom : 0
  useEffect(() => {
    if (needed <= 0 || viewport.w <= 0) return
    const visible = Math.max(viewport.w, viewport.h) * dpr
    const id = setTimeout(() => setViewEdge(Math.min(needed, visible * 1.5, MAX_FRAME_EDGE)), 120)
    return () => clearTimeout(id)
  }, [needed, viewport.w, viewport.h, dpr])

  const setZoom = (next: number, point = { x: 0, y: 0 }): void => {
    if (!logical) return
    const z = clampZoom(next, fitZ)
    setMode({ kind: "free", ...clampOffset(zoomAt(state, z, point), logical, viewport, dpr) })
  }

  useImperativeHandle(controllerRef, () => ({
    fit: () => setMode({ kind: "fit" }),
    actualSize: () => setZoom(1),
    zoomIn: () => setZoom(state.zoom * ZOOM_STEP),
    zoomOut: () => setZoom(state.zoom / ZOOM_STEP),
  }))

  const setZoomRef = useRef(setZoom)
  const zoomRef = useRef(state.zoom)
  useEffect(() => {
    setZoomRef.current = setZoom
    zoomRef.current = state.zoom
  })
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const point = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
      setZoomRef.current(zoomRef.current * Math.exp(-e.deltaY * WHEEL_SENSITIVITY), point)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  const size = logical ? displaySize(logical, state.zoom, dpr) : { w: 0, h: 0 }
  const pannable = size.w > viewport.w + 0.5 || size.h > viewport.h + 0.5
  const pan = useRef<{ id: number; x: number; y: number; start: ZoomState } | null>(null)

  const label = entry
    ? output
      ? t("{name}, edited picture, {w} × {h} pixels", {
          name: entry.name,
          w: output.width,
          h: output.height,
        })
      : entry.name
    : ""

  return (
    <div
      ref={viewportRef}
      className={`relative h-full w-full overflow-hidden ${pannable ? "cursor-grab active:cursor-grabbing" : ""}`}
      style={{ background: surroundColor(surround) }}
      data-testid="editor-canvas"
      data-zoom={state.zoom.toFixed(4)}
      data-mode={mode.kind}
      data-frame={frame?.url ?? ""}
      data-compare={compare || undefined}
      onPointerDown={(e) => {
        if (e.button !== 0 || !pannable) return
        capturePointer(e)
        pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: state }
      }}
      onPointerMove={(e) => {
        const d = pan.current
        if (!d || d.id !== e.pointerId || !logical) return
        const next = {
          zoom: d.start.zoom,
          x: d.start.x + e.clientX - d.x,
          y: d.start.y + e.clientY - d.y,
        }
        setMode({ kind: "free", ...clampOffset(next, logical, viewport, dpr) })
      }}
      onPointerUp={() => (pan.current = null)}
      onPointerCancel={() => (pan.current = null)}
      onDoubleClick={(e) => {
        if (crop || straighten || picker || tool === "draw" || tool === "clone" || tool === "heal")
          return
        if (mode.kind === "fit" && fitZ < 1) {
          const r = e.currentTarget.getBoundingClientRect()
          setZoom(1, {
            x: e.clientX - r.left - r.width / 2,
            y: e.clientY - r.top - r.height / 2,
          })
        } else setMode({ kind: "fit" })
      }}
    >
      {logical && (
        <div
          role="img"
          aria-label={label}
          className="absolute"
          data-testid="editor-frame-box"
          style={{
            width: size.w,
            height: size.h,
            left: `calc(50% + ${state.x - size.w / 2}px)`,
            top: `calc(50% + ${state.y - size.h / 2}px)`,
            imageRendering: state.zoom >= 2 ? "pixelated" : "auto",
          }}
        >
          {frame ? (
            <FrameLayers url={frame.url} />
          ) : (
            placeholder && (
              <img
                src={placeholder.url}
                alt=""
                draggable={false}
                className="absolute inset-0 size-full select-none"
                data-testid="editor-placeholder"
              />
            )
          )}
          {crop && !compare && (
            <CropOverlay rect={crop.rect} image={logical} box={size} ratio={ratio} guide={guide} />
          )}
          {straighten && !compare && <StraightenOverlay />}
          {picker && !compare && <PickerOverlay />}
          {tool === "obscure" && !compare && !picker && (
            <RegionOverlay image={logical} box={size} />
          )}
          {tool === "lens" && !compare && !picker && <LensOverlay image={logical} box={size} />}
          {(tool === "draw" || tool === "clone" || tool === "heal" || tool === "redeye") &&
            !compare &&
            !picker && <PaintOverlay tool={tool} image={logical} box={size} />}
        </div>
      )}
    </div>
  )
}
