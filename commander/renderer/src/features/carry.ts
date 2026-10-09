import type { SharedContext } from "@panelyth/contracts"
import { useSwitchSettings } from "@panelyth/renderer-core"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import {
  cursorEntryId,
  isCommanderVisible,
  onActiveFolderChanged,
  openFolderEntry,
  startListingEvents,
  useListingStore,
} from "./listing"
import { applyMarks, marksDescriptor, useMarksStore } from "./marks"
import { usePanelsStore, type Side } from "./panels"
import { restorePanels } from "./session"

// The shared context (docs/shared/APP-SWITCHING.md): the folder, the entry
// under the cursor (Stage C01) and the marks (Stage C02) carry over between
// the apps, each part as Settings → General allows.

/** The newest context this app has applied or published; older ones are ignored. */
let seenVersion = 0

/** A short message in the status bar (the too-large-selection notice). */
export const useCarryNotice = create<{ message: string | null }>(() => ({ message: null }))
let noticeTimer: ReturnType<typeof setTimeout> | null = null
function notice(message: string): void {
  useCarryNotice.setState({ message })
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => useCarryNotice.setState({ message: null }), 6000)
}

const isFromViewer = (ctx: SharedContext): boolean =>
  ctx.version > seenVersion && ctx.app === "viewer" && ctx.dirId > 0

/**
 * The active panel's folder becomes the context; on a switch also the entry
 * under the cursor and the marks.
 */
export async function publishContext(onSwitch: boolean): Promise<void> {
  const side = usePanelsStore.getState().active
  const { dirId, archive } = useListingStore.getState()[side]
  if (dirId === null) return
  // Inside an archive: its folder, with the archive file as the focus
  // (entries in archives are not files the viewer can show).
  if (archive) {
    await bridge.publishContext(
      dirId,
      onSwitch ? archive.entryId : null,
      onSwitch ? null : undefined,
    )
    return
  }
  await bridge.publishContext(
    dirId,
    onSwitch ? cursorEntryId(side) : null,
    onSwitch ? marksDescriptor(side) : undefined,
  )
}

/** The carried selection becomes the panel's marks (entries it lists, at most 10,000). */
async function applySelection(side: Side, ctx: SharedContext): Promise<void> {
  if (ctx.selectionTooLarge) {
    notice("The selection is too large to carry over")
    return
  }
  const query = useListingStore.getState()[side].query
  if (!query || ctx.selectionCount === 0 || !useSwitchSettings.getState().carry.selection) return
  const before = useMarksStore.getState()[side]
  const d = await bridge.contextSelection(ctx.version, query.queryId).catch(() => null)
  // Keys changed the marks while Go resolved the selection: the user's
  // marks win over the carried ones.
  if (d && useMarksStore.getState()[side] === before) applyMarks(side, d)
}

/**
 * Shown again: the active panel opens the viewer's folder with the cursor on
 * its selected tile, and the viewer's selection becomes its marks. Nothing
 * moves when the panel already shows that folder; the marks still carry.
 */
export async function applyContext(): Promise<void> {
  const ctx = await bridge.getContext().catch(() => null)
  const side = usePanelsStore.getState().active
  if (ctx && isFromViewer(ctx)) {
    seenVersion = ctx.version
    const { carry } = useSwitchSettings.getState()
    if (carry.folder && useListingStore.getState()[side].dirId !== ctx.dirId) {
      // Publishes itself once the folder is open (onActiveFolderChanged).
      await openFolderEntry(side, ctx.dirId, { focusId: carry.focus ? ctx.focusId : null })
    }
    if (useListingStore.getState()[side].dirId === ctx.dirId) await applySelection(side, ctx)
  }
  // This app is visible now, so the context names it (the next start opens it).
  await publishContext(false).catch(() => undefined)
}

/** The switch: publish the active panel's folder, cursor entry and marks, then show the viewer. */
export async function switchToViewer(): Promise<void> {
  await publishContext(true).catch(() => undefined)
  await bridge.switchTo("viewer")
}

/** Opens one panel media entry in the viewer's focused media surface. */
export async function openMediaInViewer(
  entryId: number,
  side: Side = usePanelsStore.getState().active,
): Promise<boolean> {
  const panel = useListingStore.getState()[side]
  if (panel.dirId === null || panel.archive) return false

  // Branch and search rows may be outside the panel's current folder. The
  // viewer needs the media's containing folder as its query context.
  const dirId =
    panel.branch || panel.find ? (await bridge.openContaining(entryId)).dirId : panel.dirId
  const selection = panel.branch || panel.find ? null : marksDescriptor(side)
  await bridge.publishContext(dirId, entryId, selection)
  await bridge.switchTo("viewer", { openMedia: true })
  return true
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
  const carry = useSwitchSettings.getState().carry
  const carried = ctx && isFromViewer(ctx) && carry.folder ? ctx : null
  if (ctx && isFromViewer(ctx)) seenVersion = ctx.version
  // The active panel publishes the context once its folder is open.
  await restorePanels(
    carried && { dirId: carried.dirId, focusId: carry.focus ? carried.focusId : null },
  )
  if (carried) await applySelection(usePanelsStore.getState().active, carried)
  return () => {
    offEvents()
    offFolder()
    offActive()
  }
}

/** Tests. */
export function resetCarry(): void {
  seenVersion = 0
  useCarryNotice.setState({ message: null })
}
