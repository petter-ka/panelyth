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

export type Scope = "global" | "viewer"

export interface ActionDef {
  id: string
  scope: Scope
  label: string
  group: string
  defaults: readonly string[]
  /** Extra defaults on macOS only. */
  macDefaults?: readonly string[]
  /** May fire while a text field has focus (only chords with Mod/Alt or a function key do). */
  whileTyping?: boolean
}

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

export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock"])
const isFunctionKey = (key: string): boolean => /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
const isLetter = (key: string): boolean => /^[a-z]$/.test(key)

function normalizeKey(key: string): string {
  if (key === "+") return "Plus"
  if (key === " ") return "Space"
  return key.length === 1 ? key.toLowerCase() : key
}

/** The chord for a key event, or null for a bare modifier. */
export function eventChord(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey">,
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = normalizeKey(e.key)
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push("Mod")
  if (e.altKey) parts.push("Alt")
  // Shift counts for letters and named keys; symbols already encode it.
  if (e.shiftKey && (key.length > 1 || isLetter(key)) && key !== "Plus") parts.push("Shift")
  parts.push(key)
  return parts.join("+")
}

/** Canonical form of a chord string, or null when it is not valid. */
export function parseChord(chord: string): string | null {
  if (typeof chord !== "string" || chord.length === 0 || chord.length > 40) return null
  const parts = chord.split("+")
  // "Mod++" style is not used: the plus key is spelled "Plus".
  if (parts.some((p) => p === "")) return null
  const key = parts.pop()!
  const mods = new Set(parts)
  if (
    mods.size !== parts.length ||
    [...mods].some((m) => m !== "Mod" && m !== "Alt" && m !== "Shift")
  ) {
    return null
  }
  if (MODIFIER_KEYS.has(key)) return null
  const k = key.length === 1 ? key.toLowerCase() : key
  if (k.length > 1 && !/^[A-Z][A-Za-z0-9]*$/.test(k)) return null
  return [...(["Mod", "Alt", "Shift"] as const).filter((m) => mods.has(m)), k].join("+")
}

/** True when the chord may fire while a text field has focus. */
export function chordAllowedWhileTyping(chord: string): boolean {
  const parts = chord.split("+")
  const key = parts[parts.length - 1]!
  return parts.includes("Mod") || parts.includes("Alt") || isFunctionKey(key)
}

// Overrides ----------------------------------------------------------------

export const SHORTCUTS_KEY = "shortcuts"
export const MAX_CHORDS_PER_ACTION = 4

export interface ShortcutOverrides {
  v: 1
  /** Replaces the action's defaults; an empty list unbinds it. */
  bindings: Partial<Record<ActionId, string[]>>
}

export const NO_OVERRIDES: ShortcutOverrides = { v: 1, bindings: {} }

/** Validates untrusted persisted data; unknown actions and bad chords are dropped. */
export function parseOverrides(value: unknown): ShortcutOverrides {
  if (typeof value !== "object" || value === null) return NO_OVERRIDES
  const v = value as Record<string, unknown>
  if (v.v !== 1 || typeof v.bindings !== "object" || v.bindings === null) return NO_OVERRIDES
  const bindings: ShortcutOverrides["bindings"] = {}
  for (const [id, chords] of Object.entries(v.bindings as Record<string, unknown>)) {
    if (!byId.has(id) || !Array.isArray(chords)) continue
    const valid = [...new Set(chords.map((c) => parseChord(c as string)).filter((c) => c !== null))]
    bindings[id as ActionId] = valid.slice(0, MAX_CHORDS_PER_ACTION)
  }
  return { v: 1, bindings }
}

// Resolution ---------------------------------------------------------------

export interface Keymap {
  /** scope -> chord -> action */
  readonly lookup: Readonly<Record<Scope, ReadonlyMap<string, ActionId>>>
  /** Effective chords per action, in display order. */
  readonly chords: Readonly<Record<ActionId, readonly string[]>>
}

export function defaultChords(def: ActionDef, mac = IS_MAC): string[] {
  return [...def.defaults, ...(mac && def.macDefaults ? def.macDefaults : [])]
}

/** Overrides first (they win conflicts), then defaults in registry order. */
export function resolveKeymap(overrides: ShortcutOverrides, mac = IS_MAC): Keymap {
  const lookup: Record<Scope, Map<string, ActionId>> = { global: new Map(), viewer: new Map() }
  const chords = {} as Record<ActionId, string[]>
  const claim = (def: ActionDef, list: readonly string[]): void => {
    const own: string[] = []
    for (const chord of list) {
      if (lookup[def.scope].has(chord)) continue
      lookup[def.scope].set(chord, def.id as ActionId)
      own.push(chord)
    }
    chords[def.id as ActionId] = own
  }
  for (const def of ACTIONS) {
    const o = overrides.bindings[def.id]
    if (o) claim(def, o)
  }
  for (const def of ACTIONS) {
    if (!overrides.bindings[def.id]) claim(def, defaultChords(def, mac))
  }
  return { lookup, chords }
}

// Display ------------------------------------------------------------------

const KEY_NAMES: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Delete: "Del",
  Escape: "Esc",
  PageUp: "PgUp",
  PageDown: "PgDn",
  Plus: "+",
  Space: "Space",
}

/** "Mod+Shift+Delete" -> "Ctrl+Shift+Del" (or "⌘⇧Del" on macOS). */
export function formatChord(chord: string, mac = IS_MAC): string {
  const parts = chord.split("+")
  const key = parts.pop()!
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  if (mac) {
    const sym: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" }
    return (
      parts.map((p) => sym[p]).join("") + (name === "Del" ? "⌦" : name === "Backspace" ? "⌫" : name)
    )
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), name].join("+")
}
