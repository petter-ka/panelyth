import { useEffect } from "react"
import { goBack, goForward, goUp, refresh } from "../features/folder/folderStore"
import {
  askDeletePermanently,
  copySelection,
  paste,
  renameSelection,
  trashSelection,
} from "../features/jobs/jobsStore"
import { copySelectionToClipboard } from "../features/clipboard/clipboard"
import { openProperties } from "../features/properties/propertiesStore"
import { actionDef, chordAllowedWhileTyping, eventChord } from "../features/shortcuts/keymap"
import type { ActionId } from "../features/shortcuts/keymap"
import { actionFor, openShortcutHelp } from "../features/shortcuts/shortcutStore"
import { useViewerStore } from "../features/viewer/viewerStore"
import { cyclePaneFocus } from "../features/workspace/paneFocus"

export const SEARCH_INPUT_ID = "folder-search"

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.matches("input, textarea, select")
}

function focusSearch(): void {
  const input = document.getElementById(SEARCH_INPUT_ID)
  if (input instanceof HTMLInputElement) {
    input.focus()
    input.select()
  }
}

/** Handlers for the global scope of the keymap (features/shortcuts/keymap.ts). */
const GLOBAL_HANDLERS: Partial<Record<ActionId, () => unknown>> = {
  "nav.back": goBack,
  "nav.forward": goForward,
  "nav.up": goUp,
  "view.refresh": refresh,
  "search.focus": focusSearch,
  "pane.next": () => cyclePaneFocus(1),
  "pane.previous": () => cyclePaneFocus(-1),
  "edit.cut": () => copySelection("cut"),
  "edit.copy": copySelectionToClipboard,
  "edit.paste": paste,
  "item.rename": renameSelection,
  "item.trash": trashSelection,
  "item.delete": askDeletePermanently,
  "item.properties": openProperties,
  "help.shortcuts": openShortcutHelp,
}

/**
 * Window-level commands, resolved through the user's keymap (Explorer/Finder
 * conventions by default). The viewer, dialogs and menus handle their own
 * keys; text fields keep plain keys such as Backspace and Delete.
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || useViewerStore.getState().open) return
      if (document.querySelector("[role=dialog], [role=menu]")) return
      const chord = eventChord(e)
      if (!chord) return
      const id = actionFor("global", chord)
      const handler = id && GLOBAL_HANDLERS[id]
      if (!handler) return
      if (isTextInput(e.target) && !(actionDef(id).whileTyping && chordAllowedWhileTyping(chord)))
        return
      e.preventDefault()
      void handler()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [])
}
