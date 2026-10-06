import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { useFolderStore } from "../../features/folder/folderStore"
import { useSettingsStore } from "../../features/settings/settingsStore"
import { useThumb } from "../../features/previews/thumbStore"
import { eventChord, type ActionId } from "../../features/shortcuts/keymap"
import { actionFor, useShortcutHint } from "../../features/shortcuts/shortcutStore"
import {
  flipHorizontal,
  IDENTITY,
  ImageViewer,
  type ImageViewerController,
  rotateBy,
  type ViewTransform,
} from "../../features/media/mediaUi"
import { closeViewer, jump, step, useViewerStore } from "../../features/viewer/viewerStore"
import { formatCount } from "../../lib/format"
import { bridge } from "../../bridge"
import { copyEntryPath, copyImage } from "../../features/clipboard/clipboard"
import { CopyIcon, FlipIcon, RotateCcwIcon, RotateCwIcon } from "../ui/icons"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/menu"

const button =
  "h-7 rounded-md border border-border bg-raised px-2.5 text-xs enabled:hover:border-muted disabled:text-muted aria-pressed:border-accent aria-pressed:text-accent"
const iconButton = `${button} grid w-7 place-items-center px-0`

const hint = (text: string, key: string | undefined): string => (key ? `${text} (${key})` : text)

/**
 * The focused image viewer (Stage 04): a full-window overlay opened from an
 * image tile. Arrow keys step through the folder's images; Esc returns to
 * the tile view with the last image selected. Keys come from the viewer
 * scope of the keymap. Rotate and flip are display-only and reset when
 * another image is shown (Stage 08).
 */
export function ViewerOverlay() {
  const open = useViewerStore((s) => s.open)
  const index = useViewerStore((s) => s.index)
  const item = useViewerStore((s) => s.item)
  const total = useFolderStore((s) => s.query?.total ?? 0)
  const wheelMode = useSettingsStore((s) => s.preferences.wheelMode)
  const thumb = useThumb(item?.id ?? -1)
  const controller = useRef<ImageViewerController>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState({ value: 1, fit: true })
  const onZoomChange = useCallback((value: number, fit: boolean) => setZoom({ value, fit }), [])
  const onWheelNavigate = useCallback((direction: -1 | 1) => void step(direction), [])
  const [view, setView] = useState<{ id: number; t: ViewTransform }>({ id: -1, t: IDENTITY })
  const hints = {
    close: useShortcutHint("viewer.close"),
    next: useShortcutHint("viewer.next"),
    previous: useShortcutHint("viewer.previous"),
    fit: useShortcutHint("viewer.fit"),
    actual: useShortcutHint("viewer.actualSize"),
    zoomIn: useShortcutHint("viewer.zoomIn"),
    zoomOut: useShortcutHint("viewer.zoomOut"),
    rotateCw: useShortcutHint("viewer.rotateCw"),
    rotateCcw: useShortcutHint("viewer.rotateCcw"),
    flip: useShortcutHint("viewer.flip"),
    copy: useShortcutHint("viewer.copy"),
  }

  useEffect(() => {
    if (open) rootRef.current?.focus()
  }, [open])

  if (!open || !item) return null

  const transform = view.id === item.id ? view.t : IDENTITY
  const updateTransform = (f: (t: ViewTransform) => ViewTransform): void =>
    setView({ id: item.id, t: f(transform) })

  const close = (): void => {
    closeViewer()
    // Back to the tile view, which scrolls the last image into view.
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>('[data-testid="tile-view"]')?.focus(),
    )
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const c = controller.current
    const handlers: Partial<Record<ActionId, () => void>> = {
      "viewer.close": close,
      "viewer.next": () => void step(1),
      "viewer.previous": () => void step(-1),
      "viewer.first": () => void jump("first"),
      "viewer.last": () => void jump("last"),
      "viewer.zoomIn": () => c?.zoomIn(),
      "viewer.zoomOut": () => c?.zoomOut(),
      "viewer.fit": () => c?.fit(),
      "viewer.actualSize": () => c?.actualSize(),
      "viewer.rotateCw": () => updateTransform((t) => rotateBy(t, 1)),
      "viewer.rotateCcw": () => updateTransform((t) => rotateBy(t, -1)),
      "viewer.flip": () => updateTransform(flipHorizontal),
      "viewer.copy": () => void copyImage(item.id),
    }
    const chord = eventChord(e.nativeEvent)
    const id = chord ? actionFor("viewer", chord) : undefined
    const action = id && handlers[id]
    if (!action) return
    e.preventDefault()
    e.stopPropagation()
    action()
  }

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-label={`Image viewer: ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="fixed inset-0 z-50 flex flex-col bg-canvas outline-none"
      data-testid="viewer"
      data-entry-id={item.id}
      data-index={index}
    >
      <div
        role="toolbar"
        aria-label="Viewer toolbar"
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3"
      >
        <button
          type="button"
          className={button}
          onClick={close}
          title={hint("Back to folder", hints.close)}
        >
          ← Folder
        </button>
        <div className="flex min-w-0 flex-1 items-baseline gap-3 px-1">
          <span className="truncate text-xs font-medium" data-testid="viewer-name">
            {item.name}
          </span>
          <span className="shrink-0 text-[0.6875rem] text-muted tabular-nums">
            {formatCount(index + 1)} / {formatCount(total)}
          </span>
        </div>
        <button
          type="button"
          className={button}
          onClick={() => void step(-1)}
          title={hint("Previous image", hints.previous)}
        >
          Previous
        </button>
        <button
          type="button"
          className={button}
          onClick={() => void step(1)}
          title={hint("Next image", hints.next)}
        >
          Next
        </button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          className={button}
          aria-pressed={zoom.fit}
          onClick={() => controller.current?.fit()}
          title={hint("Fit to window", hints.fit)}
        >
          Fit
        </button>
        <button
          type="button"
          className={button}
          onClick={() => controller.current?.actualSize()}
          title={hint("Actual size", hints.actual)}
        >
          1:1
        </button>
        <button
          type="button"
          className={`${button} w-7 px-0`}
          onClick={() => controller.current?.zoomOut()}
          aria-label="Zoom out"
          title={hint("Zoom out", hints.zoomOut)}
        >
          −
        </button>
        <span
          className="w-12 text-center text-xs tabular-nums"
          data-testid="viewer-zoom"
          aria-live="polite"
        >
          {Math.round(zoom.value * 100)}%
        </span>
        <button
          type="button"
          className={`${button} w-7 px-0`}
          onClick={() => controller.current?.zoomIn()}
          aria-label="Zoom in"
          title={hint("Zoom in", hints.zoomIn)}
        >
          +
        </button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          className={iconButton}
          onClick={() => updateTransform((t) => rotateBy(t, -1))}
          aria-label="Rotate left"
          title={hint("Rotate left", hints.rotateCcw)}
        >
          <RotateCcwIcon size={14} />
        </button>
        <button
          type="button"
          className={iconButton}
          onClick={() => updateTransform((t) => rotateBy(t, 1))}
          aria-label="Rotate right"
          title={hint("Rotate right", hints.rotateCw)}
        >
          <RotateCwIcon size={14} />
        </button>
        <button
          type="button"
          className={iconButton}
          aria-pressed={transform.flipH}
          onClick={() => updateTransform(flipHorizontal)}
          aria-label="Flip horizontally"
          title={hint("Flip horizontally", hints.flip)}
        >
          <FlipIcon size={14} />
        </button>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <button
          type="button"
          className={iconButton}
          onClick={() => void copyImage(item.id)}
          aria-label="Copy picture"
          title={hint("Copy picture", hints.copy)}
        >
          <CopyIcon size={14} />
        </button>
      </div>
      <ContextMenuRoot>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1" data-testid="viewer-canvas">
            <ImageViewer
              key={item.id}
              entryId={item.id}
              placeholder={thumb?.status === "ready" ? thumb.thumb : null}
              controllerRef={controller}
              onZoomChange={onZoomChange}
              transform={transform}
              wheelMode={wheelMode}
              onWheelNavigate={onWheelNavigate}
              onDoubleClick={close}
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent
          data-testid="viewer-menu"
          // Keys go back to the viewer when the menu closes.
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            rootRef.current?.focus()
          }}
        >
          <ContextMenuItem action="viewer.copy" onSelect={() => void copyImage(item.id)}>
            Copy picture
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyEntryPath(item.id)}>Copy path</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void bridge.openWithSystem(item.id).catch(() => undefined)}
          >
            Open with default app
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void bridge.reveal(item.id).catch(() => undefined)}>
            Show in file manager
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            action="viewer.rotateCcw"
            onSelect={() => updateTransform((t) => rotateBy(t, -1))}
          >
            Rotate left
          </ContextMenuItem>
          <ContextMenuItem
            action="viewer.rotateCw"
            onSelect={() => updateTransform((t) => rotateBy(t, 1))}
          >
            Rotate right
          </ContextMenuItem>
          <ContextMenuItem action="viewer.flip" onSelect={() => updateTransform(flipHorizontal)}>
            Flip horizontally
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem action="viewer.close" onSelect={close}>
            Back to folder
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>
    </div>
  )
}
