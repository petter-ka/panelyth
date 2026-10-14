import type { ContentItem, Thumb } from "@panelyth/contracts"
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { ImageViewer, type ImageViewerController } from "./ImageViewer"
import { VideoPlayer } from "./VideoPlayer"
import { useIdle } from "./useIdle"
import { useVideoPrefs } from "./video"
import { requestFit, requestMedia } from "./viewerImages"
import { t } from "@panelyth/i18n"
import { wheelNavigationStep } from "./wheelNavigation"

export interface MediaViewerOverlayProps {
  item: ContentItem
  onClose: () => void
  onStep?: (direction: -1 | 1) => void
  playToken?: number
  placeholder?: Thumb | null
  lane?: string
  /** "previousNext": the wheel steps through the files (Ctrl + wheel zooms); default zooms. */
  wheelMode?: "zoom" | "previousNext"
  /** Double-click on the picture or video closes the surface (the media window). */
  closeOnDoubleClick?: boolean
  /** Shows an Edit button for pictures (the commander hands the picture to the viewer's editor; Stage 12). */
  onEdit?: () => void
  /**
   * The surface stands alone (a file opened from the OS): a button, and a
   * double-click on the picture or video, take it into the app at its folder.
   */
  onShowInApp?: () => void
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
  wheelMode = "zoom",
  closeOnDoubleClick = false,
  onEdit,
  onShowInApp,
}: MediaViewerOverlayProps) {
  const onDoubleClick = onShowInApp ?? (closeOnDoubleClick ? onClose : undefined)
  const root = useRef<HTMLDivElement>(null)
  const imageController = useRef<ImageViewerController>(null)
  const [zoom, setZoom] = useState({ value: 1, fit: true })
  const onZoomChange = useCallback((value: number, fit: boolean) => setZoom({ value, fit }), [])
  const isImage = item.kind === "image"
  const isVideo = item.kind === "video"
  // A playing video with the mouse at rest: the header goes with the player's controls.
  const [chromeHidden, setChromeHidden] = useState(false)
  // A picture with the mouse at rest: the header (and the cursor) hide on their own.
  // Settings → Appearance → Full screen can keep either shown.
  const autoHideImage = useVideoPrefs((s) => s.autoHideImage)
  const overHeader = useRef(false)
  const imageIdle = useIdle(isImage && autoHideImage, overHeader)
  const headerHidden = isVideo ? chromeHidden : imageIdle
  const main = useRef<HTMLElement>(null)
  const wheelRef = useRef({ wheelMode, onStep })
  useEffect(() => {
    wheelRef.current = { wheelMode, onStep }
  }, [wheelMode, onStep])

  // The image viewer handles its own wheel (zoom or step, by the setting). A
  // video has nothing to zoom, so with "previous / next" the wheel steps
  // through the files over it too (Ctrl + wheel is left alone).
  useEffect(() => {
    const el = main.current
    if (!el || isImage) return
    const onWheel = (e: WheelEvent): void => {
      const { wheelMode: mode, onStep: step } = wheelRef.current
      if (mode !== "previousNext" || !step || e.ctrlKey || e.metaKey || e.deltaY === 0) return
      if (e.target instanceof Element && e.target.closest("input, [role=slider]")) return
      e.preventDefault()
      const direction = wheelNavigationStep(e)
      if (direction !== 0) step(direction > 0 ? 1 : -1)
    }
    el.addEventListener("wheel", onWheel, { passive: false })
    return () => el.removeEventListener("wheel", onWheel)
  }, [isImage])

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
      aria-label={t("Media viewer: {name}", { name: item.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`fixed inset-0 z-[100] flex flex-col bg-canvas text-text outline-none ${isImage && imageIdle ? "cursor-none" : ""}`}
      data-testid="media-viewer"
      data-entry-id={item.id}
    >
      <header
        data-hidden={headerHidden || undefined}
        onPointerEnter={() => (overHeader.current = true)}
        onPointerLeave={() => (overHeader.current = false)}
        // It floats over the picture or video, so neither changes size when it hides.
        className={`absolute inset-x-0 top-0 z-20 flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome/80 px-3 backdrop-blur-md transition-opacity duration-200 motion-reduce:transition-none ${headerHidden ? "pointer-events-none opacity-0" : "opacity-100"}`}
      >
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          aria-label={t("Previous media")}
          disabled={!onStep}
          onClick={() => onStep?.(-1)}
        >
          ‹
        </button>
        <button
          type="button"
          className="grid size-7 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-40"
          aria-label={t("Next media")}
          disabled={!onStep}
          onClick={() => onStep?.(1)}
        >
          ›
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium">{item.name}</span>
        {isImage && (
          <div role="toolbar" aria-label={t("Zoom")} className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={zoomButton}
              aria-pressed={zoom.fit}
              onClick={() => imageController.current?.fit()}
            >
              {t("Fit")}
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
              aria-label={t("Zoom out")}
              onClick={() => imageController.current?.zoomOut()}
            >
              −
            </button>
            <span className="w-10 text-center text-2xs tabular-nums">
              {Math.round(zoom.value * 100)}%
            </span>
            <button
              type="button"
              className="grid size-7 place-items-center rounded-md text-text hover:bg-raised"
              aria-label={t("Zoom in")}
              onClick={() => imageController.current?.zoomIn()}
            >
              +
            </button>
          </div>
        )}
        {isImage && onEdit && (
          <button type="button" className={zoomButton} onClick={onEdit} data-testid="media-edit">
            {t("Edit")}
          </button>
        )}
        {onShowInApp && (
          <button
            type="button"
            className={zoomButton}
            onClick={onShowInApp}
            title={t("Opens the folder with this file selected (double-click)")}
            data-testid="media-show-in-app"
          >
            {t("Open in Panelyth")}
          </button>
        )}
        <button
          type="button"
          className="h-7 rounded-md border border-border bg-raised px-2.5 text-xs hover:border-muted"
          aria-label={t("Close media viewer")}
          onClick={onClose}
        >
          Close
        </button>
      </header>
      <main ref={main} className="min-h-0 flex-1 bg-canvas">
        {isImage ? (
          <ImageViewer
            key={item.id}
            entryId={item.id}
            placeholder={placeholder}
            controllerRef={imageController}
            onZoomChange={onZoomChange}
            lane={lane}
            wheelMode={wheelMode}
            {...(onStep && { onWheelNavigate: onStep })}
            {...(onDoubleClick && { onDoubleClick })}
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
            onIdleChange={setChromeHidden}
            chromeHover={overHeader}
            {...(onDoubleClick && { onDoubleClick })}
          />
        ) : null}
      </main>
    </div>
  )
}
