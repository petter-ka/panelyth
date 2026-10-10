// The keymap engine shared by both apps (ADR-0022, ADR-0031). Each app
// registers its actions; this module parses, resolves and formats chords.
//
// Every remappable command is an action with default chords. The user's
// overrides replace an action's defaults; a chord taken by an override is
// removed from any other action in the same scope, so one key never runs two
// commands.
//
// Chord format: modifiers in the order Mod, Alt, Shift, then the key, joined
// by "+": "Mod+Shift+Delete". Mod is Ctrl on Windows/Linux and Cmd on macOS
// (either works on both). Keys use KeyboardEvent.key names; letters are
// lowercase, "+" is "Plus". Shift is not part of a chord for symbol keys,
// because the symbol already depends on it ("+" vs "="). Keys of the numeric
// keypad are "Num+", "Num-", "Num*" (KeyboardEvent.code decides).

export interface ActionDef<Scope extends string = string> {
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

export const IS_MAC = typeof navigator !== "undefined" && /mac/i.test(navigator.platform)

const MODIFIER_KEYS = new Set(["Control", "Meta", "Alt", "Shift", "AltGraph", "CapsLock"])
const isFunctionKey = (key: string): boolean => /^F([1-9]|1[0-9]|2[0-4])$/.test(key)
const isLetter = (key: string): boolean => /^[a-z]$/.test(key)

const NUMPAD: Record<string, string> = {
  NumpadAdd: "Num+",
  NumpadSubtract: "Num-",
  NumpadMultiply: "Num*",
}

function normalizeKey(key: string, code?: string): string {
  const pad = code ? NUMPAD[code] : undefined
  if (pad) return pad
  if (key === "+") return "Plus"
  if (key === " ") return "Space"
  return key.length === 1 ? key.toLowerCase() : key
}

/** The chord for a key event, or null for a bare modifier. */
export function eventChord(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey"> & {
    code?: string
  },
): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null
  const key = normalizeKey(e.key, e.code)
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
  // The keypad keys carry their symbol: "Mod+Num+" splits into "Mod", "Num", "".
  const pad = /(Num[+\-*])$/.exec(chord)
  const head = pad ? chord.slice(0, -pad[1]!.length) : chord
  const parts = head === "" ? [] : head.replace(/\+$/, "").split("+")
  if (parts.some((p) => p === "")) return null
  const key = pad ? pad[1]! : parts.pop()
  if (key === undefined) return null
  const mods = new Set(parts)
  if (
    mods.size !== parts.length ||
    [...mods].some((m) => m !== "Mod" && m !== "Alt" && m !== "Shift")
  ) {
    return null
  }
  if (MODIFIER_KEYS.has(key)) return null
  const k = key.length === 1 ? key.toLowerCase() : key
  if (!pad && k.length > 1 && !/^[A-Z][A-Za-z0-9]*$/.test(k)) return null
  return [...(["Mod", "Alt", "Shift"] as const).filter((m) => mods.has(m)), k].join("+")
}

/** True when the chord may fire while a text field has focus. */
export function chordAllowedWhileTyping(chord: string): boolean {
  const pad = /Num[+\-*]$/.test(chord)
  const parts = (pad ? chord.replace(/\+?Num[+\-*]$/, "") : chord).split("+")
  const key = pad ? "Num" : parts[parts.length - 1]!
  return parts.includes("Mod") || parts.includes("Alt") || isFunctionKey(key)
}

// Overrides ----------------------------------------------------------------

export const MAX_CHORDS_PER_ACTION = 4

export interface ShortcutOverrides {
  v: 1
  /** Replaces the action's defaults; an empty list unbinds it. */
  bindings: Record<string, string[]>
}

export const NO_OVERRIDES: ShortcutOverrides = { v: 1, bindings: {} }

/** Validates untrusted persisted data; unknown actions and bad chords are dropped. */
export function parseOverrides(actions: readonly ActionDef[], value: unknown): ShortcutOverrides {
  if (typeof value !== "object" || value === null) return NO_OVERRIDES
  const v = value as Record<string, unknown>
  if (v.v !== 1 || typeof v.bindings !== "object" || v.bindings === null) return NO_OVERRIDES
  const known = new Set(actions.map((a) => a.id))
  const bindings: Record<string, string[]> = {}
  for (const [id, chords] of Object.entries(v.bindings as Record<string, unknown>)) {
    if (!known.has(id) || !Array.isArray(chords)) continue
    const valid = [...new Set(chords.map((c) => parseChord(c as string)).filter((c) => c !== null))]
    bindings[id] = valid.slice(0, MAX_CHORDS_PER_ACTION)
  }
  return { v: 1, bindings }
}

// Resolution ---------------------------------------------------------------

export interface Keymap<Scope extends string = string> {
  /** scope -> chord -> action id */
  readonly lookup: Readonly<Record<Scope, ReadonlyMap<string, string>>>
  /** Effective chords per action id, in display order. */
  readonly chords: Readonly<Record<string, readonly string[]>>
}

export function defaultChords(def: ActionDef, mac = IS_MAC): string[] {
  return [...def.defaults, ...(mac && def.macDefaults ? def.macDefaults : [])]
}

/** Overrides first (they win conflicts), then defaults in registry order. */
export function resolveKeymap<Scope extends string>(
  actions: readonly ActionDef<Scope>[],
  scopes: readonly Scope[],
  overrides: ShortcutOverrides,
  mac = IS_MAC,
): Keymap<Scope> {
  const lookup = Object.fromEntries(scopes.map((s) => [s, new Map<string, string>()])) as Record<
    Scope,
    Map<string, string>
  >
  const chords: Record<string, string[]> = {}
  const claim = (def: ActionDef<Scope>, list: readonly string[]): void => {
    const own: string[] = []
    for (const chord of list) {
      if (lookup[def.scope].has(chord)) continue
      lookup[def.scope].set(chord, def.id)
      own.push(chord)
    }
    chords[def.id] = own
  }
  for (const def of actions) {
    const o = overrides.bindings[def.id]
    if (o) claim(def, o)
  }
  for (const def of actions) {
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
  Insert: "Ins",
}

/** "Mod+Shift+Delete" -> "Ctrl+Shift+Del" (or "⌘⇧Del" on macOS). */
export function formatChord(chord: string, mac = IS_MAC): string {
  const pad = /Num[+\-*]$/.exec(chord)
  const parts = (pad ? chord.slice(0, -pad[0].length).replace(/\+$/, "") : chord)
    .split("+")
    .filter((p) => p !== "")
  const key = pad ? pad[0] : parts.pop()!
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)
  if (mac) {
    const sym: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧" }
    return (
      parts.map((p) => sym[p]).join("") + (name === "Del" ? "⌦" : name === "Backspace" ? "⌫" : name)
    )
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), name].join("+")
}
