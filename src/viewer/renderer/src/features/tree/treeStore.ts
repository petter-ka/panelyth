import { createTreeStore, treeNodeKey } from "@panelyth/renderer-core"
import { bridge } from "../../bridge"
import { describeError, useFolderStore } from "../folder/folderStore"
import { useLibraryStore } from "../library/libraryStore"

/**
 * The sidebar folder tree: the viewer's instance of the tree shared with the
 * commander (`createTreeStore`, Stage C10.5). It reads the filesystem
 * (fs.listDirs), not the index, and is lazy: a node's children are listed
 * only when it is expanded, one level at a time, never recursively.
 */
export type { TreeNode, TreeRow } from "@panelyth/renderer-core"

const tree = createTreeStore({ listDirs: (path) => bridge.listDirs(path), describeError })

export const useTreeStore = tree.useStore
export const nodeKey = treeNodeKey
export const getNode = tree.getNode
export const resetTree = tree.reset
export const setRoots = tree.setRoots
export const loadChildren = tree.loadChildren
export const expand = tree.expand
export const collapse = tree.collapse
export const toggle = tree.toggle
export const flatten = tree.flatten
export const reveal = tree.reveal
/** F5 / "Refresh": re-lists an expanded node so new or removed subfolders show. */
export const refreshNode = tree.refreshNode

/** Volumes become roots; every opened folder is revealed. */
export function startTreeMonitoring(): () => void {
  if (useLibraryStore.getState().volumes.length > 0) setRoots(useLibraryStore.getState().volumes)
  const offVolumes = useLibraryStore.subscribe((s, prev) => {
    if (s.volumes !== prev.volumes) setRoots(s.volumes)
  })
  const offFolder = useFolderStore.subscribe((s, prev) => {
    const crumbs = s.folder?.crumbs
    if (crumbs && crumbs !== prev.folder?.crumbs) void reveal(crumbs)
  })
  return () => {
    offVolumes()
    offFolder()
  }
}
