import type { ContentItem } from "@panelyth/contracts"
import { Tooltip } from "@panelyth/ui"
import { createPortal } from "react-dom"
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react"
import {
  formatTime,
  ImageViewer,
  useViewerImage,
  VideoPlayer,
  type ImageViewerController,
} from "../features/media/mediaUi"
import { closeVideoFullscreen, usePreviewStore } from "../features/preview/previewStore"
import { useThumb } from "../features/previews/thumbStore"
import { useViewerStore } from "../features/viewer/viewerStore"
import { formatBytes, formatCount } from "../lib/format"
import { EmptyState } from "./EmptyState"

const zoomButton =
  "h-6 rounded-md border border-border bg-raised px-2 text-[0.6875rem] enabled:hover:border-muted aria-pressed:border-accent aria-pressed:text-accent"

/**
 * The preview pane (Stage 06): the selected image with fit / 1:1 / zoom / pan,
 * or the selected video with playback controls. It follows the selection
 * once it settles (previewStore), and each item mounts fresh (key = id), so
 * leaving a video stops it and releases its decoder.
 */
export function PreviewPane() {
  const item = usePreviewStore((s) => s.item)
  const count = usePreviewStore((s) => s.count)
  const play = usePreviewStore((s) => s.play)
  // The focused viewer covers the window: the pane unmounts its media (a
  // playing video stops; no second image layer is kept decoded behind it).
  const suspended = useViewerStore((s) => s.open)
  const controller = useRef<ImageViewerController>(null)
  const [zoom, setZoom] = useState({ value: 1, fit: true })
  const onZoomChange = useCallback((value: number, fit: boolean) => setZoom({ value, fit }), [])

  const shown = count > 1 ? null : item
  const isImage = shown?.kind === "image"

  // Zoom keys while the pane has focus (the tile view keeps its own keys).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!isImage || e.ctrlKey || e.metaKey || e.altKey) return
    const c = controller.current
    const keys: Record<string, (() => void) | undefined> = {
      "+": c?.zoomIn,
      "=": c?.zoomIn,
      "-": c?.zoomOut,
      "0": c?.fit,
      "1": c?.actualSize,
    }
    const action = keys[e.key]
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  return (
    <aside
      aria-label="Preview"
      className="flex h-full min-h-0 flex-col overflow-hidden border-t border-border"
      data-testid="preview-pane"
      data-entry-id={shown?.id}
    >
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
        <Tooltip content={shown?.name}>
          <span className="min-w-0 flex-1 truncate text-xs font-medium">
            {shown?.name ?? "Preview"}
          </span>
        </Tooltip>
        {isImage && (
          <div role="toolbar" aria-label="Zoom" className="flex shrink-0 items-center gap-1">
            <Tooltip content="Fit (0)">
              <button
                type="button"
                className={zoomButton}
                aria-pressed={zoom.fit}
                onClick={() => controller.current?.fit()}
              >
                Fit
              </button>
            </Tooltip>
            <Tooltip content="Actual size (1)">
              <button
                type="button"
                className={zoomButton}
                onClick={() => controller.current?.actualSize()}
              >
                1:1
              </button>
            </Tooltip>
            <Tooltip content="Zoom out (−)">
              <button
                type="button"
                className={`${zoomButton} w-6 px-0`}
                onClick={() => controller.current?.zoomOut()}
                aria-label="Zoom out"
              >
                −
              </button>
            </Tooltip>
            <span
              className="w-9 text-center text-[0.6875rem] tabular-nums"
              data-testid="pane-zoom"
              aria-live="polite"
            >
              {Math.round(zoom.value * 100)}%
            </span>
            <Tooltip content="Zoom in (+)">
              <button
                type="button"
                className={`${zoomButton} w-6 px-0`}
                onClick={() => controller.current?.zoomIn()}
                aria-label="Zoom in"
              >
                +
              </button>
            </Tooltip>
          </div>
        )}
      </div>
      {/* Canvas, like the content body: previews sit on the same neutral field. */}
      <div className="min-h-0 flex-1 bg-canvas" onKeyDown={onKeyDown}>
        {suspended ? null : count > 1 ? (
          <EmptyState
            title={`${formatCount(count)} items selected`}
            description="Select a single image or video to preview it."
          />
        ) : !shown ? (
          <EmptyState
            title="Nothing selected"
            description="Select an image or video to preview it here."
          />
        ) : shown.kind === "dir" ? (
          <EmptyState title={shown.name} description="Folder. Press Enter to open it." />
        ) : shown.kind === "image" ? (
          <div tabIndex={-1} className="h-full outline-none" aria-label={`Image: ${shown.name}`}>
            <PaneImage item={shown} controllerRef={controller} onZoomChange={onZoomChange} />
          </div>
        ) : (
          <PaneVideo item={shown} play={play?.id === shown.id ? play : null} />
        )}
      </div>
      {shown && shown.kind !== "dir" && <PaneDetails item={shown} />}
    </aside>
  )
}

function PaneImage({
  item,
  controllerRef,
  onZoomChange,
}: {
  item: ContentItem
  controllerRef: RefObject<ImageViewerController | null>
  onZoomChange: (value: number, fit: boolean) => void
}) {
  const thumb = useThumb(item.id)
  return (
    <ImageViewer
      key={item.id}
      entryId={item.id}
      placeholder={thumb?.status === "ready" ? thumb.thumb : null}
      controllerRef={controllerRef}
      onZoomChange={onZoomChange}
      lane="pane"
    />
  )
}

function PaneVideo({
  item,
  play,
}: {
  item: ContentItem
  play: { token: number | null; fullscreen: boolean } | null
}) {
  const thumb = useThumb(item.id)
  const host = useRef<HTMLDivElement>(null)
  const [rect, setRect] = useState({ top: 0, left: 0, width: 0, height: 0 })
  const appFullscreen = play?.fullscreen ?? false

  useLayoutEffect(() => {
    const element = host.current
    if (!element) return
    const update = (): void => {
      const bounds = element.getBoundingClientRect()
      setRect({ top: bounds.top, left: bounds.left, width: bounds.width, height: bounds.height })
    }
    const observer = new ResizeObserver(update)
    observer.observe(element)
    window.addEventListener("resize", update)
    update()
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", update)
    }
  }, [item.id])

  return (
    <>
      <div ref={host} className="h-full w-full" aria-hidden="true" />
      {createPortal(
        <div
          className="fixed bg-canvas"
          data-testid={appFullscreen ? "video-fullscreen-overlay" : undefined}
          data-entry-id={item.id}
          style={
            appFullscreen
              ? { inset: 0, zIndex: 100 }
              : {
                  top: rect.top,
                  left: rect.left,
                  width: rect.width,
                  height: rect.height,
                  zIndex: 1,
                  visibility: rect.width > 0 && rect.height > 0 ? "visible" : "hidden",
                }
          }
        >
          <VideoPlayer
            key={item.id}
            entryId={item.id}
            name={item.name}
            placeholder={thumb?.status === "ready" ? thumb.thumb : null}
            playToken={play?.token ?? null}
            playFullscreen={appFullscreen}
            appFullscreen={appFullscreen}
            onExitFullscreen={closeVideoFullscreen}
          />
        </div>,
        document.body,
      )}
    </>
  )
}

/** One line of facts under the preview: dimensions, duration, size, type. */
function PaneDetails({ item }: { item: ContentItem }) {
  const { media } = useViewerImage(item.id)
  const info = media?.status === "ready" ? media.media : null
  const parts = [
    info && info.width > 0 ? `${info.width} × ${info.height}` : null,
    info && info.durationMs > 0 ? formatTime(info.durationMs / 1000) : null,
    formatBytes(item.sizeBytes),
    item.ext.toUpperCase(),
  ].filter(Boolean)
  return (
    <div
      className="flex h-7 shrink-0 items-center truncate border-t border-border bg-chrome px-3 text-[0.6875rem] text-muted tabular-nums"
      data-testid="preview-details"
    >
      {parts.join(" · ")}
    </div>
  )
}
