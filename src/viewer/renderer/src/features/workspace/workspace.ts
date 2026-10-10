import { create } from "zustand"
import { bridge } from "../../bridge"
import { restoreSort, useFolderStore } from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"
import { useLayoutStore } from "../tiles/layoutStore"
import {
  initialWorkspace,
  parseWorkspace,
  readMirror,
  WORKSPACE_KEY,
  writeMirror,
  type PreviewPlace,
  type Workspace,
} from "./mirror"

/** Pane layout lives here; tile size and sort live in their own stores. */
interface PaneState {
  panes: Record<string, number> | null
  previewPlace: PreviewPlace
  /** Increments when a layout from library.db must be pushed into the panel group. */
  applyToken: number
}

export const usePaneStore = create<PaneState>(() => ({
  panes: initialWorkspace.panes,
  previewPlace: initialWorkspace.previewPlace,
  applyToken: 0,
}))

/** The switch in the sidebar header: the preview under the tree, or as a column on the right. */
export function setPreviewPlace(previewPlace: PreviewPlace): void {
  if (usePaneStore.getState().previewPlace !== previewPlace) usePaneStore.setState({ previewPlace })
}

/** Called by the panel group after a user resize (pointer released). */
export function setPanes(panes: Record<string, number>): void {
  usePaneStore.setState({ panes })
}

const SAVE_DELAY_MS = 300

/**
 * Keeps the workspace in library.db (source of truth) and the localStorage
 * mirror (first paint). The mirror is written on every change, library.db
 * debounced and flushed when the page goes away. On startup the newer copy
 * wins, so a change made just before quitting is never lost. Returns an
 * unsubscribe function.
 */
export function startWorkspacePersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null
  let at = initialWorkspace.at
  let applied = false

  const current = (): Workspace => ({
    v: 1,
    panes: usePaneStore.getState().panes,
    previewPlace: usePaneStore.getState().previewPlace,
    tileSize: useLayoutStore.getState().tileSize,
    sort: useFolderStore.getState().sort,
    at,
  })
  const save = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    void bridge.setSetting(WORKSPACE_KEY, current()).catch(() => undefined)
  }
  const schedule = (): void => {
    if (!applied) return // library.db's copy is applied first
    if (timer) clearTimeout(timer)
    timer = setTimeout(save, SAVE_DELAY_MS)
  }
  const changed = (): void => {
    at = Date.now()
    writeMirror(current())
    schedule()
  }

  const applyStored = (settings: Record<string, unknown>): void => {
    applied = true
    const stored = parseWorkspace(settings[WORKSPACE_KEY])
    if (!stored || stored.at < readMirror().at) {
      schedule() // first run, or library.db missed the last save: push the mirror
      return
    }
    if (stored.tileSize !== useLayoutStore.getState().tileSize) {
      useLayoutStore.getState().setTileSize(stored.tileSize)
    }
    if (JSON.stringify(stored.sort) !== JSON.stringify(useFolderStore.getState().sort)) {
      restoreSort(stored.sort)
    }
    const now = usePaneStore.getState()
    if (
      JSON.stringify(stored.panes) !== JSON.stringify(now.panes) ||
      stored.previewPlace !== now.previewPlace
    ) {
      usePaneStore.setState((s) => ({
        panes: stored.panes,
        previewPlace: stored.previewPlace,
        applyToken: s.applyToken + 1,
      }))
    }
    at = stored.at // the store updates above are not user changes
    writeMirror(stored)
  }

  // Store updates made while applying library.db must not count as changes.
  let applying = false
  const onChange = (): void => {
    if (!applying) changed()
  }
  const apply = (settings: Record<string, unknown>): void => {
    applying = true
    try {
      applyStored(settings)
    } finally {
      applying = false
    }
  }

  const flush = (): void => {
    if (timer) save()
  }
  window.addEventListener("pagehide", flush)

  if (useLibraryStore.getState().loaded) apply(useLibraryStore.getState().settings)
  const unsubs = [
    useLibraryStore.subscribe((s, prev) => {
      if (s.loaded && !prev.loaded) apply(s.settings)
    }),
    useLayoutStore.subscribe((s, prev) => {
      if (s.tileSize !== prev.tileSize) onChange()
    }),
    useFolderStore.subscribe((s, prev) => {
      if (s.sort !== prev.sort) onChange()
    }),
    usePaneStore.subscribe((s, prev) => {
      if (s.panes !== prev.panes || s.previewPlace !== prev.previewPlace) onChange()
    }),
  ]
  return () => {
    window.removeEventListener("pagehide", flush)
    flush()
    unsubs.forEach((u) => u())
  }
}
