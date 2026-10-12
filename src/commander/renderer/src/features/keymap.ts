import {
  MAX_CHORDS_PER_ACTION,
  NO_OVERRIDES,
  parseChord,
  parseOverrides,
  resolveKeymap,
  type ActionDef,
  type Keymap,
  type ShortcutOverrides,
} from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import { msg } from "@panelyth/i18n"

// The commander's actions with Total Commander defaults (Stage C02,
// ADR-0022, ADR-0028), on the keymap engine shared with the viewer.
// Cursor movement (arrows, PgUp/PgDn, Home/End), Shift+arrows, Enter and
// the letters of quick search are fixed and not part of the map.

export type Scope = "shell" | "panels" | "lister"
export const SCOPES: readonly Scope[] = ["shell", "panels", "lister"]

export const ACTIONS = [
  // Shell: work wherever focus is.
  {
    id: "app.switch",
    scope: "shell",
    group: msg("App"),
    label: msg("Switch to Viewer"),
    defaults: ["Mod+Shift+m"],
    whileTyping: true,
  },
  {
    id: "help.shortcuts",
    scope: "shell",
    group: msg("App"),
    label: msg("Keyboard shortcuts"),
    defaults: ["F1", "Mod+/"],
  },
  { id: "panel.other", scope: "shell", group: "Panels", label: "Other panel", defaults: ["Tab"] },
  {
    id: "queue.toggle",
    scope: "shell",
    group: msg("Files"),
    label: msg("Operation queue"),
    defaults: ["Mod+j"],
  },
  {
    id: "app.settings",
    scope: "shell",
    group: msg("App"),
    label: msg("Settings"),
    defaults: ["Mod+,"],
  },
  {
    id: "view.quick",
    scope: "shell",
    group: msg("View"),
    label: msg("Quick view"),
    defaults: ["Mod+q"],
  },
  // Panels: act on the active panel.
  {
    id: "nav.up",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Parent folder"),
    defaults: ["Backspace", "Mod+PageUp"],
  },
  {
    id: "nav.root",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Root folder"),
    defaults: ["Mod+\\"],
  },
  {
    id: "nav.back",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Back"),
    defaults: ["Alt+ArrowLeft"],
  },
  {
    id: "nav.forward",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Forward"),
    defaults: ["Alt+ArrowRight"],
  },
  {
    id: "nav.openLeft",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Open in the left panel"),
    defaults: ["Mod+ArrowLeft"],
  },
  {
    id: "nav.openRight",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Open in the right panel"),
    defaults: ["Mod+ArrowRight"],
  },
  {
    id: "panels.swap",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Swap panels"),
    defaults: ["Mod+u"],
  },
  {
    id: "path.edit",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Edit the path"),
    defaults: ["Alt+d"],
  },
  {
    id: "nav.historyMenu",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Folder history"),
    defaults: ["Alt+ArrowDown"],
  },
  {
    id: "drives.left",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Drive menu, left panel"),
    defaults: ["Alt+F1"],
  },
  {
    id: "drives.right",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Drive menu, right panel"),
    defaults: ["Alt+F2"],
  },
  {
    id: "hotlist.open",
    scope: "panels",
    group: msg("Navigation"),
    label: msg("Directory hotlist"),
    defaults: ["Mod+d"],
  },
  { id: "tab.new", scope: "panels", group: "Tabs", label: "New tab", defaults: ["Mod+t"] },
  { id: "tab.close", scope: "panels", group: "Tabs", label: "Close tab", defaults: ["Mod+w"] },
  { id: "tab.next", scope: "panels", group: "Tabs", label: "Next tab", defaults: ["Mod+Tab"] },
  {
    id: "tab.previous",
    scope: "panels",
    group: msg("Tabs"),
    label: msg("Previous tab"),
    defaults: ["Mod+Shift+Tab"],
  },
  { id: "tab.lock", scope: "panels", group: "Tabs", label: "Lock or unlock tab", defaults: [] },
  {
    id: "tab.closeOthers",
    scope: "panels",
    group: msg("Tabs"),
    label: msg("Close other tabs"),
    defaults: [],
  },
  { id: "view.brief", scope: "panels", group: "View", label: "Brief view", defaults: ["Mod+F1"] },
  { id: "view.full", scope: "panels", group: "View", label: "Full view", defaults: ["Mod+F2"] },
  {
    id: "files.copy",
    scope: "panels",
    group: msg("Files"),
    label: msg("Copy to the other panel"),
    defaults: ["F5"],
  },
  {
    id: "files.move",
    scope: "panels",
    group: msg("Files"),
    label: msg("Move to the other panel"),
    defaults: ["F6"],
  },
  {
    id: "files.copyHere",
    scope: "panels",
    group: msg("Files"),
    label: msg("Copy here under a new name"),
    defaults: ["Shift+F5"],
  },
  {
    id: "files.rename",
    scope: "panels",
    group: msg("Files"),
    label: msg("Rename"),
    defaults: ["F2", "Shift+F6"],
  },
  { id: "files.mkdir", scope: "panels", group: "Files", label: "New folder", defaults: ["F7"] },
  { id: "files.view", scope: "panels", group: "Files", label: "View (lister)", defaults: ["F3"] },
  { id: "files.edit", scope: "panels", group: "Files", label: "Edit", defaults: ["F4"] },
  {
    id: "files.newText",
    scope: "panels",
    group: msg("Files"),
    label: msg("New text file"),
    defaults: ["Shift+F4"],
  },
  {
    id: "files.trash",
    scope: "panels",
    group: msg("Files"),
    label: msg("Delete (to the trash)"),
    defaults: ["F8", "Delete"],
  },
  {
    id: "files.delete",
    scope: "panels",
    group: msg("Files"),
    label: msg("Delete permanently"),
    defaults: ["Shift+F8", "Shift+Delete"],
  },
  {
    id: "clip.copy",
    scope: "panels",
    group: msg("Files"),
    label: msg("Copy to the clipboard"),
    defaults: ["Mod+c"],
  },
  {
    id: "clip.cut",
    scope: "panels",
    group: msg("Files"),
    label: msg("Cut to the clipboard"),
    defaults: ["Mod+x"],
  },
  { id: "clip.paste", scope: "panels", group: "Files", label: "Paste", defaults: ["Mod+v"] },
  {
    id: "copy.paths",
    scope: "panels",
    group: msg("Files"),
    label: msg("Copy full paths as text"),
    defaults: ["Mod+Shift+c"],
  },
  {
    id: "copy.names",
    scope: "panels",
    group: msg("Files"),
    label: msg("Copy names as text"),
    defaults: ["Mod+Alt+c"],
  },
  { id: "view.refresh", scope: "panels", group: "View", label: "Refresh", defaults: ["Mod+r"] },
  {
    id: "view.hidden",
    scope: "panels",
    group: msg("View"),
    label: msg("Show hidden files"),
    defaults: ["Mod+h"],
  },
  // Stage C06: find files, branch view, quick filter.
  {
    id: "find.open",
    scope: "panels",
    group: msg("Files"),
    label: msg("Find files"),
    defaults: ["Alt+F7"],
  },
  // Stage C07: archives.
  {
    id: "archive.enter",
    scope: "panels",
    group: msg("Archives"),
    label: msg("Open the archive under the cursor"),
    defaults: ["Mod+PageDown"],
  },
  {
    id: "archive.pack",
    scope: "panels",
    group: msg("Archives"),
    label: msg("Pack"),
    defaults: ["Alt+F5"],
  },
  {
    id: "archive.unpack",
    scope: "panels",
    group: msg("Archives"),
    label: msg("Unpack"),
    defaults: ["Alt+F9"],
  },
  {
    id: "archive.test",
    scope: "panels",
    group: msg("Archives"),
    label: msg("Test archives"),
    defaults: ["Alt+Shift+F9"],
  },
  // Stage C08: compare, synchronize, checksums.
  {
    id: "compare.dirs",
    scope: "panels",
    group: msg("Compare"),
    label: msg("Compare directories"),
    defaults: ["Shift+F2"],
  },
  {
    id: "compare.sync",
    scope: "panels",
    group: msg("Compare"),
    label: msg("Synchronize directories"),
    defaults: [],
  },
  {
    id: "compare.content",
    scope: "panels",
    group: msg("Compare"),
    label: msg("Compare by content"),
    defaults: [],
  },
  {
    id: "hash.create",
    scope: "panels",
    group: msg("Compare"),
    label: msg("Create checksums"),
    defaults: [],
  },
  {
    id: "hash.verify",
    scope: "panels",
    group: msg("Compare"),
    label: msg("Verify checksums"),
    defaults: [],
  },
  // Stage C09: multi-rename, attributes and properties.
  {
    id: "files.multiRename",
    scope: "panels",
    group: msg("Files"),
    label: msg("Multi-rename"),
    defaults: ["Mod+m"],
  },
  {
    id: "files.undoRename",
    scope: "panels",
    group: msg("Files"),
    label: msg("Undo the last multi-rename"),
    defaults: [],
  },
  {
    id: "files.attributes",
    scope: "panels",
    group: msg("Files"),
    label: msg("Change attributes"),
    defaults: [],
  },
  {
    id: "files.properties",
    scope: "panels",
    group: msg("Files"),
    label: msg("Properties"),
    defaults: ["Alt+Enter"],
  },
  {
    id: "view.branch",
    scope: "panels",
    group: msg("View"),
    label: msg("Branch view (all files below)"),
    defaults: ["Mod+b"],
  },
  {
    id: "view.filter",
    scope: "panels",
    group: msg("View"),
    label: msg("Quick filter"),
    defaults: ["Mod+s"],
  },
  { id: "sort.name", scope: "panels", group: "View", label: "Sort by name", defaults: ["Mod+F3"] },
  {
    id: "sort.ext",
    scope: "panels",
    group: msg("View"),
    label: msg("Sort by extension"),
    defaults: ["Mod+F4"],
  },
  { id: "sort.date", scope: "panels", group: "View", label: "Sort by date", defaults: ["Mod+F5"] },
  { id: "sort.size", scope: "panels", group: "View", label: "Sort by size", defaults: ["Mod+F6"] },
  {
    id: "mark.toggleDown",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Mark and move down"),
    defaults: ["Insert"],
  },
  {
    id: "mark.toggle",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Mark (folders: calculate the size)"),
    defaults: ["Space"],
  },
  {
    id: "mark.all",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Mark all"),
    defaults: ["Mod+a", "Mod+Num+"],
  },
  {
    id: "mark.none",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Unmark all"),
    defaults: ["Mod+Num-"],
  },
  {
    id: "mark.invert",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Invert marks"),
    defaults: ["Num*"],
  },
  {
    id: "mark.mask",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Mark by mask…"),
    defaults: ["Num+"],
  },
  {
    id: "unmark.mask",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Unmark by mask…"),
    defaults: ["Num-"],
  },
  {
    id: "mark.sameExt",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Mark files with the same extension"),
    defaults: ["Alt+Num+"],
  },
  {
    id: "size.all",
    scope: "panels",
    group: msg("Marking"),
    label: msg("Calculate all folder sizes"),
    defaults: ["Alt+Shift+Enter"],
  },
  // Stage C10: the command line, the Thumbnails view, the bars.
  {
    id: "cmd.focus",
    scope: "shell",
    group: msg("Command line"),
    label: msg("Go to the command line"),
    defaults: ["Mod+k"],
    whileTyping: true,
  },
  {
    id: "cmd.history",
    scope: "shell",
    group: msg("Command line"),
    label: msg("Command history"),
    defaults: ["Alt+F8"],
    whileTyping: true,
  },
  {
    id: "cmd.insertName",
    scope: "panels",
    group: msg("Command line"),
    label: msg("Add the name under the cursor to the command line"),
    defaults: ["Mod+Enter"],
  },
  {
    id: "cmd.insertPath",
    scope: "panels",
    group: msg("Command line"),
    label: msg("Add the full path under the cursor to the command line"),
    defaults: ["Mod+Shift+Enter"],
  },
  {
    id: "view.thumbs",
    scope: "panels",
    group: msg("View"),
    label: msg("Thumbnails view"),
    defaults: ["Mod+Shift+F1"],
  },
  {
    id: "view.toolbar",
    scope: "shell",
    group: msg("View"),
    label: msg("Show or hide the toolbar"),
    defaults: [],
  },
  {
    id: "view.commandLine",
    scope: "shell",
    group: msg("View"),
    label: msg("Show or hide the command line"),
    defaults: [],
  },
  {
    id: "view.functionKeys",
    scope: "shell",
    group: msg("View"),
    label: msg("Show or hide the function-key bar"),
    defaults: [],
  },
  // Lister (Stage C05): act in the full-window viewer.
  { id: "lister.close", scope: "lister", group: "Lister", label: "Close", defaults: ["Escape"] },
  { id: "lister.next", scope: "lister", group: "Lister", label: "Next file", defaults: ["n"] },
  {
    id: "lister.previous",
    scope: "lister",
    group: msg("Lister"),
    label: msg("Previous file"),
    defaults: ["p"],
  },
  { id: "lister.text", scope: "lister", group: "Lister", label: "Text", defaults: ["1"] },
  { id: "lister.hex", scope: "lister", group: "Lister", label: "Hex", defaults: ["2"] },
  { id: "lister.image", scope: "lister", group: "Lister", label: "Image", defaults: ["3"] },
  { id: "lister.video", scope: "lister", group: "Lister", label: "Video", defaults: ["4"] },
  { id: "lister.wrap", scope: "lister", group: "Lister", label: "Wrap lines", defaults: ["w"] },
  { id: "lister.find", scope: "lister", group: "Lister", label: "Find", defaults: ["Mod+f"] },
  {
    id: "lister.findNext",
    scope: "lister",
    group: msg("Lister"),
    label: msg("Find next"),
    defaults: ["F3"],
  },
  {
    id: "lister.findPrevious",
    scope: "lister",
    group: msg("Lister"),
    label: msg("Find previous"),
    defaults: ["Shift+F3"],
  },
] as const satisfies readonly ActionDef<Scope>[]

export type ActionId = (typeof ACTIONS)[number]["id"]

/** A user command as a bindable action (Stage C10): "tool:" and its id. */
export type ToolActionId = `tool:${string}`
export const isToolAction = (id: string): id is ToolActionId => id.startsWith("tool:")
export const toolAction = (id: string): ToolActionId => `tool:${id}`

export const SHORTCUTS_KEY = "commander.shortcuts"

interface KeymapState {
  overrides: ShortcutOverrides
  keymap: Keymap<Scope>
  /** The built-in actions and the user's commands, as the shortcuts dialog lists them. */
  actions: readonly ActionDef<Scope>[]
  helpOpen: boolean
}

let toolActions: ActionDef<Scope>[] = []
/** The overrides as stored: bindings of commands that load later are in here. */
let stored: unknown = undefined

const all = (): readonly ActionDef<Scope>[] => [...ACTIONS, ...toolActions]
const resolve = (o: ShortcutOverrides): Keymap<Scope> => resolveKeymap(all(), SCOPES, o)

export const useKeymapStore = create<KeymapState>(() => ({
  overrides: NO_OVERRIDES,
  keymap: resolve(NO_OVERRIDES),
  actions: ACTIONS,
  helpOpen: false,
}))

const set = useKeymapStore.setState
const get = useKeymapStore.getState

function apply(overrides: ShortcutOverrides): void {
  set({ overrides, keymap: resolve(overrides) })
}

function persist(): void {
  stored = get().overrides
  if (isBridgeAvailable())
    void bridge.setSetting(SHORTCUTS_KEY, get().overrides).catch(() => undefined)
}

/**
 * The user's commands as actions of the panels (Stage C10): each can be
 * bound to a key in the shortcuts dialog. A binding stored for a command is
 * applied once that command is known.
 */
export function setToolActions(tools: readonly { id: string; title: string }[]): void {
  toolActions = tools.map((tool) => ({
    id: toolAction(tool.id),
    scope: "panels" as const,
    group: msg("Tools"),
    label: tool.title,
    defaults: [],
  }))
  const kept = (stored as { bindings?: Record<string, unknown> } | undefined)?.bindings ?? {}
  const overrides = parseOverrides(all(), {
    v: 1,
    bindings: { ...kept, ...get().overrides.bindings },
  })
  set({ overrides, keymap: resolve(overrides), actions: all() })
}

/** The action bound to a chord in a scope, if any. User commands are actions of the panels only. */
export function actionFor(scope: "panels", chord: string): ActionId | ToolActionId | undefined
export function actionFor(scope: Scope, chord: string): ActionId | undefined
export function actionFor(scope: Scope, chord: string): ActionId | ToolActionId | undefined {
  return get().keymap.lookup[scope].get(chord) as ActionId | ToolActionId | undefined
}

export function setBinding(id: string, chords: readonly string[]): void {
  const valid = [...new Set(chords.map(parseChord).filter((c) => c !== null))].slice(
    0,
    MAX_CHORDS_PER_ACTION,
  )
  if (chords.length > 0 && valid.length === 0) return
  apply({ v: 1, bindings: { ...get().overrides.bindings, [id]: valid } })
  persist()
}

export function resetBinding(id: string): void {
  const bindings = { ...get().overrides.bindings }
  delete bindings[id]
  apply({ v: 1, bindings })
  persist()
}

export function resetAllBindings(): void {
  apply(NO_OVERRIDES)
  persist()
}

export const setHelpOpen = (helpOpen: boolean): void => set({ helpOpen })

/** Applies the stored overrides once library.db is reachable. */
export async function loadShortcuts(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  stored = settings[SHORTCUTS_KEY]
  apply(parseOverrides(all(), stored))
}

/** Tests. */
export function resetKeymap(): void {
  toolActions = []
  stored = undefined
  set({
    overrides: NO_OVERRIDES,
    keymap: resolve(NO_OVERRIDES),
    actions: ACTIONS,
    helpOpen: false,
  })
}
