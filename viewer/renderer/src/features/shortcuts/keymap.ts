// Custom shortcut foundation (Stage 08, ADR-0022).
//
// Every remappable command is an action with default chords. The user's
// overrides live in library.db (setting "shortcuts") and replace an action's
// defaults; a chord taken by an override is removed from any other action in
// the same scope, so one key never runs two commands. Tile-view navigation
// (arrows, Enter, Ctrl+A, type-to-select) is fixed and not part of the map.
//
// Chord format: modifiers in the order Mod, Alt, Shift, then the key, joined
// by "+": "Mod+Shift+Delete". Mod is Ctrl on Windows/Linux and Cmd on macOS
// (either works on both, as before Stage 08). Keys use KeyboardEvent.key
// names; letters are lowercase, "+" is "Plus". Shift is not part of a chord
// for symbol keys, because the symbol already depends on it ("+" vs "=").

import * as core from "@panelyth/renderer-core"

export type Scope = "global" | "viewer"

export type ActionDef = core.ActionDef<Scope>

export const ACTIONS = [
  // Global
  {
    id: "nav.back",
    scope: "global",
    group: "Navigation",
    label: "Back",
    defaults: ["Alt+ArrowLeft"],
    whileTyping: true,
  },
  {
    id: "nav.forward",
    scope: "global",
    group: "Navigation",
    label: "Forward",
    defaults: ["Alt+ArrowRight"],
    whileTyping: true,
  },
  {
    id: "nav.up",
    scope: "global",
    group: "Navigation",
    label: "Up one folder",
    defaults: ["Alt+ArrowUp", "Backspace"],
    whileTyping: true,
  },
  {
    id: "view.refresh",
    scope: "global",
    group: "Navigation",
    label: "Refresh",
    defaults: ["F5", "Mod+r"],
    whileTyping: true,
  },
  {
    id: "search.focus",
    scope: "global",
    group: "Navigation",
    label: "Search in folder",
    defaults: ["Mod+f"],
    whileTyping: true,
  },
  {
    id: "pane.next",
    scope: "global",
    group: "Navigation",
    label: "Next pane",
    defaults: ["F6"],
    whileTyping: true,
  },
  {
    id: "pane.previous",
    scope: "global",
    group: "Navigation",
    label: "Previous pane",
    defaults: ["Shift+F6"],
    whileTyping: true,
  },
  { id: "edit.cut", scope: "global", group: "Files", label: "Cut", defaults: ["Mod+x"] },
  { id: "edit.copy", scope: "global", group: "Files", label: "Copy", defaults: ["Mod+c"] },
  { id: "edit.paste", scope: "global", group: "Files", label: "Paste", defaults: ["Mod+v"] },
  { id: "item.rename", scope: "global", group: "Files", label: "Rename", defaults: ["F2"] },
  {
    id: "item.trash",
    scope: "global",
    group: "Files",
    label: "Move to trash",
    defaults: ["Delete"],
    macDefaults: ["Mod+Backspace"],
  },
  {
    id: "item.delete",
    scope: "global",
    group: "Files",
    label: "Delete permanently",
    defaults: ["Shift+Delete"],
    macDefaults: ["Mod+Shift+Backspace"],
  },
  {
    id: "item.properties",
    scope: "global",
    group: "Files",
    label: "Properties",
    defaults: ["Alt+Enter"],
  },
  {
    id: "app.switch",
    scope: "global",
    group: "App",
    label: "Switch to Commander",
    defaults: ["Mod+Shift+m"],
    whileTyping: true,
  },
  {
    id: "help.shortcuts",
    scope: "global",
    group: "Help",
    label: "Keyboard shortcuts",
    defaults: ["Mod+/", "F1"],
    whileTyping: true,
  },
  // Focused viewer
  {
    id: "viewer.close",
    scope: "viewer",
    group: "Viewer",
    label: "Back to folder",
    defaults: ["Escape", "Backspace"],
  },
  {
    id: "viewer.next",
    scope: "viewer",
    group: "Viewer",
    label: "Next image",
    defaults: ["ArrowRight", "PageDown"],
  },
  {
    id: "viewer.previous",
    scope: "viewer",
    group: "Viewer",
    label: "Previous image",
    defaults: ["ArrowLeft", "PageUp"],
  },
  {
    id: "viewer.first",
    scope: "viewer",
    group: "Viewer",
    label: "First image",
    defaults: ["Home"],
  },
  { id: "viewer.last", scope: "viewer", group: "Viewer", label: "Last image", defaults: ["End"] },
  {
    id: "viewer.zoomIn",
    scope: "viewer",
    group: "Viewer",
    label: "Zoom in",
    defaults: ["Plus", "="],
  },
  { id: "viewer.zoomOut", scope: "viewer", group: "Viewer", label: "Zoom out", defaults: ["-"] },
  { id: "viewer.fit", scope: "viewer", group: "Viewer", label: "Fit to window", defaults: ["0"] },
  {
    id: "viewer.actualSize",
    scope: "viewer",
    group: "Viewer",
    label: "Actual size",
    defaults: ["1"],
  },
  {
    id: "viewer.rotateCw",
    scope: "viewer",
    group: "Viewer",
    label: "Rotate right",
    defaults: ["r"],
  },
  {
    id: "viewer.rotateCcw",
    scope: "viewer",
    group: "Viewer",
    label: "Rotate left",
    defaults: ["Shift+r"],
  },
  {
    id: "viewer.flip",
    scope: "viewer",
    group: "Viewer",
    label: "Flip horizontally",
    defaults: ["h"],
  },
  {
    id: "viewer.copy",
    scope: "viewer",
    group: "Viewer",
    label: "Copy picture",
    defaults: ["Mod+c"],
  },
] as const satisfies readonly ActionDef[]

export type ActionId = (typeof ACTIONS)[number]["id"]

const byId: ReadonlyMap<string, ActionDef> = new Map(ACTIONS.map((a) => [a.id, a]))

export function actionDef(id: ActionId): ActionDef {
  return byId.get(id)!
}

// The engine (chords, overrides, resolution, display) is shared with the
// commander (shared/renderer-core, ADR-0031); the viewer keeps its registry.
export {
  chordAllowedWhileTyping,
  defaultChords,
  eventChord,
  formatChord,
  IS_MAC,
  MAX_CHORDS_PER_ACTION,
  parseChord,
} from "@panelyth/renderer-core"

export const SHORTCUTS_KEY = "shortcuts"

export interface ShortcutOverrides {
  v: 1
  /** Replaces the action's defaults; an empty list unbinds it. */
  bindings: Partial<Record<ActionId, string[]>>
}

export const NO_OVERRIDES: ShortcutOverrides = { v: 1, bindings: {} }

/** Validates untrusted persisted data; unknown actions and bad chords are dropped. */
export function parseOverrides(value: unknown): ShortcutOverrides {
  return core.parseOverrides(ACTIONS, value) as ShortcutOverrides
}

export interface Keymap {
  /** scope -> chord -> action */
  readonly lookup: Readonly<Record<Scope, ReadonlyMap<string, ActionId>>>
  /** Effective chords per action, in display order. */
  readonly chords: Readonly<Record<ActionId, readonly string[]>>
}

const SCOPES: readonly Scope[] = ["global", "viewer"]

/** Overrides first (they win conflicts), then defaults in registry order. */
export function resolveKeymap(overrides: ShortcutOverrides, mac = core.IS_MAC): Keymap {
  return core.resolveKeymap<Scope>(
    ACTIONS,
    SCOPES,
    overrides as core.ShortcutOverrides,
    mac,
  ) as unknown as Keymap
}
