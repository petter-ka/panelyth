import type { ContentItem, Thumb } from "@panelyth/contracts"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ImageViewer, type ImageViewerController } from "./ImageViewer"
import { VideoPlayer } from "./VideoPlayer"
import { requestFit, requestMedia } from "./viewerImages"

export interface MediaViewerOverlayProps {
  item: ContentItem
  onClose: () => void
  onStep?: (direction: -1 | 1) => void
  playToken?: number
  placeholder?: Thumb | null
  lane?: string
}

const zoomButton =
  "h-7 rounded-md border border-border bg-raised px-2 text-xs enabled:hover:border-muted aria-pressed:border-accent aria-pressed:text-accent"

/**
 * A reusable full-window image or video surface built from the shared media
 * components. The caller keeps its own workspace mounted underneath.
 */
export function MediaViewerOverlay({
  item,
  onClose,
  onStep,
  playToken = 1,
  placeholder = null,
  lane = "media-overlay",
}: MediaViewerOverlayProps) {
  const root = useRef<HTMLDivElement>(null)
  const imageController = useRef<ImageViewerController>(null)
  const [zoom, setZoom] = useState({ value: 1, fit: true })
  const onZoomChange = useCallback((value: number, fit: boolean) => setZoom({ value, fit }), [])
  const isImage = item.kind === "image"

  useEffect(() => {
    root.current?.focus()
    void requestMedia(item.id)
    void requestFit([{ id: item.id, priority: 0 }], [], lane).catch(() => undefined)
  }, [item.id, lane])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault()
      event.stopPropagation()
      onClose()
      return
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === "ArrowLeft" && onStep) {
      event.preventDefault()
      event.stopPropagation()
      onStep(-1)
    } else if (event.key === "ArrowRight" && onStep) {
      event.preventDefault()
      event.stopPropagation()
      onStep(1)
    } else if (isImage) {
      const actions: Record<string, (() => void) | undefined> = {
        "+": imageController.current?.zoomIn,
        "=": imageController.current?.zoomIn,
        "-": imageController.current?.zoomOut,
        "0": imageController.current?.fit,
        "1": imageController.current?.actualSize,
      }
      const action = actions[event.key]
      if (!action) return
      event.preventDefault()
      event.stopPropagation()
      action()
    }
  }

  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={`Media viewer: ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-[100] flex flex-col bg-canvas text-text outline-none"
      data-testid="media-viewer"
      data-entry-id={item.id}
    >
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3">
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          aria-label="Previous media"
          disabled={!onStep}
          onClick={() => onStep?.(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          aria-label="Next media"
          disabled={!onStep}
          onClick={() => onStep?.(1)}
        >
          ›
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span>
        {isImage && (
          <div role="toolbar" aria-label="Zoom" className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={zoomButton}
              aria-pressed={zoom.fit}
              onClick={() => imageController.current?.fit()}
            >
              Fit
            </button>
            <button
              type="button"
              className={zoomButton}
              onClick={() => imageController.current?.actualSize()}
            >
              1:1
            </button>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-text hover:bg-raised"
              aria-label="Zoom out"
              onClick={() => imageController.current?.zoomOut()}
            >
              −
            </button>
            <span className="w-10 text-center text-[0.6875rem] tabular-nums">
              {Math.round(zoom.value * 100)}%
            </span>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-text hover:bg-raised"
              aria-label="Zoom in"
              onClick={() => imageController.current?.zoomIn()}
            >
              +
            </button>
          </div>
        )}
        <button
          type="button"
          className="h-7 rounded-md border border-border bg-raised px-2.5 text-xs hover:border-muted"
          aria-label="Close media viewer"
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <main className="min-h-0 flex-1 bg-canvas">
        {isImage ? (
          <ImageViewer
            key={item.id}
            entryId={item.id}
            placeholder={placeholder}
            controllerRef={imageController}
            onZoomChange={onZoomChange}
            lane={lane}
          />
        ) : item.kind === "video" ? (
          <VideoPlayer
            key={item.id}
            entryId={item.id}
            name={item.name}
            placeholder={placeholder}
            playToken={playToken}
            playFullscreen
            appFullscreen
            onExitFullscreen={onClose}
            lane={lane}
          />
        ) : null}
      </main>
    </div>
  )
}
