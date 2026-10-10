import type { SharedContext } from "@panelyth/contracts"
import { startSwitchSettingsSync, useSwitchSettings } from "@panelyth/renderer-core"
import { startSharedAppearanceSync } from "@panelyth/ui"
import { bridge, canSwitchApps, isBridgeAvailable } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../folder/folderStore"
import { notify } from "../clipboard/clipboard"
import { getItem } from "../tiles/pageStore"
import {
  focusSelectAndReveal,
  selectIndexRanges,
  selectionCount,
  toDescriptor,
  useSelectionStore,
} from "../tiles/selectionStore"

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

/**
 * Theme and interface size, and what carries over on a switch, are shared
 * with the commander through library.db.
 */
export function startAppearanceSync(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  const port = {
    loadSettings: () => bridge.library().then((l) => l.settings),
    saveSetting: (key: string, value: unknown) =>
      void bridge.setSetting(key, value).catch(() => undefined),
    onSettingChanged: (listener: (key: string, value: unknown) => void) =>
      bridge.on("settings.changed", (e) => listener(e.key, e.value)),
  }
  const offAppearance = startSharedAppearanceSync(port)
  const offSwitch = startSwitchSettingsSync(port)
  return () => {
    offAppearance()
    offSwitch()
  }
}

// The shared context, part 1 (Stage C01) ----------------------------------------

/** The newest commander context applied here; older ones are ignored. */
let seenVersion = 0
let visible = true

/**
 * The folder becomes the context; on a switch also the focused tile and a
 * multi-selection (a single selected tile is the focus already; Stage C02).
 */
async function publishContext(onSwitch: boolean): Promise<void> {
  const { folder, query } = useFolderStore.getState()
  if (!folder) return
  const sel = useSelectionStore.getState()
  const focusId = onSwitch ? (getItem(sel.focusIndex)?.id ?? null) : null
  // Omitted when only the folder changed; null on a switch without a multi-selection.
  const selection = !onSwitch
    ? undefined
    : query && selectionCount(sel) > 1
      ? toDescriptor(sel, query.queryId, query.version)
      : null
  await bridge.publishContext(folder.dirId, focusId, selection)
}

/**
 * Shown again: open the commander's folder and select its cursor entry when
 * the viewer can show it (the media session simply doesn't contain other
 * files). Nothing moves when the viewer already shows that folder.
 */
export async function applyCommanderContext(): Promise<void> {
  const ctx = await bridge.getContext().catch(() => null)
  if (ctx && ctx.app === "commander" && ctx.dirId > 0 && ctx.version > seenVersion) {
    seenVersion = ctx.version
    const { carry } = useSwitchSettings.getState()
    const folderChanged = useFolderStore.getState().folder?.dirId !== ctx.dirId
    if (carry.folder && folderChanged) {
      // A folder deleted in between shows the usual "not found" state.
      await openFolderEntry(ctx.dirId)
    }
    if (ctx.focusId !== null && carry.focus && folderChanged) await selectEntry(ctx.focusId)
    if (useFolderStore.getState().folder?.dirId === ctx.dirId) await applySelection(ctx)
  }
  // This app is visible now, so the context names it (the next start opens it).
  if (visible) await publishContext(false).catch(() => undefined)
}

/**
 * The commander's marks become the selection, minus entries the viewer does
 * not show (Go maps them onto this session; Stage C02).
 */
async function applySelection(ctx: SharedContext): Promise<void> {
  if (ctx.selectionTooLarge) {
    notify("The selection is too large to carry over")
    return
  }
  const query = useFolderStore.getState().query
  if (!query || ctx.selectionCount === 0 || !useSwitchSettings.getState().carry.selection) return
  const d = await bridge.contextSelection(ctx.version, query.queryId).catch(() => null)
  if (!d || d.ranges.length === 0 || useFolderStore.getState().query?.queryId !== query.queryId) {
    return
  }
  const first = d.ranges[0]![0]
  const sel = useSelectionStore.getState()
  // The focus stays on the carried cursor entry when it is among the marks.
  const focusIndex = d.ranges.some(([a, b]) => sel.focusIndex >= a && sel.focusIndex < b)
    ? sel.focusIndex
    : first
  selectIndexRanges(d.ranges, {
    anchorIndex: focusIndex,
    focusIndex,
    focusId: getItem(focusIndex)?.id ?? null,
  })
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
