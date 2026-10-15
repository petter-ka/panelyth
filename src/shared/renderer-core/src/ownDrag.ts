// Dragging files to other apps (ADR-0040). A view cancels the page's own drag
// and main starts the OS's drag with the files' paths, so Slack, the desktop
// or a mail draft take the files. A drop back on the same view then carries
// only those files, which the page gets no paths for (and must not), so what
// was dragged is kept here until the drag is over.

let dragged: unknown = null
let stop: (() => void) | null = null

/** The OS drag of `payload` (a panel, a selection) starts; a drop on this view reads it back. */
export function beginOwnDrag(payload: unknown): void {
  endOwnDrag()
  dragged = payload
  // The drag is over once the pointer moves with no button held, presses
  // again, or the window loses the focus (another app's drag starts there).
  // Ending early is safe: a drop it misses does nothing.
  const onMove = (e: PointerEvent): void => {
    if (e.buttons === 0) endOwnDrag()
  }
  const onEnd = (): void => endOwnDrag()
  window.addEventListener("pointermove", onMove, true)
  window.addEventListener("pointerdown", onEnd, true)
  window.addEventListener("blur", onEnd)
  stop = () => {
    window.removeEventListener("pointermove", onMove, true)
    window.removeEventListener("pointerdown", onEnd, true)
    window.removeEventListener("blur", onEnd)
  }
}

/** The drag is over (a drop took it, or main could not start it). */
export function endOwnDrag(): void {
  dragged = null
  stop?.()
  stop = null
}

/** What this view is dragging, when `data` is that drag (files over this view); else null. */
export function ownDrag<T>(data: DataTransfer | null | undefined): T | null {
  if (dragged === null || !data || !Array.from(data.types).includes("Files")) return null
  return dragged as T
}
