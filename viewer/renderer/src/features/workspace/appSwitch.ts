import type { SharedContext } from "@fastview/contracts"
import { startSharedAppearanceSync } from "@fastview/ui"
import { bridge, canSwitchApps, isBridgeAvailable } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../folder/folderStore"
import { getItem } from "../tiles/pageStore"
import { focusSelectAndReveal, useSelectionStore } from "../tiles/selectionStore"

/**
 * The connection point to the commander (ADR-0031, docs/shared/APP-SWITCHING.md).
 * The switch exists only while the commander is enabled.
 */
export function switchToCommander(): void {
  if (!canSwitchApps()) return
  void (async () => {
    // The folder and the focused tile carry over (Stage C01).
    await publishContext(true).catch(() => undefined)
    await bridge.switchToCommander()
  })().catch(() => undefined)
}

/** Theme and interface size are shared with the commander through library.db. */
export function startAppearanceSync(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return startSharedAppearanceSync({
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key, value) => void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener) => bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  })
}

// The shared context, part 1 (Stage C01) ----------------------------------------

/** The newest commander context applied here; older ones are ignored. */
let seenVersion = 0
let visible = true

async function publishContext(withFocus: boolean): Promise<void> {
  const folder = useFolderStore.getState().folder
  if (!folder) return
  const focusId = withFocus ? (getItem(useSelectionStore.getState().focusIndex)?.id ?? null) : null
  await bridge.publishContext(folder.dirId, focusId)
}

const isFromCommander = (ctx: SharedContext | null): ctx is SharedContext =>
  ctx !== null && ctx.version > seenVersion && ctx.app === "commander" && ctx.dirId > 0

/**
 * Shown again: open the commander's folder and select its cursor entry when
 * the viewer can show it (the media session simply doesn't contain other
 * files). Nothing moves when the viewer already shows that folder.
 */
export async function applyCommanderContext(): Promise<void> {
  const ctx = await bridge.getContext().catch(() => null)
  if (isFromCommander(ctx)) {
    seenVersion = ctx.version
    if (useFolderStore.getState().folder?.dirId !== ctx.dirId) {
      // A folder deleted in between shows the usual "not found" state.
      await openFolderEntry(ctx.dirId)
      if (ctx.focusId !== null) await selectEntry(ctx.focusId)
      return // the folder change publishes the context
    }
  }
  // This app is visible now, so the context names it (the next start opens it).
  await publishContext(false).catch(() => undefined)
}

async function selectEntry(entryId: number): Promise<void> {
  const query = useFolderStore.getState().query
  if (!query) return
  const at = await bridge.indexOf(query.queryId, entryId).catch(() => null)
  if (at && at.index >= 0 && useFolderStore.getState().query?.queryId === query.queryId) {
    focusSelectAndReveal(at.index, entryId)
  }
}

/** Follows the switch: publish the folder while visible, apply the commander's context when shown. */
export function startContextSync(): () => void {
  if (!canSwitchApps()) return () => undefined
  const offVisibility = bridge.on("app.visibility", ({ app, visible: shown }) => {
    if (app !== "viewer") return
    visible = shown
    if (shown) void applyCommanderContext()
  })
  const offFolder = useFolderStore.subscribe((s, prev) => {
    if (visible && s.folder && s.folder.dirId !== prev.folder?.dirId) {
      void publishContext(false).catch(() => undefined)
    }
  })
  return () => {
    offVisibility()
    offFolder()
  }
}

/** Tests. */
export function resetContextSync(): void {
  seenVersion = 0
  visible = true
}
