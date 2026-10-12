import { isAbsolute, resolve } from "node:path"
import type {
  ContentItem,
  EntryFromPathResult,
  OpenRequest,
  QueryDescriptor,
  SidecarMethodMap,
} from "@panelyth/contracts"

// "Open with" (ADR-0033 amended): a picture or video the OS handed to the
// app, by a double-click in the file manager or as an argument. It opens in a
// full-screen media window of its own, and the main window is not created
// until the user asks for it. The path comes from the OS and goes from main
// to the sidecar; no renderer ever names one.

/**
 * The file an argument list names: the first argument that is not a switch
 * and is an existing file. `argv[0]` is the program; an unpackaged run also
 * names the app's folder, which is no file. `skip` are paths that are the
 * app's own (its entry script).
 */
export function fileArgument(
  argv: readonly string[],
  cwd: string,
  isFile: (path: string) => boolean,
  skip: readonly string[] = [],
): string | null {
  const own = new Set(skip.map((p) => resolve(p).toLowerCase()))
  for (const arg of argv.slice(1)) {
    if (arg === "" || arg.startsWith("-")) continue
    const path = isAbsolute(arg) ? resolve(arg) : resolve(cwd, arg)
    if (own.has(path.toLowerCase())) continue
    if (isFile(path)) return path
  }
  return null
}

type Call = <
  M extends "entry.fromPath" | "query.open" | "query.indexOf" | "query.page" | "query.close",
>(
  method: M,
  params: SidecarMethodMap[M]["params"],
) => Promise<SidecarMethodMap[M]["result"]>

/** The folder's pictures and videos by name, as the viewer lists them by default. */
const descriptor = (dirId: number, showHidden: boolean): QueryDescriptor => ({
  dirId,
  recursive: false,
  sort: [{ field: "name", direction: "asc" }],
  kinds: ["image", "video"],
  search: "",
  exts: [],
  favorite: false,
  minRating: 0,
  tags: [],
  scope: "media",
  showHidden,
})

interface Opened extends EntryFromPathResult {
  queryId: number
}

/**
 * A large folder is still being listed when its window opens (the sidecar
 * says so). A step that then finds no neighbour within this time of opening
 * asks once more after a moment, so the first "next" is not lost to a
 * listing that was on its way.
 */
export const LISTING_GRACE_MS = 5000
export const LISTING_RETRY_MS = 300

/**
 * The items of one media window opened for a file from the OS. The sidecar
 * indexes the file at once and lists its folder behind it; previous and next
 * come from a session over that folder, which follows the listing as it
 * arrives. Nothing here waits for the folder to be listed.
 */
export class OpenWithSession {
  private opened: Promise<Opened> | null = null
  private currentId: number | null = null
  private dirId: number | null = null
  private closed = false
  private openedAt = 0

  constructor(
    private readonly call: Call,
    private readonly path: string,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  private async open(): Promise<Opened> {
    const entry = await this.call("entry.fromPath", { path: this.path })
    let query = await this.call("query.open", descriptor(entry.dirId, false))
    // A hidden file is not in the usual listing: then the listing with hidden files.
    const at = await this.call("query.indexOf", { queryId: query.queryId, entryId: entry.entryId })
    if (at.index < 0) {
      void this.call("query.close", { queryId: query.queryId }).catch(() => undefined)
      query = await this.call("query.open", descriptor(entry.dirId, true))
    }
    this.dirId = entry.dirId
    this.openedAt = this.now()
    this.currentId ??= entry.entryId
    const opened = { ...entry, queryId: query.queryId }
    if (this.closed)
      void this.call("query.close", { queryId: query.queryId }).catch(() => undefined)
    return opened
  }

  /** 0: the file itself; -1 / 1: its neighbour in the folder; null at either end. */
  async step(direction: -1 | 0 | 1): Promise<ContentItem | null> {
    if (this.closed) return null
    const s = await (this.opened ??= this.open())
    let item = await this.at(s, direction)
    // Only while a large folder's listing is under way: at the end of a
    // listed folder the answer is "none" at once.
    const listing = !s.listed && this.now() - this.openedAt < LISTING_GRACE_MS
    if (!item && direction !== 0 && listing) {
      await this.sleep(LISTING_RETRY_MS)
      if (!this.closed) item = await this.at(s, direction)
    }
    if (item) this.currentId = item.id
    return item
  }

  /** The item `direction` away from the current one in the session as it is now. */
  private async at(s: Opened, direction: -1 | 0 | 1): Promise<ContentItem | null> {
    const entryId = this.currentId ?? s.entryId
    const at = await this.call("query.indexOf", { queryId: s.queryId, entryId })
    if (at.index < 0) return null
    const index = at.index + direction
    if (index < 0) return null
    const page = await this.call("query.page", {
      queryId: s.queryId,
      offset: index,
      limit: 1,
      thumbProfile: null,
    })
    return page.items[0] ?? null
  }

  /** The folder and the item now shown, once the first item was found. */
  current(): OpenRequest | null {
    return this.dirId !== null && this.currentId !== null
      ? { dirId: this.dirId, entryId: this.currentId }
      : null
  }

  /** The window closed: its session goes. */
  close(): void {
    if (this.closed) return
    this.closed = true
    void this.opened
      ?.then((s) => this.call("query.close", { queryId: s.queryId }))
      .catch(() => undefined)
  }
}
