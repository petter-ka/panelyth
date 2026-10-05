import type { Thumb } from "@fastview/contracts"
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react"
import {
  requestOriginal,
  retry,
  useViewerImage,
  type FitLane,
} from "../../features/viewer/viewerImages"
import {
  clampOffset,
  clampZoom,
  displaySize,
  fitZoom,
  neededPixels,
  zoomAt,
  ZOOM_STEP,
  type Size,
  type ZoomState,
} from "../../features/viewer/zoom"
import {
  cssTransform,
  IDENTITY,
  isIdentity,
  orientedSize,
  type ViewTransform,
} from "../../features/viewer/transform"

export interface ImageViewerController {
  fit(): void
  actualSize(): void
  zoomIn(): void
  zoomOut(): void
}

interface ImageViewerProps {
  entryId: number
  /** Shown instantly (the tile thumbnail) until a sharper layer is decoded. */
  placeholder: Thumb | null
  controllerRef?: Ref<ImageViewerController>
  onZoomChange?: (zoom: number, isFit: boolean) => void
  /** Preview lane for Try again (the focused viewer or the preview pane). */
  lane?: FitLane
  /** Display-only rotation/flip (Stage 08); fit and panning follow it. */
  transform?: ViewTransform
  /** The focused viewer can use the wheel to step through images. */
  wheelMode?: "zoom" | "previousNext"
  onWheelNavigate?: (direction: -1 | 1) => void
  /** Double-click action for the focused viewer; preview images retain fit toggle. */
  onDoubleClick?: () => void
}

type Mode = { kind: "fit" } | ({ kind: "free" } & ZoomState)

// Placeholders are tiny; scale their aspect up so "fit" fills the view until
// the real size is known.
const PLACEHOLDER_SCALE = 16
const WHEEL_SENSITIVITY = 0.0015

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

/**
 * Render with key={entryId}: each image starts fitted with fresh state.
 *
 * Zoomable, pannable image surface, used by the focused viewer and the
 * preview pane (Stage 06).
 * Layers — placeholder, viewer-fit preview, original — share one box of the
 * image's logical size, so swapping a layer never moves anything. A layer is
 * shown only after it has been decoded (no blank or half-painted frames), and
 * the original is loaded only when the zoom needs more pixels than the
 * preview has.
 */
export function ImageViewer({
  entryId,
  placeholder,
  controllerRef,
  onZoomChange,
  lane = "viewer",
  transform = IDENTITY,
  wheelMode = "zoom",
  onWheelNavigate,
  onDoubleClick,
}: ImageViewerProps) {
  const dpr = useDevicePixelRatio()
  const { fit, media } = useViewerImage(entryId)
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

  const mediaInfo = media?.status === "ready" ? media.media : null
  const logical: Size | null =
    mediaInfo && mediaInfo.width > 0
      ? { w: mediaInfo.width, h: mediaInfo.height }
      : fit?.status === "ready"
        ? { w: fit.thumb.width, h: fit.thumb.height }
        : placeholder
          ? { w: placeholder.width * PLACEHOLDER_SCALE, h: placeholder.height * PLACEHOLDER_SCALE }
          : null

  // Zoom and pan work on the image as displayed (rotated); the layer box
  // below keeps the logical size and rotates inside it.
  const view = logical ? orientedSize(logical, transform) : null
  const fitZ = view ? fitZoom(view, viewport, dpr) : 1
  const state: ZoomState =
    mode.kind === "fit" || !view
      ? { zoom: fitZ, x: 0, y: 0 }
      : clampOffset({ zoom: mode.zoom, x: mode.x, y: mode.y }, view, viewport, dpr)

  useEffect(
    () => onZoomChange?.(state.zoom, mode.kind === "fit"),
    [state.zoom, mode.kind, onZoomChange],
  )

  // The original is loaded only when the decoded preview cannot supply the
  // pixels this zoom needs, or when the preview failed and the original is
  // the only way to show the image. Never while the preview is still coming:
  // that would decode every full-size original on open.
  const fitPixels = fit?.status === "ready" ? Math.max(fit.thumb.width, fit.thumb.height) : 0
  const needsOriginal =
    !!logical &&
    !!mediaInfo?.url &&
    (fit?.status === "failed" ||
      (fitPixels > 0 && neededPixels(logical, state.zoom) > fitPixels * 1.05))
  useEffect(() => {
    if (needsOriginal) void requestOriginal(entryId)
  }, [needsOriginal, entryId])

  const setZoom = (next: number, point = { x: 0, y: 0 }): void => {
    if (!view) return
    const z = clampZoom(next, fitZ)
    setMode({ kind: "free", ...clampOffset(zoomAt(state, z, point), view, viewport, dpr) })
  }

  useImperativeHandle(
    controllerRef,
    () => ({
      fit: () => setMode({ kind: "fit" }),
      actualSize: () => setZoom(1),
      zoomIn: () => setZoom(state.zoom * ZOOM_STEP),
      zoomOut: () => setZoom(state.zoom / ZOOM_STEP),
    }),
    // No deps: the controller is recreated each render (cheap) and never stale.
  )

  // Wheel zooms around the cursor (non-passive so the page never scrolls).
  const setZoomRef = useRef(setZoom)
  const zoomRef = useRef(state.zoom)
  const wheelNavigateRef = useRef(onWheelNavigate)
  const wheelModeRef = useRef(wheelMode)
  const lastWheelNavigation = useRef(0)
  useEffect(() => {
    setZoomRef.current = setZoom
    zoomRef.current = state.zoom
    wheelNavigateRef.current = onWheelNavigate
    wheelModeRef.current = wheelMode
  }, [onWheelNavigate, state.zoom, wheelMode])
  useEffect(() => {
    const el = viewportRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (wheelModeRef.current === "previousNext" && !(e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        if (e.deltaY === 0) return
        const now = performance.now()
        if (lastWheelNavigation.current > 0 && now - lastWheelNavigation.current < 140) return
        lastWheelNavigation.current = now
        wheelNavigateRef.current?.(e.deltaY > 0 ? 1 : -1)
        return
      }
      e.preventDefault()
      const r = el.getBoundingClientRect()
      const point = { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
      setZoomRef.current(zoomRef.current * Math.exp(-e.deltaY * WHEEL_SENSITIVITY), point)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [])

  // Drag to pan, only when the image is larger than the view.
  const drag = useRef<{ id: number; x: number; y: number; start: ZoomState } | null>(null)
  const size = view ? displaySize(view, state.zoom, dpr) : { w: 0, h: 0 }
  const pannable = size.w > viewport.w + 0.5 || size.h > viewport.h + 0.5

  const pointFromEvent = (clientX: number, clientY: number) => {
    const r = viewportRef.current!.getBoundingClientRect()
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 }
  }

  const fitDecoded = fit?.status === "ready" && fit.decoded
  const originalShown = media?.status === "ready" && media.originalDecoded && !!media.media.url
  const failed =
    !fitDecoded && !originalShown && (fit?.status === "failed" || media?.status === "failed")
  const failCode =
    fit?.status === "failed" ? fit.code : media?.status === "failed" ? media.code : undefined

  const layerStyle = {
    imageRendering: state.zoom >= 2 ? ("pixelated" as const) : ("auto" as const),
  }

  return (
    <div
      ref={viewportRef}
      className={`relative h-full w-full overflow-hidden bg-canvas ${pannable ? "cursor-grab active:cursor-grabbing" : ""}`}
      data-testid="image-viewer"
      data-zoom={state.zoom.toFixed(4)}
      data-mode={mode.kind}
      data-rotate={transform.rotate}
      data-flip={transform.flipH || undefined}
      data-layer={
        originalShown ? "original" : fitDecoded ? "fit" : placeholder ? "placeholder" : "none"
      }
      onPointerDown={(e) => {
        if (e.button !== 0 || !pannable) return
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, start: state }
      }}
      onPointerMove={(e) => {
        const d = drag.current
        if (!d || d.id !== e.pointerId || !view) return
        const next = {
          zoom: d.start.zoom,
          x: d.start.x + e.clientX - d.x,
          y: d.start.y + e.clientY - d.y,
        }
        setMode({ kind: "free", ...clampOffset(next, view, viewport, dpr) })
      }}
      onPointerUp={() => (drag.current = null)}
      onPointerCancel={() => (drag.current = null)}
      onDoubleClick={(e) => {
        if (onDoubleClick) {
          onDoubleClick()
          return
        }
        if (mode.kind === "fit" && fitZ < 1) setZoom(1, pointFromEvent(e.clientX, e.clientY))
        else setMode({ kind: "fit" })
      }}
    >
      {logical && !failed && (
        <div
          className="absolute top-1/2 left-1/2"
          style={{
            width: logical.w / dpr,
            height: logical.h / dpr,
            transform: `translate(-50%, -50%) translate(${state.x}px, ${state.y}px) scale(${state.zoom})${isIdentity(transform) ? "" : ` ${cssTransform(transform)}`}`,
            transformOrigin: "center",
          }}
        >
          {placeholder && !fitDecoded && !originalShown && (
            <img
              src={placeholder.url}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full"
            />
          )}
          {fit?.status === "ready" && fitDecoded && (
            <img
              src={fit.thumb.url}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full"
              style={layerStyle}
              data-testid="viewer-fit-layer"
            />
          )}
          {originalShown && media.media.url && (
            <img
              src={media.media.url}
              alt=""
              draggable={false}
              className="absolute inset-0 size-full"
              style={layerStyle}
              data-testid="viewer-original-layer"
            />
          )}
        </div>
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
          <p className="text-sm font-medium">This image can't be displayed</p>
          <p className="max-w-sm text-xs text-muted">
            {failCode === "NOT_FOUND"
              ? "The file was moved or deleted."
              : failCode === "PERMISSION_DENIED"
                ? "FastView doesn't have permission to read this file."
                : "The file may be damaged or in a format FastView can't read."}
          </p>
          <button
            type="button"
            onClick={() => retry(entryId, lane)}
            className="mt-2 h-7 rounded-md border border-border bg-raised px-2.5 text-xs hover:border-muted"
          >
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
