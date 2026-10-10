import { create } from "zustand"
import { bridge } from "../bridge"
import { moveCursor, parentRows, useListingStore } from "./listing"
import type { Side } from "./panels"

// Quick search (Stage C02): letters typed in a panel open a small search box
// and move the cursor to the next name that starts with the text (then to
// one that contains it; "*" and "?" are wildcards). ↓ / ↑ jump between
// matches; Esc closes. Go answers from the session (query.locate), so a
// keystroke costs the same in a 100-entry and a 100k-entry folder.

interface QuickSearchState {
  /** The panel the box is open in, or null. */
  side: Side | null
  text: string
  /** The last search found nothing. */
  missed: boolean
}

export const useQuickSearch = create<QuickSearchState>(() => ({
  side: null,
  text: "",
  missed: false,
}))

const get = useQuickSearch.getState
const set = useQuickSearch.setState
let seq = 0

async function search(side: Side, text: string, fromRow: number, backward: boolean): Promise<void> {
  const p = useListingStore.getState()[side]
  const query = p.query
  if (!query) return
  const n = ++seq
  const parent = parentRows(p)
  const from = Math.max(0, fromRow - parent)
  try {
    const res = await bridge.locate(query.queryId, text, from, backward ? "backward" : "forward")
    if (n !== seq || get().side !== side) return
    if (res.index < 0) {
      set({ missed: true })
      return
    }
    set({ missed: false })
    if (useListingStore.getState()[side].query?.queryId === query.queryId) {
      moveCursor(side, res.index + parent)
    }
  } catch {
    if (n === seq) set({ missed: true })
  }
}

const cursorOf = (side: Side): number => useListingStore.getState()[side].cursor

/** A letter in a panel: opens the box (or extends its text) and searches from the cursor. */
export function typeChar(side: Side, char: string): void {
  const text = get().side === side ? get().text + char : char
  set({ side, text })
  void search(side, text, cursorOf(side), false)
}

export function deleteChar(side: Side): void {
  const text = get().text.slice(0, -1)
  if (text === "") return closeQuickSearch()
  set({ text })
  void search(side, text, cursorOf(side), false)
}

/** ↓ / ↑ in the box: the next or previous match. */
export function nextMatch(side: Side, backward: boolean): void {
  const { text } = get()
  if (text === "") return
  void search(side, text, cursorOf(side) + (backward ? -1 : 1), backward)
}

export function closeQuickSearch(): void {
  seq++
  set({ side: null, text: "", missed: false })
}

/** A printable character that starts or extends quick search (no Ctrl, Alt or Cmd). */
export function isSearchChar(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">,
): boolean {
  return !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1 && e.key !== " "
}
