import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
} from "react"
import { Tooltip } from "@panelyth/ui"
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
import { CopyIcon, FlipIcon, PencilIcon, RotateCcwIcon, RotateCwIcon } from "../ui/icons"
import { openEditor, useEditorStore } from "../../features/editor/editorStore"
import { toEditList } from "../../features/media/mediaUi"
import { ProgramMenuItems } from "../ProgramMenuItems"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/menu"
import { t } from "@panelyth/i18n"

const button =
  "h-7 rounded-md border border-border bg-raised px-2.5 text-xs enabled:hover:border-muted disabled:text-muted aria-pressed:border-accent aria-pressed:text-accent"
const iconButton = `${button} grid w-7 place-items-center px-0`

const hint = (text: string, key: string | undefined): string => (key ? `${text} (${key})` : text)

function HintButton({
  tooltip,
  ...props
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "title"> & { tooltip: string }) {
  return (
    <Tooltip content={tooltip}>
      <button {...props} />
    </Tooltip>
  )
}

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
  const wheelMode = useSettingsStore((s) => s.settings.wheelMode)
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
    edit: useShortcutHint("viewer.edit"),
  }
  const editing = useEditorStore((s) => s.status !== "closed")

  // Keys come back here when the editor closes over the viewer.
  useEffect(() => {
    if (open && !editing) rootRef.current?.focus()
  }, [open, editing])

  if (!open || !item) return null

  const transform = view.id === item.id ? view.t : IDENTITY
  const updateTransform = (f: (t: ViewTransform) => ViewTransform): void =>
    setView({ id: item.id, t: f(transform) })

  // The turn and flip shown here become the editor's first operations.
  const edit = (): void => void openEditor({ id: item.id, name: item.name }, toEditList(transform))

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
      "viewer.edit": edit,
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
      aria-label={t("Image viewer: {name}", { name: item.name })}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className="below-title-bar fixed z-50 flex flex-col bg-canvas outline-none"
      data-testid="viewer"
      data-entry-id={item.id}
      data-index={index}
    >
      <div
        role="toolbar"
        aria-label={t("Viewer toolbar")}
        className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3"
      >
        <HintButton
          type="button"
          className={button}
          onClick={close}
          tooltip={hint(t("Back to folder"), hints.close)}
        >
          ← Folder
        </HintButton>
        <div className="flex min-w-0 flex-1 items-baseline gap-3 px-1">
          <span className="truncate text-xs font-medium" data-testid="viewer-name">
            {item.name}
          </span>
          <span className="shrink-0 text-2xs text-muted tabular-nums">
            {formatCount(index + 1)} / {formatCount(total)}
          </span>
        </div>
        <HintButton
          type="button"
          className={button}
          onClick={() => void step(-1)}
          tooltip={hint(t("Previous image"), hints.previous)}
        >
          {t("Previous")}
        </HintButton>
        <HintButton
          type="button"
          className={button}
          onClick={() => void step(1)}
          tooltip={hint(t("Next image"), hints.next)}
        >
          {t("Next")}
        </HintButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <HintButton
          type="button"
          className={button}
          aria-pressed={zoom.fit}
          onClick={() => controller.current?.fit()}
          tooltip={hint(t("Fit to window"), hints.fit)}
        >
          {t("Fit")}
        </HintButton>
        <HintButton
          type="button"
          className={button}
          onClick={() => controller.current?.actualSize()}
          tooltip={hint(t("Actual size"), hints.actual)}
        >
          1:1
        </HintButton>
        <HintButton
          type="button"
          className={`${button} w-7 px-0`}
          onClick={() => controller.current?.zoomOut()}
          aria-label={t("Zoom out")}
          tooltip={hint(t("Zoom out"), hints.zoomOut)}
        >
          −
        </HintButton>
        <span
          className="w-12 text-center text-xs tabular-nums"
          data-testid="viewer-zoom"
          aria-live="polite"
        >
          {Math.round(zoom.value * 100)}%
        </span>
        <HintButton
          type="button"
          className={`${button} w-7 px-0`}
          onClick={() => controller.current?.zoomIn()}
          aria-label={t("Zoom in")}
          tooltip={hint(t("Zoom in"), hints.zoomIn)}
        >
          +
        </HintButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <HintButton
          type="button"
          className={iconButton}
          onClick={() => updateTransform((t) => rotateBy(t, -1))}
          aria-label={t("Rotate left")}
          tooltip={hint(t("Rotate left"), hints.rotateCcw)}
        >
          <RotateCcwIcon size={14} />
        </HintButton>
        <HintButton
          type="button"
          className={iconButton}
          onClick={() => updateTransform((t) => rotateBy(t, 1))}
          aria-label={t("Rotate right")}
          tooltip={hint(t("Rotate right"), hints.rotateCw)}
        >
          <RotateCwIcon size={14} />
        </HintButton>
        <HintButton
          type="button"
          className={iconButton}
          aria-pressed={transform.flipH}
          onClick={() => updateTransform(flipHorizontal)}
          aria-label={t("Flip horizontally")}
          tooltip={hint(t("Flip horizontally"), hints.flip)}
        >
          <FlipIcon size={14} />
        </HintButton>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <HintButton
          type="button"
          className={iconButton}
          onClick={() => void copyImage(item.id)}
          aria-label={t("Copy picture")}
          tooltip={hint(t("Copy picture"), hints.copy)}
        >
          <CopyIcon size={14} />
        </HintButton>
        <HintButton
          type="button"
          className={`${button} flex items-center gap-1.5`}
          onClick={edit}
          tooltip={hint(t("Edit picture"), hints.edit)}
          data-testid="viewer-edit"
        >
          <PencilIcon size={14} />
          {t("Edit")}
        </HintButton>
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
            {t("Copy picture")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => void copyEntryPath(item.id)}>
            {t("Copy path")}
          </ContextMenuItem>
          <ContextMenuItem action="viewer.edit" onSelect={edit}>
            {t("Edit…")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() => void bridge.openWithSystem(item.id).catch(() => undefined)}
          >
            {t("Open with default app")}
          </ContextMenuItem>
          <ProgramMenuItems target={{ entryId: item.id, folder: false }} />
          <ContextMenuItem onSelect={() => void bridge.reveal(item.id).catch(() => undefined)}>
            {t("Show in file manager")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            action="viewer.rotateCcw"
            onSelect={() => updateTransform((t) => rotateBy(t, -1))}
          >
            {t("Rotate left")}
          </ContextMenuItem>
          <ContextMenuItem
            action="viewer.rotateCw"
            onSelect={() => updateTransform((t) => rotateBy(t, 1))}
          >
            {t("Rotate right")}
          </ContextMenuItem>
          <ContextMenuItem action="viewer.flip" onSelect={() => updateTransform(flipHorizontal)}>
            {t("Flip horizontally")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem action="viewer.close" onSelect={close}>
            {t("Back to folder")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenuRoot>
    </div>
  )
}
