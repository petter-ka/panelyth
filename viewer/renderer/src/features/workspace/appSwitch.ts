import type { SharedContext } from "@panelyth/contracts"
import { startSwitchSettingsSync, useSwitchSettings } from "@panelyth/renderer-core"
import { startSharedAppearanceSync } from "@panelyth/ui"
import { bridge, canSwitchApps, isBridgeAvailable } from "../../bridge"
import { openFolderEntry, useFolderStore } from "../folder/folderStore"
import { notify } from "../clipboard/clipboard"
import { ensureIndex, getItem } from "../tiles/pageStore"
import {
  focusSelectAndReveal,
  selectIndexRanges,
  selectionCount,
  toDescriptor,
  useSelectionStore,
} from "../tiles/selectionStore"
import {
  closeVideoFullscreen,
  stageVideoInPane,
  startStagedPlayback,
  stopPreviewPlayback,
  usePreviewStore,
} from "../preview/previewStore"
import { closeViewer, openViewerAt, useViewerStore } from "../viewer/viewerStore"

interface MediaReturnState {
  kind: "image" | "video"
  entryId: number
}

let mediaReturn: MediaReturnState | null = null

function returnToCommanderAfterMedia(): void {
  if (!mediaReturn) return
  mediaReturn = null
  stopPreviewPlayback()
  switchToCommander()
}

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
export async function applyCommanderContext(
  openMedia = false,
  publishVisibleContext = true,
): Promise<boolean> {
  const ctx = await bridge.getContext().catch(() => null)
  let preparedMedia = false
  if (ctx && ctx.app === "commander" && ctx.dirId > 0 && (ctx.version > seenVersion || openMedia)) {
    seenVersion = Math.max(seenVersion, ctx.version)
    const { carry } = useSwitchSettings.getState()
    if ((carry.folder || openMedia) && useFolderStore.getState().folder?.dirId !== ctx.dirId) {
      // A folder deleted in between shows the usual "not found" state.
      await openFolderEntry(ctx.dirId)
    }
    if (ctx.focusId !== null && (carry.focus || openMedia)) await selectEntry(ctx.focusId)
    if (useFolderStore.getState().folder?.dirId === ctx.dirId) await applySelection(ctx)
    if (openMedia && ctx.focusId !== null)
      preparedMedia = await openContextMedia(ctx.dirId, ctx.focusId)
  }
  // This app is visible now, so the context names it (the next start opens it).
  if (publishVisibleContext && visible) await publishContext(false).catch(() => undefined)
  return preparedMedia
}

async function openContextMedia(dirId: number, entryId: number): Promise<boolean> {
  if (useFolderStore.getState().folder?.dirId !== dirId) return false
  const query = useFolderStore.getState().query
  if (!query) return false
  const at = await bridge.indexOf(query.queryId, entryId).catch(() => null)
  if (!at || at.index < 0 || useFolderStore.getState().query?.queryId !== query.queryId)
    return false
  const item = await ensureIndex(at.index).catch(() => undefined)
  if (
    useFolderStore.getState().folder?.dirId !== dirId ||
    !item ||
    item.id !== entryId ||
    (item.kind !== "image" && item.kind !== "video")
  )
    return false

  // A previous Viewer session may have left another media surface mounted.
  mediaReturn = null
  closeViewer()
  stopPreviewPlayback()
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined)

  const launch: MediaReturnState = { kind: item.kind, entryId }
  const opened = item.kind === "image" ? openViewerAt(at.index) : stageVideoInPane(at.index)
  if (opened) mediaReturn = launch
  return opened
}

function waitForStagedMediaSurface(): Promise<boolean> {
  if (!mediaReturn) return Promise.resolve(false)
  const { entryId, kind } = mediaReturn
  const selector =
    kind === "image"
      ? `[data-testid="viewer"][data-entry-id="${entryId}"]`
      : `[data-testid="video-fullscreen-overlay"][data-entry-id="${entryId}"]`
  const ready = (): boolean => document.querySelector(selector) !== null
  if (ready()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      if (ready()) finish(true)
    })
    const timeout = setTimeout(() => finish(false), 8_000)
    const finish = (result: boolean): void => {
      clearTimeout(timeout)
      observer.disconnect()
      resolve(result)
    }
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-entry-id"],
    })
  })
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
  const offMediaLaunch = bridge.on("app.mediaLaunch", ({ requestId }) => {
    void (async () => {
      let ready = false
      try {
        ready = await applyCommanderContext(true, false)
        if (ready) ready = await waitForStagedMediaSurface()
      } catch {
        ready = false
      }
      await bridge.reportMediaReady(requestId, ready).catch(() => undefined)
    })()
  })
  const offVisibility = bridge.on("app.visibility", ({ app, visible: shown, openMedia }) => {
    if (app !== "viewer") return
    visible = shown
    if (shown) {
      startStagedPlayback()
      void applyCommanderContext(openMedia === true)
        .catch(() => false)
        .then(() => startStagedPlayback())
    } else {
      if (mediaReturn?.kind === "video") {
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined)
        stopPreviewPlayback()
      }
      mediaReturn = null
    }
  })
  const offViewer = useViewerStore.subscribe((s, prev) => {
    if (mediaReturn?.kind === "image" && prev.open && !s.open) {
      // Let closeViewer finish updating the focused tile before publishing it.
      queueMicrotask(returnToCommanderAfterMedia)
    }
  })
  const offPreview = usePreviewStore.subscribe((s, prev) => {
    if (mediaReturn?.kind === "video" && prev.play?.fullscreen && s.play?.fullscreen === false) {
      returnToCommanderAfterMedia()
    }
  })
  const onKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key === "Escape" &&
      mediaReturn?.kind === "video" &&
      usePreviewStore.getState().play?.fullscreen
    ) {
      event.preventDefault()
      event.stopImmediatePropagation()
      if (document.fullscreenElement) {
        void document
          .exitFullscreen()
          .catch(() => undefined)
          .finally(closeVideoFullscreen)
      } else closeVideoFullscreen()
    }
  }
  window.addEventListener("keydown", onKeyDown, true)
  const offFolder = useFolderStore.subscribe((s, prev) => {
    if (visible && s.folder && s.folder.dirId !== prev.folder?.dirId) {
      void publishContext(false).catch(() => undefined)
    }
  })
  return () => {
    offVisibility()
    offMediaLaunch()
    offViewer()
    offPreview()
    window.removeEventListener("keydown", onKeyDown, true)
    mediaReturn = null
    offFolder()
  }
}

/** Tests. */
export function resetContextSync(): void {
  seenVersion = 0
  visible = true
  mediaReturn = null
}
