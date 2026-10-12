import { create } from "zustand"
import { bridge } from "../../bridge"
import { useLibraryStore } from "../library/libraryStore"
import {
  formatChord,
  NO_OVERRIDES,
  parseChord,
  parseOverrides,
  resolveKeymap,
  SHORTCUTS_KEY,
  MAX_CHORDS_PER_ACTION,
  type ActionId,
  type Keymap,
  type Scope,
  type ShortcutOverrides,
} from "./keymap"

/** The resolved keymap and the shortcut reference dialog (ADR-0022). */
interface ShortcutState {
  overrides: ShortcutOverrides
  keymap: Keymap
  helpOpen: boolean
}

export const useShortcutStore = create<ShortcutState>(() => ({
  overrides: NO_OVERRIDES,
  keymap: resolveKeymap(NO_OVERRIDES),
  helpOpen: false,
}))

const set = useShortcutStore.setState
const get = useShortcutStore.getState

export function resetShortcutStore(): void {
  set({ overrides: NO_OVERRIDES, keymap: resolveKeymap(NO_OVERRIDES), helpOpen: false }, true)
}

function apply(overrides: ShortcutOverrides): void {
  set({ overrides, keymap: resolveKeymap(overrides) })
}

function persist(): void {
  void bridge.setSetting(SHORTCUTS_KEY, get().overrides).catch(() => undefined)
}

/**
 * Replaces an action's chords (an empty list unbinds it). Invalid chords are
 * dropped; returns false when none of the given chords was valid.
 */
export function setBinding(id: ActionId, chords: readonly string[]): boolean {
  const valid = [...new Set(chords.map(parseChord).filter((c) => c !== null))].slice(
    0,
    MAX_CHORDS_PER_ACTION,
  )
  if (chords.length > 0 && valid.length === 0) return false
  apply({ v: 1, bindings: { ...get().overrides.bindings, [id]: valid } })
  persist()
  return true
}

/** Back to the action's defaults. */
export function resetBinding(id: ActionId): void {
  const bindings = { ...get().overrides.bindings }
  delete bindings[id]
  apply({ v: 1, bindings })
  persist()
}

export function resetAllBindings(): void {
  apply(NO_OVERRIDES)
  persist()
}

export function openShortcutHelp(): void {
  set({ helpOpen: true })
}

export function setShortcutHelpOpen(open: boolean): void {
  set({ helpOpen: open })
}

/** The action bound to a key chord in a scope, if any. */
export function actionFor(scope: Scope, chord: string): ActionId | undefined {
  return get().keymap.lookup[scope].get(chord)
}

/** Display text of an action's first chord, for menus and tooltips. */
export function useShortcutHint(id: ActionId | undefined): string | undefined {
  return useShortcutStore((s) => {
    const first = id ? s.keymap.chords[id][0] : undefined
    return first ? formatChord(first) : undefined
  })
}

/** Applies overrides from library.db once the library loads (start or restart). */
export function startShortcutPersistence(): () => void {
  const load = (settings: Record<string, unknown>): void =>
    apply(parseOverrides(settings[SHORTCUTS_KEY]))
  if (useLibraryStore.getState().loaded) load(useLibraryStore.getState().settings)
  return useLibraryStore.subscribe((s, prev) => {
    if (s.loaded && (!prev.loaded || s.settings !== prev.settings)) load(s.settings)
  })
}
