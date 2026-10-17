import { startRename, useFilesStore } from "./files"
import { useListingStore } from "./listing"
import { usePanelsStore, type Side } from "./panels"

// Click to rename (as in Explorer and Finder): a click on the name of the
// row that already has the cursor, in the active panel, opens the inline
// editor once no second click followed, so a double-click still opens the
// entry. A drag, a key, another click or a moved cursor cancel it.

/** After the click is released: longer than a double-click takes. */
export const CLICK_RENAME_MS = 500

let pending: { side: Side; row: number; name: Element } | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let stop: (() => void) | null = null

export function cancelClickRename(): void {
  if (timer) clearTimeout(timer)
  timer = null
  pending = null
  stop?.()
  stop = null
}

type Click = Pick<MouseEvent, "button" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey" | "target">

/**
 * A view's mousedown, before the cursor moves to `row`: arms the rename when
 * the click is on the cursor row's name in the active panel.
 */
export function clickRenameDown(side: Side, cursor: number, row: number, e: Click): void {
  cancelClickRename()
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return
  if (row !== cursor || usePanelsStore.getState().active !== side) return
  if (useFilesStore.getState().rename !== null) return
  const p = useListingStore.getState()[side]
  if (p.archive !== null) return
  const name = e.target instanceof Element ? e.target.closest("[data-name]") : null
  if (!name) return
  pending = { side, row, name }
  const onUp = (up: MouseEvent): void => {
    window.removeEventListener("mouseup", onUp, true)
    const armed = pending
    const over = up.target instanceof Element ? up.target.closest("[data-name]") : null
    if (!armed || over !== armed.name) {
      cancelClickRename()
      return
    }
    timer = setTimeout(() => fire(armed), CLICK_RENAME_MS)
  }
  const cancel = (): void => cancelClickRename()
  window.addEventListener("mouseup", onUp, true)
  window.addEventListener("keydown", cancel, true)
  window.addEventListener("dragstart", cancel, true)
  window.addEventListener("wheel", cancel, { capture: true, passive: true })
  stop = () => {
    window.removeEventListener("mouseup", onUp, true)
    window.removeEventListener("keydown", cancel, true)
    window.removeEventListener("dragstart", cancel, true)
    window.removeEventListener("wheel", cancel, true)
  }
}

function fire(armed: { side: Side; row: number }): void {
  cancelClickRename()
  const p = useListingStore.getState()[armed.side]
  if (p.cursor !== armed.row || usePanelsStore.getState().active !== armed.side) return
  if (useFilesStore.getState().rename !== null || p.archive !== null) return
  startRename(armed.side)
}
