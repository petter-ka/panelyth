// The image editor's shell (Stage 12, docs/viewer/IMAGE-EDITOR.md §5): a
// full-window mode of the viewer with a top bar, a tool rail, the canvas, the
// edit stack and a right panel. It mounts only while a picture is being
// edited and never holds the folder's file list. The rail shows the tool
// groups (Stage 13); the panel lists the group's tools. Later stages add
// tools to the registry and panels; the shell stays as it is.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react"
import { isBatchOp } from "@panelyth/contracts"
import { Tooltip } from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import { openBatchDialog, runBatch, useBatchStore } from "../../features/editor/batchStore"
import { CROP_RATIOS, ratioValue } from "../../features/editor/crop"
import { useEditorSettings } from "../../features/editor/editorSettings"
import {
  applyCrop,
  cancelCrop,
  cancelPick,
  isDirty,
  moveOp,
  openGroup,
  openTool,
  redo,
  removeOp,
  requestClose,
  resetAll,
  save,
  setCompare,
  setStraighten,
  toggleOp,
  undo,
  useEditorStore,
  type EditItem,
} from "../../features/editor/editorStore"
import {
  describeOp,
  searchTools,
  TOOL_GROUPS,
  toolDef,
  type ToolGroup,
  type ToolId,
} from "../../features/editor/tools"
import { useSettingsStore } from "../../features/settings/settingsStore"
import { chordAllowedWhileTyping, eventChord, type ActionId } from "../../features/shortcuts/keymap"
import { actionFor, useShortcutHint } from "../../features/shortcuts/shortcutStore"
import { formatCount } from "../../lib/format"
import { CloseIcon, SearchIcon } from "../ui/icons"
import { BatchClosePrompt, BatchControls, BatchStrip } from "./BatchControls"
import { EditorCanvas, type CanvasController } from "./EditorCanvas"
import { Histogram } from "./Histogram"
import { InfoTabs } from "./InfoTabs"
import { SaveControls, UnsavedPrompt } from "./SaveControls"
import { ToolIcon } from "./ToolIcon"
import { ToolList } from "./ToolList"
import type { CropGuide } from "./ToolPanels"

const button =
  "h-7 rounded-md border border-border bg-raised px-2.5 text-xs enabled:hover:border-muted disabled:text-muted disabled:opacity-60 aria-pressed:border-accent aria-pressed:text-accent"
const iconButton = `${button} grid w-7 place-items-center px-0`

const hint = (text: string, key: string | undefined): string => (key ? `${text} (${key})` : text)

/** A group of the rail. One tab stop: the group that is shown; the arrows reach the others. */
function GroupButton({
  id,
  label,
  onPick,
  buttonRef,
}: {
  id: ToolGroup
  label: string
  onPick(): void
  buttonRef(el: HTMLButtonElement | null): void
}) {
  const active = useEditorStore((s) => s.group === id)
  const ready = useEditorStore((s) => s.status === "ready")
  const shortcut = useShortcutHint(`editor.group.${id}`)
  return (
    <Tooltip content={hint(t(label), shortcut)} side="right">
      <button
        ref={buttonRef}
        type="button"
        aria-label={t(label)}
        aria-pressed={active}
        tabIndex={active ? 0 : -1}
        disabled={!ready}
        data-group={id}
        onClick={onPick}
        className="grid size-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-50 aria-pressed:bg-raised aria-pressed:text-accent"
      >
        <ToolIcon id={id} />
      </button>
    </Tooltip>
  )
}

/**
 * The tool rail: the tool groups as a vertical toolbar with roving focus,
 * and the tool search. A group's tools are listed in the panel.
 */
function ToolRail({
  searchOpen,
  onSearch,
  onGroup,
  activeRef,
}: {
  searchOpen: boolean
  onSearch(open: boolean): void
  /** A group was chosen: the panel has to be visible to show its tools. */
  onGroup(): void
  /** The button of the group that is shown, for the focus when the editor opens. */
  activeRef: React.RefObject<HTMLButtonElement | null>
}) {
  const group = useEditorStore((s) => s.group)
  const ready = useEditorStore((s) => s.status === "ready")
  const batch = useEditorStore((s) => s.batch)
  const [query, setQuery] = useState("")
  const searchHint = useShortcutHint("editor.search")
  // A recipe holds no free-hand tool: the search does not offer them.
  const results = searchOpen
    ? searchTools(query).filter((r) => !batch || r.id === "looks" || isBatchOp(r.id))
    : []
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  const count = TOOL_GROUPS.length

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    const at = refs.current.indexOf(document.activeElement as HTMLButtonElement)
    const step = e.key === "ArrowDown" ? 1 : e.key === "ArrowUp" ? -1 : 0
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? count - 1
          : step !== 0 && at >= 0
            ? (at + step + count) % count
            : -1
    if (next < 0) return
    e.preventDefault()
    e.stopPropagation()
    refs.current[next]?.focus()
  }
  const pick = (id: ToolId): void => {
    onGroup()
    onSearch(false)
    setQuery("")
    openTool(id)
    // The search field is gone: the focus goes to the tool it found, once
    // the panel shows it, so the keyboard stays in the editor.
    setTimeout(() => document.querySelector<HTMLElement>(`button[data-tool="${id}"]`)?.focus(), 0)
  }

  return (
    <nav
      aria-label={t("Editing tools")}
      className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-chrome py-2"
      data-testid="tool-rail"
    >
      <Tooltip content={hint(t("Find a tool"), searchHint)}>
        <button
          type="button"
          aria-label={t("Find a tool")}
          aria-expanded={searchOpen}
          disabled={!ready}
          onClick={() => onSearch(!searchOpen)}
          className="grid size-8 place-items-center rounded-md text-muted hover:bg-raised hover:text-text disabled:opacity-50"
        >
          <SearchIcon size={14} />
        </button>
      </Tooltip>
      {searchOpen && (
        <div
          role="dialog"
          aria-label={t("Find a tool")}
          className="motion-pop absolute top-12 left-14 z-10 w-56 rounded-md border border-border bg-raised p-1.5 shadow-lg shadow-black/30"
          data-testid="tool-search"
          data-state="open"
        >
          <input
            autoFocus
            type="search"
            value={query}
            placeholder={t("Find a tool")}
            aria-label={t("Find a tool")}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault()
                e.stopPropagation()
                onSearch(false)
                setQuery("")
              } else if (e.key === "Enter" && results[0]) {
                e.preventDefault()
                pick(results[0].id)
              }
            }}
            className="mb-1 h-7 w-full rounded border border-border bg-canvas px-2 text-xs outline-none focus:border-accent"
          />
          <ul role="listbox" aria-label={t("Tools")}>
            {results.map((r, i) => (
              <li key={r.id} role="option" aria-selected={i === 0}>
                <button
                  type="button"
                  onClick={() => pick(r.id)}
                  className={`flex h-7 w-full items-center gap-2 rounded px-2 text-left text-xs hover:bg-accent hover:text-accent-foreground ${i === 0 ? "bg-canvas" : ""}`}
                >
                  <ToolIcon id={r.id} />
                  {t(r.label)}
                </button>
              </li>
            ))}
            {results.length === 0 && (
              <li className="px-2 py-1 text-[0.6875rem] text-muted">{t("No tool matches")}</li>
            )}
          </ul>
        </div>
      )}
      <div
        role="toolbar"
        aria-orientation="vertical"
        aria-label={t("Tool groups")}
        className="flex flex-col gap-1"
        onKeyDown={onKeyDown}
      >
        {TOOL_GROUPS.map((g, index) => (
          <GroupButton
            key={g.id}
            id={g.id}
            label={g.label}
            buttonRef={(el) => {
              refs.current[index] = el
              if (g.id === group) activeRef.current = el
            }}
            onPick={() => {
              onGroup()
              openGroup(g.id)
            }}
          />
        ))}
      </div>
    </nav>
  )
}

function StackChip({ item, index, count }: { item: EditItem; index: number; count: number }) {
  const active = useEditorStore((s) => s.activeId === item.id || s.crop?.editing === item.id)
  const off = item.op.off === true
  const label = t(toolDef(item.op.op).label)
  const small =
    "grid size-5 place-items-center rounded text-muted hover:bg-canvas hover:text-text disabled:opacity-30"
  return (
    <li
      className={`flex h-7 shrink-0 items-center gap-0.5 rounded-md border px-1 text-xs ${active ? "border-accent" : "border-border"} ${off ? "opacity-55" : ""}`}
      data-testid="stack-item"
      data-op={item.op.op}
    >
      <Tooltip content={off ? t("Switched off") : t("Switched on")}>
        <button
          type="button"
          role="switch"
          aria-checked={!off}
          aria-label={t("Apply {name}", { name: label })}
          onClick={() => toggleOp(item.id)}
          className={small}
        >
          <span
            aria-hidden="true"
            className={`size-2 rounded-full border border-current ${off ? "" : "bg-current"}`}
          />
        </button>
      </Tooltip>
      <Tooltip content={t("Change {name}", { name: label })}>
        <button
          type="button"
          onClick={() => openTool(item.op.op, item.id)}
          className="flex items-baseline gap-1.5 px-1 hover:underline"
        >
          <span>{label}</span>
          <span className="text-[0.6875rem] text-muted tabular-nums">{describeOp(item.op)}</span>
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label={t("Move {name} earlier", { name: label })}
        disabled={index === 0}
        onClick={() => moveOp(item.id, index - 1)}
        className={small}
      >
        ‹
      </button>
      <button
        type="button"
        aria-label={t("Move {name} later", { name: label })}
        disabled={index === count - 1}
        onClick={() => moveOp(item.id, index + 1)}
        className={small}
      >
        ›
      </button>
      <button
        type="button"
        aria-label={t("Remove {name}", { name: label })}
        onClick={() => removeOp(item.id)}
        className={small}
      >
        <CloseIcon size={10} />
      </button>
    </li>
  )
}

/** The operations in order: what was done, and what a recipe will be. */
function EditStack() {
  const items = useEditorStore((s) => s.items)
  const batch = useEditorStore((s) => s.batch)
  return (
    <section
      aria-label={batch ? t("Recipe") : t("Edits")}
      className="flex h-11 shrink-0 items-center gap-2 border-t border-border bg-chrome px-3"
      data-testid="edit-stack"
    >
      {items.length === 0 ? (
        <p className="text-[0.6875rem] text-muted">
          {batch
            ? t("No steps yet. Pick a tool to build the recipe, or use one under Recipes.")
            : t("No edits yet. Pick a tool to begin.")}
        </p>
      ) : (
        <>
          <ol className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
            {items.map((item, i) => (
              <StackChip key={item.id} item={item} index={i} count={items.length} />
            ))}
          </ol>
          <button type="button" className={`${button} shrink-0`} onClick={resetAll}>
            {t("Reset all")}
          </button>
        </>
      )}
    </section>
  )
}

/**
 * The editor. Rendered always; it draws nothing while closed. Keys come from
 * the keymap's editor scope; while a text field has the focus only chords
 * with a modifier fire, so typing a number never triggers a tool.
 */
export function EditorOverlay() {
  const status = useEditorStore((s) => s.status)
  const batch = useEditorStore((s) => s.batch)
  const batchCount = useBatchStore((s) => s.plan?.count ?? s.selected)
  const entry = useEditorStore((s) => s.entry)
  const session = useEditorStore((s) => s.session)
  const output = useEditorStore((s) => s.output)
  const error = useEditorStore((s) => s.error)
  const renderError = useEditorStore((s) => s.renderError)
  const busy = useEditorStore((s) => s.busy)
  const dirty = useEditorStore(isDirty)
  const canUndo = useEditorStore((s) => s.past.length > 0)
  const canRedo = useEditorStore((s) => s.future.length > 0)
  const compare = useEditorStore((s) => s.compare)
  const panelOpen = useEditorSettings((s) => s.settings.panel)
  const setSetting = useEditorSettings((s) => s.set)
  const remind = useSettingsStore((s) => s.settings.remindSaveChanges)
  const controller = useRef<CanvasController>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const activeGroup = useRef<HTMLButtonElement | null>(null)
  const [zoom, setZoom] = useState({ value: 1, fit: true })
  const onZoomChange = useCallback((value: number, fit: boolean) => setZoom({ value, fit }), [])
  const [searchOpen, setSearchOpen] = useState(false)
  const [ratioId, setRatioId] = useState("free")
  const [guide, setGuide] = useState<CropGuide>("thirds")
  const hints = {
    close: useShortcutHint("editor.close"),
    undo: useShortcutHint("editor.undo"),
    redo: useShortcutHint("editor.redo"),
    compare: useShortcutHint("editor.compare"),
    fit: useShortcutHint("editor.fit"),
    actual: useShortcutHint("editor.actualSize"),
    zoomIn: useShortcutHint("editor.zoomIn"),
    zoomOut: useShortcutHint("editor.zoomOut"),
  }
  const open = status !== "closed"

  // Focus moves to the tool rail once the picture can be edited, and to the
  // shell before that, so Esc works at once.
  useEffect(() => {
    // A control of the editor that has the focus keeps it: stepping through
    // the samples of a batch opens picture after picture.
    const root = rootRef.current
    const at = document.activeElement
    if (root && at && at !== root && root.contains(at)) return
    if (status === "ready") activeGroup.current?.focus()
    else if (open) rootRef.current?.focus()
  }, [status, open])

  // The editor covers the window: what lies behind it does not take the
  // focus (a menu that opened the editor hands it back to its tile when it
  // closes). Menus and dialogs of the editor are drawn beside the app, not
  // behind the editor, and keep theirs.
  useEffect(() => {
    if (!open) return
    const onFocusIn = (e: FocusEvent): void => {
      const root = rootRef.current
      const behind = root?.parentElement
      if (!root || !behind || !(e.target instanceof Node)) return
      if (root.contains(e.target) || !behind.contains(e.target)) return
      ;(activeGroup.current ?? root).focus()
    }
    // A focused control can go away without a trace (a button that is
    // disabled while a save runs, a panel that closed): the focus is then on
    // the page itself. The key is still the editor's.
    const onKeyDown = (e: globalThis.KeyboardEvent): void => {
      const root = rootRef.current
      if (!root || e.target !== document.body || e.defaultPrevented) return
      root.focus()
      const again = new KeyboardEvent("keydown", {
        key: e.key,
        code: e.code,
        ctrlKey: e.ctrlKey,
        metaKey: e.metaKey,
        shiftKey: e.shiftKey,
        altKey: e.altKey,
        repeat: e.repeat,
        bubbles: true,
        cancelable: true,
      })
      if (!root.dispatchEvent(again)) e.preventDefault()
    }
    document.addEventListener("focusin", onFocusIn)
    document.addEventListener("keydown", onKeyDown)
    return () => {
      document.removeEventListener("focusin", onFocusIn)
      document.removeEventListener("keydown", onKeyDown)
    }
  }, [open])

  // A key released outside the editor still ends the peek at the original.
  useEffect(() => {
    if (!compare) return
    const off = (): void => setCompare(false)
    window.addEventListener("blur", off)
    return () => window.removeEventListener("blur", off)
  }, [compare])

  if (!open || !entry) return null

  const size = output ?? (session ? { width: session.width, height: session.height } : null)
  const choice = CROP_RATIOS.find((r) => r.id === ratioId)
  const ratio = choice && size ? ratioValue(choice, { w: size.width, h: size.height }) : null
  const close = (): void => requestClose(remind)

  // A field that takes typed text; a slider, a checkbox or a color well does not.
  const typing = (target: EventTarget): boolean =>
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target.matches(
        "input:not([type=range]):not([type=checkbox]):not([type=color]), textarea, select",
      ))

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.defaultPrevented) return
    const s = useEditorStore.getState()
    // Enter applies a crop from anywhere but a text field (which takes its value first).
    if (
      e.key === "Enter" &&
      s.crop &&
      !typing(e.target) &&
      !(e.target instanceof HTMLButtonElement)
    ) {
      e.preventDefault()
      applyCrop()
      return
    }
    const chord = eventChord(e.nativeEvent)
    if (!chord) return
    if (typing(e.target) && !chordAllowedWhileTyping(chord)) {
      // Esc in a field still leaves the editor's current mode.
      if (e.key !== "Escape") return
    }
    const id = actionFor("editor", chord)
    if (!id) return
    // A group's key shows its tools and puts the focus on the group.
    const showGroup = (g: ToolGroup) => (): void => {
      if (!panelOpen) setSetting("panel", true)
      openGroup(g)
      rootRef.current?.querySelector<HTMLElement>(`button[data-group="${g}"]`)?.focus()
    }
    const handlers: Partial<Record<ActionId, () => void>> = {
      "editor.group.adjust": showGroup("adjust"),
      "editor.group.color": showGroup("color"),
      "editor.group.detail": showGroup("detail"),
      "editor.group.effects": showGroup("effects"),
      "editor.group.retouch": showGroup("retouch"),
      "editor.group.geometry": showGroup("geometry"),
      "editor.group.looks": showGroup("looks"),
      "editor.close": () => {
        if (searchOpen) setSearchOpen(false)
        else if (s.picker) cancelPick()
        else if (s.straighten) setStraighten(false)
        else if (s.crop) cancelCrop()
        else close()
      },
      "editor.undo": undo,
      "editor.redo": redo,
      "editor.compare": () => setCompare(true),
      "editor.run": () => {
        if (s.batch) void runBatch()
      },
      "editor.save": () => {
        // A recipe is saved under Recipes; nothing is written from here.
        if (s.batch) {
          openBatchDialog("recipes")
          return
        }
        const preferred = useEditorSettings.getState().settings.saveTarget
        // The shortcut never replaces the original: that has its own confirmation.
        void save(preferred === "replace" ? "copy" : preferred)
      },
      "editor.search": () => setSearchOpen(true),
      "editor.fit": () => controller.current?.fit(),
      "editor.actualSize": () => controller.current?.actualSize(),
      "editor.zoomIn": () => controller.current?.zoomIn(),
      "editor.zoomOut": () => controller.current?.zoomOut(),
    }
    const action = handlers[id]
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
      aria-label={
        batch
          ? t("Batch editor: {count, plural, one {# picture} other {# pictures}}", {
              count: batchCount,
            })
          : t("Image editor: {name}", { name: entry.name })
      }
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onKeyUp={(e) => {
        if (useEditorStore.getState().compare && !e.ctrlKey && !e.metaKey) setCompare(false)
      }}
      className="fixed inset-0 z-50 flex flex-col bg-canvas text-text outline-none"
      data-testid="editor"
      data-status={status}
      data-entry-id={entry.id}
      data-batch={batch || undefined}
    >
      <div
        role="toolbar"
        aria-label={t("Editor toolbar")}
        className="relative flex h-11 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3"
      >
        <Tooltip content={hint(t("Close the editor"), hints.close)}>
          <button type="button" className={button} onClick={close} data-testid="editor-close">
            ← {t("Back")}
          </button>
        </Tooltip>
        <div className="flex min-w-0 flex-1 items-baseline gap-3 px-1">
          {batch && (
            <span className="shrink-0 text-xs font-medium" data-testid="batch-title">
              {t("Edit {count, plural, one {# picture} other {# pictures}}", {
                count: batchCount,
              })}
            </span>
          )}
          <span
            className={`truncate text-xs ${batch ? "text-muted" : "font-medium"}`}
            data-testid="editor-name"
          >
            {entry.name}
          </span>
          {size && (
            <span
              className="shrink-0 text-[0.6875rem] text-muted tabular-nums"
              data-testid="editor-size"
            >
              {formatCount(size.width)} × {formatCount(size.height)}
            </span>
          )}
          {dirty && !batch && (
            <span className="shrink-0 text-[0.6875rem] text-warning" data-testid="editor-unsaved">
              ● {t("unsaved")}
            </span>
          )}
        </div>
        <Tooltip content={hint(t("Undo"), hints.undo)}>
          <button
            type="button"
            className={iconButton}
            aria-label={t("Undo")}
            disabled={!canUndo}
            onClick={undo}
          >
            ↶
          </button>
        </Tooltip>
        <Tooltip content={hint(t("Redo"), hints.redo)}>
          <button
            type="button"
            className={iconButton}
            aria-label={t("Redo")}
            disabled={!canRedo}
            onClick={redo}
          >
            ↷
          </button>
        </Tooltip>
        <Tooltip content={hint(t("Show the original while held"), hints.compare)}>
          <button
            type="button"
            className={button}
            aria-pressed={compare}
            disabled={status !== "ready"}
            onPointerDown={() => setCompare(true)}
            onPointerUp={() => setCompare(false)}
            onPointerLeave={() => setCompare(false)}
            onKeyDown={(e) => {
              if (e.key === " " || e.key === "Enter") {
                e.preventDefault()
                e.stopPropagation()
                setCompare(true)
              }
            }}
            data-testid="editor-compare"
          >
            {t("Before")}
          </button>
        </Tooltip>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        <Tooltip content={hint(t("Fit to window"), hints.fit)}>
          <button
            type="button"
            className={button}
            aria-pressed={zoom.fit}
            onClick={() => controller.current?.fit()}
          >
            {t("Fit")}
          </button>
        </Tooltip>
        <Tooltip content={hint(t("Actual size"), hints.actual)}>
          <button type="button" className={button} onClick={() => controller.current?.actualSize()}>
            1:1
          </button>
        </Tooltip>
        <Tooltip content={hint(t("Zoom out"), hints.zoomOut)}>
          <button
            type="button"
            className={iconButton}
            aria-label={t("Zoom out")}
            onClick={() => controller.current?.zoomOut()}
          >
            −
          </button>
        </Tooltip>
        <span
          className="w-12 text-center text-xs tabular-nums"
          data-testid="editor-zoom"
          aria-live="polite"
        >
          {Math.round(zoom.value * 100)}%
        </span>
        <Tooltip content={hint(t("Zoom in"), hints.zoomIn)}>
          <button
            type="button"
            className={iconButton}
            aria-label={t("Zoom in")}
            onClick={() => controller.current?.zoomIn()}
          >
            +
          </button>
        </Tooltip>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden="true" />
        {batch ? <BatchControls /> : <SaveControls />}
        <Tooltip content={panelOpen ? t("Hide the panel") : t("Show the panel")}>
          <button
            type="button"
            className={iconButton}
            aria-label={panelOpen ? t("Hide the panel") : t("Show the panel")}
            aria-expanded={panelOpen}
            aria-controls="editor-panel"
            onClick={() => setSetting("panel", !panelOpen)}
          >
            ▤
          </button>
        </Tooltip>
        {/* Renders longer than a moment: a thin line, never a blank canvas. */}
        {busy && (
          <span
            role="progressbar"
            aria-label={t("Rendering")}
            className="editor-progress absolute inset-x-0 -bottom-px h-0.5"
            data-testid="editor-busy"
          />
        )}
      </div>
      <div className="relative flex min-h-0 flex-1">
        <ToolRail
          searchOpen={searchOpen}
          onSearch={setSearchOpen}
          onGroup={() => !panelOpen && setSetting("panel", true)}
          activeRef={activeGroup}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="relative min-h-0 flex-1">
            <EditorCanvas
              controllerRef={controller}
              onZoomChange={onZoomChange}
              ratio={ratio}
              guide={guide}
            />
            {status === "opening" && (
              <p
                role="status"
                className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-md bg-black/60 px-2.5 py-1 text-[0.6875rem] text-white"
              >
                {t("Opening the picture…")}
              </p>
            )}
            {status === "failed" && (
              <div
                role="alert"
                className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas/85 text-center"
                data-testid="editor-error"
              >
                <p className="max-w-md text-sm">{error}</p>
                <button type="button" className={button} onClick={close}>
                  {t("Close the editor")}
                </button>
              </div>
            )}
            {renderError && status === "ready" && (
              <p
                role="alert"
                className="absolute bottom-3 left-1/2 max-w-[80%] -translate-x-1/2 truncate rounded-md bg-black/70 px-2.5 py-1 text-[0.6875rem] text-white"
                data-testid="editor-render-error"
              >
                {renderError}
              </p>
            )}
          </div>
          {batch && <BatchStrip />}
          <EditStack />
        </div>
        {panelOpen && (
          <aside
            id="editor-panel"
            aria-label={t("Tools and information")}
            className="flex w-72 shrink-0 flex-col overflow-y-auto border-l border-border bg-chrome"
            data-testid="editor-panel"
          >
            <Histogram />
            <ToolList ratioId={ratioId} onRatio={setRatioId} overlay={guide} onOverlay={setGuide} />
            <InfoTabs />
          </aside>
        )}
      </div>
      {batch ? <BatchClosePrompt /> : <UnsavedPrompt />}
    </div>
  )
}
