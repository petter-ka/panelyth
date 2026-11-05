import { isAbsolute, resolve } from "node:path"
import type {
  ContentItem,
  EntryFromPathResult,
  JobSnapshot,
  MediaWindowCommand,
  MediaWindowCommandResult,
  MediaWindowStep,
  OpenRequest,
  QueryDescriptor,
  SelectionDescriptor,
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
  M extends
    | "entry.fromPath"
    | "query.open"
    | "query.indexOf"
    | "query.page"
    | "query.close"
    | "clip.set"
    | "clip.paste"
    | "fs.canTrash"
    | "jobs.start"
    | "jobs.list",
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
 * No app is behind this window to show a job's progress or its failure, and
 * the app ends with the window, which cancels what still runs: a file key
 * waits for its job. A delete is short and the window may close right after
 * it. After these times the window goes on and the job runs behind it (one
 * queued behind a large copy of a running app, a big file pasted).
 */
export const DELETE_WAIT_MS = 5000
export const PASTE_WAIT_MS = 1000
export const JOB_POLL_MS = 25

const JOB_ENDED: ReadonlySet<JobSnapshot["state"]> = new Set(["completed", "cancelled", "failed"])

const jobWentWrong = (job: JobSnapshot): boolean => job.state !== "completed" || job.failed > 0

/**
 * The items of one media window opened for a file from the OS. The sidecar
 * indexes the file at once and lists its folder behind it; previous and next
 * come from a session over that folder, which follows the listing as it
 * arrives. Nothing here waits for the folder to be listed.
 *
 * It also carries out the window's file keys: there is no opener to do that.
 */
export class OpenWithSession {
  private opened: Promise<Opened> | null = null
  private currentId: number | null = null
  private shown: ContentItem | null = null
  private dirId: number | null = null
  private closed = false
  private openedAt = 0

  constructor(
    private readonly call: Call,
    private readonly path: string,
    /** Puts an indexed picture on the OS clipboard. */
    private readonly copyImage: (entryId: number) => Promise<unknown>,
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

  /** 0: the file itself; -1 / 1: its neighbour in the folder, null at either end; "first" / "last": the folder's. */
  async step(direction: MediaWindowStep): Promise<ContentItem | null> {
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
    if (item) this.show(item)
    return item
  }

  private show(item: ContentItem): void {
    this.currentId = item.id
    this.shown = item
  }

  /**
   * A file key, on the file shown (ADR-0033 amended): the file clipboard, and
   * a picture on the OS clipboard too (as Ctrl+C in the viewer), a paste into
   * the file's folder, the trash or a delete for good. There is nobody to
   * answer a name conflict here, so a paste keeps both files. After a delete
   * the item is the next file (the previous one at the end), or null.
   */
  async command(command: MediaWindowCommand): Promise<MediaWindowCommandResult> {
    if (this.closed) return { item: null, done: false }
    const s = await (this.opened ??= this.open())
    const refused = { item: this.shown, done: false }
    const entryId = this.currentId ?? s.entryId
    switch (command) {
      case "copy":
      case "cut":
        await this.call("clip.set", { selection: await this.selection(s, entryId), mode: command })
        if (command === "copy" && this.shown?.kind === "image") await this.copyImage(entryId)
        return { item: this.shown, done: true }
      case "paste": {
        const job = await this.call("clip.paste", {
          destinationDirId: s.dirId,
          conflict: "keepBoth",
        })
        const end = await this.jobEnd(job, PASTE_WAIT_MS)
        return end && jobWentWrong(end) ? refused : { item: this.shown, done: true }
      }
      case "trash":
      case "delete": {
        if (command === "trash" && !(await this.call("fs.canTrash", { dirId: s.dirId })).trash)
          return refused
        const next = (await this.at(s, 1)) ?? (await this.at(s, -1))
        const job = await this.call("jobs.start", {
          kind: command,
          source: { selection: await this.selection(s, entryId) },
        })
        const end = await this.jobEnd(job, DELETE_WAIT_MS)
        if (end && jobWentWrong(end)) return refused
        if (next) this.show(next)
        return { item: next, done: true }
      }
    }
  }

  /** One entry in a selection of the session as it is now (the listing moves its version on). */
  private async selection(s: Opened, entryId: number): Promise<SelectionDescriptor> {
    const { version } = await this.call("query.page", {
      queryId: s.queryId,
      offset: 0,
      limit: 1,
      thumbProfile: null,
    })
    return { queryId: s.queryId, version, ranges: [], include: [entryId], exclude: [] }
  }

  /** The job's final state; null while it still runs after `ms`. */
  private async jobEnd(started: JobSnapshot, ms: number): Promise<JobSnapshot | null> {
    const until = this.now() + ms
    let job: JobSnapshot | undefined = started
    while (job && !JOB_ENDED.has(job.state)) {
      if (this.now() >= until) return null
      await this.sleep(JOB_POLL_MS)
      const { jobs }: { jobs: JobSnapshot[] } = await this.call("jobs.list", {})
      job = jobs.find((j) => j.jobId === started.jobId)
    }
    // No longer listed: it ended a while ago.
    return job ?? null
  }

  /** The item `direction` names in the session as it is now. */
  private async at(s: Opened, direction: MediaWindowStep): Promise<ContentItem | null> {
    const index = await this.indexOf(s, direction)
    if (index < 0) return null
    const page = await this.call("query.page", {
      queryId: s.queryId,
      offset: index,
      limit: 1,
      thumbProfile: null,
    })
    return page.items[0] ?? null
  }

  /** Where `direction` points: from the current item, or the session's first or last index. */
  private async indexOf(s: Opened, direction: MediaWindowStep): Promise<number> {
    if (direction === "first") return 0
    if (direction === "last") {
      // The session lists only pictures and videos; its total is up to date.
      const { total } = await this.call("query.page", {
        queryId: s.queryId,
        offset: 0,
        limit: 1,
        thumbProfile: null,
      })
      return total - 1
    }
    const entryId = this.currentId ?? s.entryId
    const at = await this.call("query.indexOf", { queryId: s.queryId, entryId })
    return at.index < 0 ? -1 : at.index + direction
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
