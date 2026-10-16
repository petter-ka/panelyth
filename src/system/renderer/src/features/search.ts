import type { ContentItem, FindProgress } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

/**
 * Searching several volumes at once (ADR-0042): the commander's find engine
 * on the volumes ticked, by name only. What is typed is plain text: it matches
 * anywhere in a name, its words in the order typed, as the commander's quick
 * filter does. Results arrive in a query session, paged as the list scrolls.
 */

export type SearchStatus = "idle" | "running" | "done" | "stopped" | "failed"

/** Results are read this many at a time, as the list scrolls to them. */
export const PAGE = 200

interface SearchState {
  text: string
  /** The volumes (their paths) to search; empty until the volumes are known. */
  roots: string[]
  status: SearchStatus
  findId: number | null
  queryId: number | null
  version: number
  total: number
  progress: FindProgress | null
  error: string | null
  /** Pages of the current version, by index. */
  pages: ReadonlyMap<number, ContentItem[]>
}

const initial = (): SearchState => ({
  text: "",
  roots: [],
  status: "idle",
  findId: null,
  queryId: null,
  version: 0,
  total: 0,
  progress: null,
  error: null,
  pages: new Map(),
})

export const useSearchStore = create<SearchState>(initial)

/** The name mask of what was typed: "my file" is "*my*file*"; a mask typed on purpose is kept. */
export function searchMask(text: string): string {
  const value = text.trim()
  if (value === "" || /[*?;|]/.test(value)) return value
  return `*${value.split(/\s+/).join("*")}*`
}

export const setSearchText = (text: string): void => useSearchStore.setState({ text })

export function toggleRoot(path: string): void {
  const { roots } = useSearchStore.getState()
  useSearchStore.setState({
    roots: roots.includes(path) ? roots.filter((r) => r !== path) : [...roots, path],
  })
}

/** The volumes chosen by default: every one that answers, the first time they are known. */
export function chooseRootsOnce(paths: readonly string[]): void {
  const s = useSearchStore.getState()
  if (s.roots.length === 0 && s.status === "idle" && paths.length > 0) {
    useSearchStore.setState({ roots: [...paths] })
  }
}

async function forgetPrevious(): Promise<void> {
  const { findId, queryId, status } = useSearchStore.getState()
  if (findId !== null && status === "running")
    await bridge.cancelFind(findId).catch(() => undefined)
  if (queryId !== null) await bridge.closeQuery(queryId).catch(() => undefined)
}

export async function startSearch(): Promise<void> {
  const { text, roots } = useSearchStore.getState()
  const mask = searchMask(text)
  if (mask === "" || roots.length === 0) return
  await forgetPrevious()
  useSearchStore.setState({
    status: "running",
    findId: null,
    queryId: null,
    version: 0,
    total: 0,
    progress: null,
    error: null,
    pages: new Map(),
  })
  try {
    const started = await bridge.startFind({
      roots,
      mask,
      depth: -1,
      hidden: false,
      text: "",
      caseSensitive: false,
      wholeWords: false,
      encodings: [],
      skipBinary: true,
      minSize: null,
      maxSize: null,
      modifiedAfter: null,
      modifiedBefore: null,
      attrsSet: 0,
      attrsClear: 0,
    })
    useSearchStore.setState({
      findId: started.findId,
      queryId: started.queryId,
      version: started.version,
      total: started.total,
    })
  } catch (error) {
    useSearchStore.setState({
      status: "failed",
      error: error instanceof Error ? error.message : t("The search couldn't start."),
    })
  }
}

export function stopSearch(): void {
  const { findId, status } = useSearchStore.getState()
  if (findId === null || status !== "running") return
  useSearchStore.setState({ status: "stopped" })
  void bridge.cancelFind(findId).catch(() => undefined)
}

/** Reads a page of results unless it is in, for the version on screen. */
export async function loadPage(index: number): Promise<void> {
  const { queryId, version, pages } = useSearchStore.getState()
  if (queryId === null || pages.has(index)) return
  const page = await bridge.page(queryId, index * PAGE, PAGE).catch(() => null)
  const now = useSearchStore.getState()
  if (!page || now.queryId !== queryId || page.version < version) return
  const next = new Map(now.version === page.version ? now.pages : [])
  next.set(index, page.items)
  useSearchStore.setState({ pages: next, version: page.version, total: page.total })
}

/**
 * Shows a found file in the commander (ADR-0042): its folder and the file
 * become the shared context, then the commander comes to the front and opens
 * the folder with the cursor on it.
 */
export async function showInCommander(item: ContentItem): Promise<void> {
  const folder = await bridge.containingFolder(item.id)
  await bridge.publishContext(folder.dirId, item.id)
  await bridge.switchTo("commander")
}

/** Follows the search: its progress and the results arriving. */
export function startSearchEvents(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  const offProgress = bridge.on("find.progress", (progress) => {
    const s = useSearchStore.getState()
    if (progress.findId !== s.findId) return
    const status: SearchStatus =
      progress.state === "running"
        ? s.status
        : progress.state === "completed"
          ? "done"
          : progress.state === "cancelled"
            ? "stopped"
            : "failed"
    useSearchStore.setState({ progress, status })
  })
  const offResults = bridge.on("query.invalidated", (snapshot) => {
    const s = useSearchStore.getState()
    if (snapshot.queryId !== s.queryId || snapshot.version <= s.version) return
    // New results: the pages read before belong to the old version.
    useSearchStore.setState({ version: snapshot.version, total: snapshot.total, pages: new Map() })
  })
  return () => {
    offProgress()
    offResults()
  }
}

/** Tests. */
export function resetSearch(): void {
  useSearchStore.setState(initial())
}
