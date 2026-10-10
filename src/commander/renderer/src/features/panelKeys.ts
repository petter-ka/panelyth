import { eventChord } from "@panelyth/renderer-core"
import type { KeyboardEvent } from "react"
import { runPanelAction } from "./commands"
import { actionFor } from "./keymap"
import { enter, moveCursor } from "./listing"
import { dropAnchor, extendTo } from "./marks"
import type { Side } from "./panels"
import {
  closeQuickSearch,
  deleteChar,
  isSearchChar,
  nextMatch,
  typeChar,
  useQuickSearch,
} from "./quicksearch"
import { useSettingsStore } from "./settings"

/** How far each fixed key moves the cursor in a view (rows; Brief adds columns). */
export interface ViewGeometry {
  count: number
  cursor: number
  /** PgUp / PgDn. */
  page: number
  /** ← / →: a column of the Brief view; 0 in the Full view (the keys are free). */
  column: number
}

/** Alt+letter in "Alt+letters" mode (Settings → Panels): quick search. */
const isAltSearchChar = (e: KeyboardEvent): boolean =>
  e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1 && e.key !== " "

/**
 * A key in a panel's view, in order: the open quick-search box, the fixed
 * cursor keys (with Shift, marking), Enter, the remappable actions, and
 * letters for quick search. The Full and Brief views share it.
 */
export function onPanelKey(side: Side, e: KeyboardEvent, g: ViewGeometry): void {
  const done = (): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  const altLetters = useSettingsStore.getState().settings.letters === "altLetters"
  const searchChar = (): boolean => (altLetters ? isAltSearchChar(e) : isSearchChar(e))
  // 1. The quick-search box takes its keys first (letters without Alt, once open).
  if (useQuickSearch.getState().side === side) {
    if (isSearchChar(e) || searchChar()) return (done(), typeChar(side, e.key))
    if (e.key === "Backspace") return (done(), deleteChar(side))
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      return (done(), nextMatch(side, e.key === "ArrowUp"))
    }
    closeQuickSearch()
    if (e.key === "Escape") return done()
  }
  // 2. Fixed keys: cursor moves (with Shift, marking), Enter.
  const { cursor, count } = g
  const moves: Record<string, number | undefined> = {
    ArrowDown: cursor + 1,
    ArrowUp: cursor - 1,
    PageDown: cursor + g.page,
    PageUp: cursor - g.page,
    Home: 0,
    End: count - 1,
    ...(g.column > 0 && { ArrowRight: cursor + g.column, ArrowLeft: cursor - g.column }),
  }
  const target = moves[e.key]
  if (target !== undefined && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const to = Math.max(0, Math.min(count - 1, target))
    if (e.shiftKey) extendTo(side, cursor, to)
    else dropAnchor(side)
    moveCursor(side, to)
    return done()
  }
  if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    void enter(side)
    return done()
  }
  // 3. Remappable actions; 4. letters start quick search.
  const chord = eventChord(e.nativeEvent)
  const action = chord ? actionFor("panels", chord) : undefined
  if (action) {
    runPanelAction(side, action)
    return done()
  }
  if (searchChar()) {
    typeChar(side, e.key)
    return done()
  }
}
