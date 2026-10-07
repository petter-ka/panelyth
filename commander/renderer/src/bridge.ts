import type {
  AppId,
  ArchiveCheckResult,
  ArchiveOpenResult,
  Bookmark,
  ClipMode,
  ClipState,
  CommanderJobParams,
  ConflictDecision,
  ConflictPolicy,
  CopyPathsResult,
  FsMkdirResult,
  FsMkfileResult,
  FileOpenResult,
  FindStartParams,
  FindStartResult,
  MediaOpenResult,
  PreviewEnsureParams,
  PreviewEnsureResult,
  Properties,
  JobErrorsResult,
  CommanderApi,
  DirOpenResult,
  ErrorCode,
  EventChannel,
  EventMap,
  LibraryState,
  Place,
  QueryDescriptor,
  QueryIndexOfResult,
  QueryLocateResult,
  QueryMatchResult,
  JobSnapshot,
  SelectionDescriptor,
  SelectionInfo,
  QueryPageResult,
  QuerySnapshot,
  RpcEnvelope,
  SharedContext,
  SidecarStatus,
  Volume,
} from "@fastview/contracts"

/** A failed call, with the sidecar's error code and details (e.g. `{ reason: "notReady" }`). */
export class FastViewError extends Error {
  override name = "FastViewError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** The commander's narrow API (ADR-0027); everything goes through here. */
function api(): CommanderApi {
  const value = window.fastview
  if (!value) throw new Error("FastView bridge unavailable")
  return value
}

async function unwrap<T>(call: () => Promise<RpcEnvelope<T>>): Promise<T> {
  const res = await call()
  if (!res.ok) throw new FastViewError(res.e.code, res.e.message, res.e.details)
  return res.r
}

export const isBridgeAvailable = (): boolean => window.fastview !== undefined

let library: Promise<LibraryState> | null = null

/** Tests: forget the cached library.db read. */
export function resetBridgeCache(): void {
  library = null
}

export const bridge = {
  switchTo: async (to: AppId): Promise<void> => {
    await unwrap(() => api().app.switch(to))
  },
  exit: async (): Promise<void> => {
    await unwrap(() => api().app.exit())
  },
  sidecarStatus: (): Promise<SidecarStatus> => unwrap(() => api().sidecar.getStatus()),
  /** library.db, read once per start; the layout, the panels and the appearance use it. */
  library: (): Promise<LibraryState> => {
    library ??= unwrap(() => api().library.get()).catch((error: unknown) => {
      library = null
      throw error
    })
    return library
  },
  setSetting: async (key: string, value: unknown): Promise<void> => {
    await unwrap(() => api().library.setSetting(key, value))
  },
  /** library.db now: bookmarks and recent locations change while the app runs. */
  libraryNow: (): Promise<LibraryState> => unwrap(() => api().library.get()),
  addBookmark: (path: string, label = "", group = ""): Promise<Bookmark> =>
    unwrap(() => api().library.addBookmark(path, label, group)),
  removeBookmark: async (id: number): Promise<void> => {
    await unwrap(() => api().library.removeBookmark(id))
  },
  updateBookmark: (b: Bookmark): Promise<Bookmark> => unwrap(() => api().library.updateBookmark(b)),
  reorderBookmarks: async (ids: number[]): Promise<void> => {
    await unwrap(() => api().library.reorderBookmarks(ids))
  },
  /** lane: the panel whose foreground scan this is (Stage C06); recursive for a branch view. */
  openDir: (path: string, lane?: string, recursive = false): Promise<DirOpenResult> =>
    unwrap(() => api().dir.open({ path, recursive, ...(lane !== undefined && { lane }) })),
  openDirEntry: (entryId: number, lane?: string): Promise<DirOpenResult> =>
    unwrap(() =>
      api().dir.openEntry({ entryId, recursive: false, ...(lane !== undefined && { lane }) }),
    ),
  /** "Go to file" (Stage C06): the folder holding an entry. */
  openContaining: (entryId: number, lane?: string): Promise<DirOpenResult> =>
    unwrap(() => api().dir.openContaining(entryId, lane)),
  // Stage C06: find files.
  findStart: (spec: FindStartParams): Promise<FindStartResult> =>
    unwrap(() => api().find.start(spec)),
  findCancel: async (findId: number): Promise<boolean> =>
    (await unwrap(() => api().find.cancel(findId))).cancelled,
  // Stage C07: archives as folders.
  openArchive: (entryId: number): Promise<ArchiveOpenResult> =>
    unwrap(() => api().archive.open(entryId)),
  closeArchive: async (archiveId: number): Promise<void> => {
    await unwrap(() => api().archive.close(archiveId))
  },
  checkArchive: (
    selection: SelectionDescriptor,
    destinationDirId: number,
  ): Promise<ArchiveCheckResult> => unwrap(() => api().archive.check(selection, destinationDirId)),
  /** Whether 7-Zip was found (7z, rar and others; creating 7z). */
  sevenZip: async (): Promise<boolean> => (await unwrap(() => api().archive.tools())).sevenZip,
  cancelScan: async (scanId: number): Promise<void> => {
    await unwrap(() => api().dir.cancelScan(scanId))
  },
  openQuery: (d: QueryDescriptor): Promise<QuerySnapshot> => unwrap(() => api().query.open(d)),
  page: (queryId: number, offset: number, limit: number): Promise<QueryPageResult> =>
    unwrap(() => api().query.page({ queryId, offset, limit, thumbProfile: null })),
  closeQuery: async (queryId: number): Promise<void> => {
    await unwrap(() => api().query.close(queryId))
  },
  indexOf: (queryId: number, entryId: number): Promise<QueryIndexOfResult> =>
    unwrap(() => api().query.indexOf(queryId, entryId)),
  volumes: async (): Promise<Volume[]> => (await unwrap(() => api().fs.volumes())).volumes,
  places: async (): Promise<Place[]> => (await unwrap(() => api().places.list())).places,
  homePath: async (): Promise<string | null> => {
    const { places } = await unwrap(() => api().places.list())
    return places.find((p) => p.id === "home")?.path ?? null
  },
  publishContext: async (
    dirId: number,
    focusId: number | null,
    /** Omitted when only the folder changed (the carried selection stays readable). */
    selection?: SelectionDescriptor | null,
  ): Promise<void> => {
    await unwrap(() => api().context.publish(dirId, focusId, selection))
  },
  getContext: (): Promise<SharedContext> => unwrap(() => api().context.get()),
  /** The carried selection as ranges of this session (Stage C02). */
  contextSelection: (version: number, queryId: number): Promise<SelectionDescriptor> =>
    unwrap(() => api().context.selection(version, queryId)),
  locate: (
    queryId: number,
    pattern: string,
    from: number,
    direction: "forward" | "backward",
  ): Promise<QueryLocateResult> =>
    unwrap(() => api().query.locate({ queryId, pattern, from, direction })),
  match: (queryId: number, mask: string): Promise<QueryMatchResult> =>
    unwrap(() => api().query.match(queryId, mask)),
  selectionInfo: (selection: SelectionDescriptor): Promise<SelectionInfo> =>
    unwrap(() => api().selection.info(selection)),
  rebase: (selection: SelectionDescriptor): Promise<SelectionDescriptor> =>
    unwrap(() => api().selection.rebase(selection)),
  dirSize: (selection: SelectionDescriptor): Promise<JobSnapshot> =>
    unwrap(() => api().jobs.dirSize(selection)),
  // Stage C04: file operations on the engine v2 queue.
  startJob: (p: CommanderJobParams): Promise<JobSnapshot> => unwrap(() => api().files.start(p)),
  pauseJob: async (jobId: number): Promise<void> => {
    await unwrap(() => api().files.pause(jobId))
  },
  resumeJob: async (jobId: number): Promise<void> => {
    await unwrap(() => api().files.resume(jobId))
  },
  startJobNow: async (jobId: number): Promise<void> => {
    await unwrap(() => api().files.startNow(jobId))
  },
  resolveJob: async (
    jobId: number,
    decision: ConflictDecision,
    applyToAll: boolean,
  ): Promise<boolean> => (await unwrap(() => api().files.resolve(jobId, decision, applyToAll))).ok,
  jobErrors: (jobId: number, offset: number, limit: number): Promise<JobErrorsResult> =>
    unwrap(() => api().files.errors(jobId, offset, limit)),
  listJobs: async (): Promise<JobSnapshot[]> => (await unwrap(() => api().files.list())).jobs,
  rename: async (entryId: number, name: string): Promise<string> =>
    (await unwrap(() => api().files.rename(entryId, name))).name,
  mkdir: (parentDirId: number, path: string): Promise<FsMkdirResult> =>
    unwrap(() => api().fs.mkdir(parentDirId, path)),
  canTrash: async (dirId: number): Promise<boolean> =>
    (await unwrap(() => api().fs.canTrash(dirId))).trash,
  clipSet: (selection: SelectionDescriptor, mode: ClipMode): Promise<ClipState> =>
    unwrap(() => api().clip.set(selection, mode)),
  clipGet: (): Promise<ClipState> => unwrap(() => api().clip.get()),
  clipPaste: (destinationDirId: number, conflict: ConflictPolicy): Promise<JobSnapshot> =>
    unwrap(() => api().clip.paste(destinationDirId, conflict)),
  copyPaths: (selection: SelectionDescriptor, namesOnly = false): Promise<CopyPathsResult> =>
    unwrap(() => api().clipboard.copyPaths(selection, namesOnly)),
  copyText: async (text: string): Promise<void> => {
    await unwrap(() => api().clipboard.copyText(text))
  },
  cancelJob: async (jobId: number): Promise<void> => {
    await unwrap(() => api().jobs.cancel(jobId))
  },
  // Stage C05: quick view, lister, open and edit.
  openMedia: (entryId: number): Promise<MediaOpenResult> => unwrap(() => api().media.open(entryId)),
  ensurePreviews: (params: PreviewEnsureParams): Promise<PreviewEnsureResult> =>
    unwrap(() => api().preview.ensure(params)),
  properties: (entryId: number): Promise<Properties> => unwrap(() => api().props.get(entryId)),
  /** A read-only token URL for any file; its bytes are read with HTTP Range. */
  openFile: (entryId: number): Promise<FileOpenResult> => unwrap(() => api().file.open(entryId)),
  /** Opens with the default app; a program needs allowProgram (PERMISSION_DENIED, reason "program"). */
  shellOpen: async (entryId: number, allowProgram?: boolean): Promise<void> => {
    await unwrap(() => api().shell.open(entryId, allowProgram))
  },
  shellEdit: async (entryId: number): Promise<void> => {
    await unwrap(() => api().shell.edit(entryId))
  },
  mkfile: (parentDirId: number, name: string): Promise<FsMkfileResult> =>
    unwrap(() => api().fs.mkfile(parentDirId, name)),
  on: <C extends EventChannel>(
    channel: C,
    listener: (payload: EventMap[C]) => void,
  ): (() => void) => api().onEvent(channel, listener),
}
