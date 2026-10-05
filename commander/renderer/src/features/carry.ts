import type { SharedContext } from "@fastview/contracts"
import { bridge, isBridgeAvailable } from "../bridge"
import {
  cursorEntryId,
  isCommanderVisible,
  onActiveFolderChanged,
  openFolderEntry,
  restorePanels,
  startListingEvents,
  useListingStore,
} from "./listing"
import { usePanelsStore } from "./panels"

// The shared context, part 1 (Stage C01, docs/shared/APP-SWITCHING.md): the
// folder and the entry under the cursor carry over between the apps.

/** The newest context this app has applied or published; older ones are ignored. */
let seenVersion = 0

const isFromViewer = (ctx: SharedContext): boolean =>
  ctx.version > seenVersion && ctx.app === "viewer" && ctx.dirId > 0

/** The active panel's folder (and, on a switch, the cursor entry) becomes the context. */
export async function publishContext(withFocus: boolean): Promise<void> {
  const side = usePanelsStore.getState().active
  const { dirId } = useListingStore.getState()[side]
  if (dirId === null) return
  await bridge.publishContext(dirId, withFocus ? cursorEntryId(side) : null)
}

/**
 * Shown again: the active panel opens the viewer's folder with the cursor on
 * its selected tile, unless it already shows that folder (then nothing moves).
 */
export async function applyContext(): Promise<void> {
  const ctx = await bridge.getContext().catch(() => null)
  const side = usePanelsStore.getState().active
  if (ctx && isFromViewer(ctx)) {
    seenVersion = ctx.version
    if (useListingStore.getState()[side].dirId !== ctx.dirId) {
      // Publishes itself once the folder is open (onActiveFolderChanged).
      return openFolderEntry(side, ctx.dirId, { focusId: ctx.focusId })
    }
  }
  // This app is visible now, so the context names it (the next start opens it).
  await publishContext(false).catch(() => undefined)
}

/** The switch: publish the active panel's folder and cursor entry, then show the viewer. */
export async function switchToViewer(): Promise<void> {
  await publishContext(true).catch(() => undefined)
  await bridge.switchTo("viewer")
}

/**
 * Start: read the context first, so a folder carried over from the viewer
 * opens directly instead of after the persisted one; then follow events.
 */
export async function startPanels(): Promise<() => void> {
  if (!isBridgeAvailable()) return () => undefined
  const offEvents = startListingEvents(() => void applyContext())
  const offFolder = onActiveFolderChanged(() => {
    if (isCommanderVisible()) void publishContext(false).catch(() => undefined)
  })
  const offActive = usePanelsStore.subscribe((s, prev) => {
    if (s.active !== prev.active && isCommanderVisible()) {
      void publishContext(false).catch(() => undefined)
    }
  })
  const ctx = await bridge.getContext().catch(() => null)
  const carried = ctx && isFromViewer(ctx) ? ctx : null
  if (carried) seenVersion = carried.version
  // The active panel publishes the context once its folder is open.
  await restorePanels(carried && { dirId: carried.dirId, focusId: carried.focusId })
  return () => {
    offEvents()
    offFolder()
    offActive()
  }
}

/** Tests. */
export function resetCarry(): void {
  seenVersion = 0
}
