import type { SelectionDescriptor } from "@panelyth/contracts"
import { create } from "zustand"
import { useFolderStore } from "../folder/folderStore"
import { getItem } from "../tiles/pageStore"
import { selectionCount, toDescriptor, useSelectionStore } from "../tiles/selectionStore"

export type PropertiesTarget =
  | { kind: "entry"; id: number }
  | { kind: "selection"; selection: SelectionDescriptor; count: number }

interface PropertiesState {
  target: PropertiesTarget | null
}

export const usePropertiesStore = create<PropertiesState>(() => ({ target: null }))

/** The single selected entry id, if exactly one entry is selected. */
export function singleSelectedId(): number | null {
  const s = useSelectionStore.getState()
  if (selectionCount(s) !== 1) return null
  const [included] = s.include.keys()
  if (included !== undefined) return included
  const range = s.ranges[0]
  return range ? (getItem(range[0])?.id ?? null) : null
}

/** Opens properties for the selection (Alt+Enter, context menu). */
export function openProperties(): void {
  const id = singleSelectedId()
  if (id !== null) {
    usePropertiesStore.setState({ target: { kind: "entry", id } })
    return
  }
  const query = useFolderStore.getState().query
  const sel = useSelectionStore.getState()
  const count = selectionCount(sel)
  if (!query || count === 0) return
  usePropertiesStore.setState({
    target: {
      kind: "selection",
      selection: toDescriptor(sel, query.queryId, query.version),
      count,
    },
  })
}

export function openEntryProperties(id: number): void {
  usePropertiesStore.setState({ target: { kind: "entry", id } })
}

export function closeProperties(): void {
  usePropertiesStore.setState({ target: null })
}
