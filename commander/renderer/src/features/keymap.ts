import {
  MAX_CHORDS_PER_ACTION,
  NO_OVERRIDES,
  parseChord,
  parseOverrides,
  resolveKeymap,
  type ActionDef,
  type Keymap,
  type ShortcutOverrides,
} from "@fastview/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

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
    group: "App",
    label: "Switch to Viewer",
    defaults: ["Mod+Shift+m"],
    whileTyping: true,
  },
  {
    id: "help.shortcuts",
    scope: "shell",
    group: "App",
    label: "Keyboard shortcuts",
    defaults: ["F1", "Mod+/"],
  },
  { id: "panel.other", scope: "shell", group: "Panels", label: "Other panel", defaults: ["Tab"] },
  {
    id: "queue.toggle",
    scope: "shell",
    group: "Files",
    label: "Operation queue",
    defaults: ["Mod+j"],
  },
  {
    id: "app.settings",
    scope: "shell",
    group: "App",
    label: "Settings",
    defaults: ["Mod+,"],
  },
  {
    id: "view.quick",
    scope: "shell",
    group: "View",
    label: "Quick view",
    defaults: ["Mod+q"],
  },
  // Panels: act on the active panel.
  {
    id: "nav.up",
    scope: "panels",
    group: "Navigation",
    label: "Parent folder",
    defaults: ["Backspace", "Mod+PageUp"],
  },
  {
    id: "nav.root",
    scope: "panels",
    group: "Navigation",
    label: "Root folder",
    defaults: ["Mod+\\"],
  },
  {
    id: "nav.back",
    scope: "panels",
    group: "Navigation",
    label: "Back",
    defaults: ["Alt+ArrowLeft"],
  },
  {
    id: "nav.forward",
    scope: "panels",
    group: "Navigation",
    label: "Forward",
    defaults: ["Alt+ArrowRight"],
  },
  {
    id: "nav.openLeft",
    scope: "panels",
    group: "Navigation",
    label: "Open in the left panel",
    defaults: ["Mod+ArrowLeft"],
  },
  {
    id: "nav.openRight",
    scope: "panels",
    group: "Navigation",
    label: "Open in the right panel",
    defaults: ["Mod+ArrowRight"],
  },
  {
    id: "panels.swap",
    scope: "panels",
    group: "Navigation",
    label: "Swap panels",
    defaults: ["Mod+u"],
  },
  {
    id: "path.edit",
    scope: "panels",
    group: "Navigation",
    label: "Edit the path",
    defaults: ["Alt+d"],
  },
  {
    id: "nav.historyMenu",
    scope: "panels",
    group: "Navigation",
    label: "Folder history",
    defaults: ["Alt+ArrowDown"],
  },
  {
    id: "drives.left",
    scope: "panels",
    group: "Navigation",
    label: "Drive menu, left panel",
    defaults: ["Alt+F1"],
  },
  {
    id: "drives.right",
    scope: "panels",
    group: "Navigation",
    label: "Drive menu, right panel",
    defaults: ["Alt+F2"],
  },
  {
    id: "hotlist.open",
    scope: "panels",
    group: "Navigation",
    label: "Directory hotlist",
    defaults: ["Mod+d"],
  },
  { id: "tab.new", scope: "panels", group: "Tabs", label: "New tab", defaults: ["Mod+t"] },
  { id: "tab.close", scope: "panels", group: "Tabs", label: "Close tab", defaults: ["Mod+w"] },
  { id: "tab.next", scope: "panels", group: "Tabs", label: "Next tab", defaults: ["Mod+Tab"] },
  {
    id: "tab.previous",
    scope: "panels",
    group: "Tabs",
    label: "Previous tab",
    defaults: ["Mod+Shift+Tab"],
  },
  { id: "tab.lock", scope: "panels", group: "Tabs", label: "Lock or unlock tab", defaults: [] },
  {
    id: "tab.closeOthers",
    scope: "panels",
    group: "Tabs",
    label: "Close other tabs",
    defaults: [],
  },
  { id: "view.brief", scope: "panels", group: "View", label: "Brief view", defaults: ["Mod+F1"] },
  { id: "view.full", scope: "panels", group: "View", label: "Full view", defaults: ["Mod+F2"] },
  {
    id: "files.copy",
    scope: "panels",
    group: "Files",
    label: "Copy to the other panel",
    defaults: ["F5"],
  },
  {
    id: "files.move",
    scope: "panels",
    group: "Files",
    label: "Move to the other panel",
    defaults: ["F6"],
  },
  {
    id: "files.copyHere",
    scope: "panels",
    group: "Files",
    label: "Copy here under a new name",
    defaults: ["Shift+F5"],
  },
  {
    id: "files.rename",
    scope: "panels",
    group: "Files",
    label: "Rename",
    defaults: ["F2", "Shift+F6"],
  },
  { id: "files.mkdir", scope: "panels", group: "Files", label: "New folder", defaults: ["F7"] },
  { id: "files.view", scope: "panels", group: "Files", label: "View (lister)", defaults: ["F3"] },
  { id: "files.edit", scope: "panels", group: "Files", label: "Edit", defaults: ["F4"] },
  {
    id: "files.newText",
    scope: "panels",
    group: "Files",
    label: "New text file",
    defaults: ["Shift+F4"],
  },
  {
    id: "files.trash",
    scope: "panels",
    group: "Files",
    label: "Delete (to the trash)",
    defaults: ["F8", "Delete"],
  },
  {
    id: "files.delete",
    scope: "panels",
    group: "Files",
    label: "Delete permanently",
    defaults: ["Shift+F8", "Shift+Delete"],
  },
  {
    id: "clip.copy",
    scope: "panels",
    group: "Files",
    label: "Copy to the clipboard",
    defaults: ["Mod+c"],
  },
  {
    id: "clip.cut",
    scope: "panels",
    group: "Files",
    label: "Cut to the clipboard",
    defaults: ["Mod+x"],
  },
  { id: "clip.paste", scope: "panels", group: "Files", label: "Paste", defaults: ["Mod+v"] },
  {
    id: "copy.paths",
    scope: "panels",
    group: "Files",
    label: "Copy full paths as text",
    defaults: ["Mod+Shift+c"],
  },
  {
    id: "copy.names",
    scope: "panels",
    group: "Files",
    label: "Copy names as text",
    defaults: ["Mod+Alt+c"],
  },
  { id: "view.refresh", scope: "panels", group: "View", label: "Refresh", defaults: ["Mod+r"] },
  {
    id: "view.hidden",
    scope: "panels",
    group: "View",
    label: "Show hidden files",
    defaults: ["Mod+h"],
  },
  { id: "sort.name", scope: "panels", group: "View", label: "Sort by name", defaults: ["Mod+F3"] },
  {
    id: "sort.ext",
    scope: "panels",
    group: "View",
    label: "Sort by extension",
    defaults: ["Mod+F4"],
  },
  { id: "sort.date", scope: "panels", group: "View", label: "Sort by date", defaults: ["Mod+F5"] },
  { id: "sort.size", scope: "panels", group: "View", label: "Sort by size", defaults: ["Mod+F6"] },
  {
    id: "mark.toggleDown",
    scope: "panels",
    group: "Marking",
    label: "Mark and move down",
    defaults: ["Insert"],
  },
  {
    id: "mark.toggle",
    scope: "panels",
    group: "Marking",
    label: "Mark (folders: calculate the size)",
    defaults: ["Space"],
  },
  {
    id: "mark.all",
    scope: "panels",
    group: "Marking",
    label: "Mark all",
    defaults: ["Mod+a", "Mod+Num+"],
  },
  {
    id: "mark.none",
    scope: "panels",
    group: "Marking",
    label: "Unmark all",
    defaults: ["Mod+Num-"],
  },
  {
    id: "mark.invert",
    scope: "panels",
    group: "Marking",
    label: "Invert marks",
    defaults: ["Num*"],
  },
  {
    id: "mark.mask",
    scope: "panels",
    group: "Marking",
    label: "Mark by mask…",
    defaults: ["Num+"],
  },
  {
    id: "unmark.mask",
    scope: "panels",
    group: "Marking",
    label: "Unmark by mask…",
    defaults: ["Num-"],
  },
  {
    id: "mark.sameExt",
    scope: "panels",
    group: "Marking",
    label: "Mark files with the same extension",
    defaults: ["Alt+Num+"],
  },
  {
    id: "size.all",
    scope: "panels",
    group: "Marking",
    label: "Calculate all folder sizes",
    defaults: ["Alt+Shift+Enter"],
  },
  // Lister (Stage C05): act in the full-window viewer.
  { id: "lister.close", scope: "lister", group: "Lister", label: "Close", defaults: ["Escape"] },
  { id: "lister.next", scope: "lister", group: "Lister", label: "Next file", defaults: ["n"] },
  {
    id: "lister.previous",
    scope: "lister",
    group: "Lister",
    label: "Previous file",
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
    group: "Lister",
    label: "Find next",
    defaults: ["F3"],
  },
  {
    id: "lister.findPrevious",
    scope: "lister",
    group: "Lister",
    label: "Find previous",
    defaults: ["Shift+F3"],
  },
] as const satisfies readonly ActionDef<Scope>[]

export type ActionId = (typeof ACTIONS)[number]["id"]

export const SHORTCUTS_KEY = "commander.shortcuts"

interface KeymapState {
  overrides: ShortcutOverrides
  keymap: Keymap<Scope>
  helpOpen: boolean
}

const resolve = (o: ShortcutOverrides): Keymap<Scope> => resolveKeymap(ACTIONS, SCOPES, o)

export const useKeymapStore = create<KeymapState>(() => ({
  overrides: NO_OVERRIDES,
  keymap: resolve(NO_OVERRIDES),
  helpOpen: false,
}))

const set = useKeymapStore.setState
const get = useKeymapStore.getState

function apply(overrides: ShortcutOverrides): void {
  set({ overrides, keymap: resolve(overrides) })
}

function persist(): void {
  if (isBridgeAvailable())
    void bridge.setSetting(SHORTCUTS_KEY, get().overrides).catch(() => undefined)
}

/** The action bound to a chord in a scope, if any. */
export function actionFor(scope: Scope, chord: string): ActionId | undefined {
  return get().keymap.lookup[scope].get(chord) as ActionId | undefined
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
  apply(parseOverrides(ACTIONS, settings[SHORTCUTS_KEY]))
}

/** Tests. */
export function resetKeymap(): void {
  set({ overrides: NO_OVERRIDES, keymap: resolve(NO_OVERRIDES), helpOpen: false })
}
