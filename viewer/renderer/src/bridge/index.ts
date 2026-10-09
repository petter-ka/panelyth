// The only module that touches window.panelyth. Feature code imports from
// here and receives plain results or PanelythError, never envelopes.
import type {
  ClipMode,
  ClipState,
  ConflictPolicy,
  JobErrorsResult,
  JobSnapshot,
  JobStartParams,
  Tag,
  Bookmark,
  CopyImageResult,
  CopyPathsResult,
  LibraryState,
  ListDirsResult,
  Place,
  Properties,
  QueryFacets,
  SelectionDescriptor,
  SelectionInfo,
  Volume,
  CancelScanResult,
  DirOpenEntryParams,
  DirOpenParams,
  DirOpenResult,
  MediaOpenResult,
  PreviewEnsureParams,
  PreviewEnsureResult,
  FolderCoversParams,
  FolderCoversResult,
  QueryCloseResult,
  QueryDescriptor,
  QueryPageParams,
  QueryPageResult,
  QuerySnapshot,
  QueryIndexOfResult,
  SharedContext,
  ErrorCode,
  EventChannel,
  EventMap,
  PanelythApi,
  PingResult,
  RpcEnvelope,
  SidecarStatus,
  SystemInfo,
} from "@panelyth/contracts"

declare global {
  interface Window {
    panelyth?: PanelythApi
  }
}

export class PanelythError extends Error {
  override name = "PanelythError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

function api(): PanelythApi {
  const bridge = window.panelyth
  if (!bridge) throw new PanelythError("SIDECAR_UNAVAILABLE", "Panelyth bridge is not available")
  return bridge
}

async function unwrap<R>(call: () => Promise<RpcEnvelope<R>>): Promise<R> {
  const envelope = await call()
  if (envelope.ok) return envelope.r
  throw new PanelythError(envelope.e.code, envelope.e.message, envelope.e.retryable)
}

export function isBridgeAvailable(): boolean {
  return window.panelyth !== undefined
}

/** True while the commander is enabled: preload then exposes app.switch (ADR-0031). */
export function canSwitchApps(): boolean {
  return window.panelyth?.app.switch !== undefined
}

export const bridge = {
  quit: async (): Promise<void> => {
    await unwrap(() => api().app.exit())
  },
  /** Shows the commander in the same window (ADR-0031). */
  switchToCommander: async (): Promise<void> => {
    const switchApp = api().app.switch
    if (!switchApp) throw new PanelythError("METHOD_NOT_FOUND", "the commander is not enabled")
    await unwrap(() => switchApp("commander"))
  },
  /** Acknowledge that a hidden Viewer has staged the Commander media request. */
  reportMediaReady: async (requestId: number, ready: boolean): Promise<void> => {
    const report = api().app.mediaReady
    if (!report) throw new PanelythError("METHOD_NOT_FOUND", "media handoff is not available")
    await unwrap(() => report(requestId, ready))
  },
  ping: (): Promise<PingResult> => unwrap(() => api().system.ping()),
  info: (): Promise<SystemInfo> => unwrap(() => api().system.info()),
  sidecarStatus: (): Promise<SidecarStatus> => unwrap(() => api().sidecar.getStatus()),
  openFolderDialog: async (): Promise<string | null> =>
    (await unwrap(() => api().dialog.openFolder())).path,
  openDir: (params: DirOpenParams): Promise<DirOpenResult> => unwrap(() => api().dir.open(params)),
  openDirEntry: (params: DirOpenEntryParams): Promise<DirOpenResult> =>
    unwrap(() => api().dir.openEntry(params)),
  cancelScan: (scanId: number): Promise<CancelScanResult> =>
    unwrap(() => api().dir.cancelScan(scanId)),
  openQuery: (descriptor: QueryDescriptor): Promise<QuerySnapshot> =>
    unwrap(() => api().query.open(descriptor)),
  queryPage: (params: QueryPageParams): Promise<QueryPageResult> =>
    unwrap(() => api().query.page(params)),
  openMedia: (entryId: number): Promise<MediaOpenResult> => unwrap(() => api().media.open(entryId)),
  ensurePreviews: (params: PreviewEnsureParams): Promise<PreviewEnsureResult> =>
    unwrap(() => api().preview.ensure(params)),
  folderCovers: (params: FolderCoversParams): Promise<FolderCoversResult> =>
    unwrap(() => api().folder.covers(params)),
  closeQuery: (queryId: number): Promise<QueryCloseResult> =>
    unwrap(() => api().query.close(queryId)),
  queryFacets: (queryId: number): Promise<QueryFacets> => unwrap(() => api().query.facets(queryId)),
  indexOf: (queryId: number, entryId: number): Promise<QueryIndexOfResult> =>
    unwrap(() => api().query.indexOf(queryId, entryId)),
  /** The shared context (ADR-0031); only while the commander is enabled. */
  publishContext: async (
    dirId: number,
    focusId: number | null,
    /** Omitted when only the folder changed (the carried selection stays readable). */
    selection?: SelectionDescriptor | null,
  ): Promise<void> => {
    const context = api().context
    if (context) await unwrap(() => context.publish(dirId, focusId, selection))
  },
  /** The carried selection as ranges of this session (Stage C02). */
  contextSelection: async (
    version: number,
    queryId: number,
  ): Promise<SelectionDescriptor | null> => {
    const context = api().context
    return context ? unwrap(() => context.selection(version, queryId)) : null
  },
  getContext: async (): Promise<SharedContext | null> => {
    const context = api().context
    return context ? unwrap(() => context.get()) : null
  },
  selectionInfo: (selection: SelectionDescriptor): Promise<SelectionInfo> =>
    unwrap(() => api().selection.info(selection)),
  rebaseSelection: (selection: SelectionDescriptor): Promise<SelectionDescriptor> =>
    unwrap(() => api().selection.rebase(selection)),
  properties: (entryId: number): Promise<Properties> => unwrap(() => api().props.get(entryId)),
  volumes: async (): Promise<Volume[]> => (await unwrap(() => api().fs.volumes())).volumes,
  listDirs: (path: string): Promise<ListDirsResult> => unwrap(() => api().fs.listDirs(path)),
  places: async (): Promise<Place[]> => (await unwrap(() => api().places.list())).places,
  library: (): Promise<LibraryState> => unwrap(() => api().library.get()),
  setSetting: async (key: string, value: unknown): Promise<void> => {
    await unwrap(() => api().library.setSetting(key, value))
  },
  addBookmark: (path: string, label = ""): Promise<Bookmark> =>
    unwrap(() => api().library.addBookmark(path, label)),
  removeBookmark: async (id: number): Promise<void> => {
    await unwrap(() => api().library.removeBookmark(id))
  },
  openWithSystem: async (entryId: number): Promise<void> => {
    await unwrap(() => api().shell.open(entryId))
  },
  reveal: async (entryId: number): Promise<void> => {
    await unwrap(() => api().shell.reveal(entryId))
  },
  revealPath: async (path: string): Promise<void> => {
    await unwrap(() => api().shell.revealPath(path))
  },
  copyPaths: (selection: SelectionDescriptor): Promise<CopyPathsResult> =>
    unwrap(() => api().clipboard.copyPaths(selection)),
  copyText: async (text: string): Promise<void> => {
    await unwrap(() => api().clipboard.copyText(text))
  },
  copyImage: (entryId: number): Promise<CopyImageResult> =>
    unwrap(() => api().clipboard.copyImage(entryId)),
  startJob: (params: JobStartParams): Promise<JobSnapshot> =>
    unwrap(() => api().jobs.start(params)),
  cancelJob: async (jobId: number): Promise<boolean> =>
    (await unwrap(() => api().jobs.cancel(jobId))).cancelled,
  jobErrors: (jobId: number, offset: number, limit: number): Promise<JobErrorsResult> =>
    unwrap(() => api().jobs.errors(jobId, offset, limit)),
  listJobs: async (): Promise<JobSnapshot[]> => (await unwrap(() => api().jobs.list())).jobs,
  setClip: (selection: SelectionDescriptor, mode: ClipMode): Promise<ClipState> =>
    unwrap(() => api().clip.set(selection, mode)),
  clip: (): Promise<ClipState> => unwrap(() => api().clip.get()),
  paste: (destination: string, conflict: ConflictPolicy): Promise<JobSnapshot> =>
    unwrap(() => api().clip.paste(destination, conflict)),
  rename: async (entryId: number, name: string): Promise<string> =>
    (await unwrap(() => api().entry.rename(entryId, name))).name,
  tags: async (): Promise<Tag[]> => (await unwrap(() => api().library.tags())).tags,
  deleteTag: async (id: number): Promise<void> => {
    await unwrap(() => api().library.deleteTag(id))
  },
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void {
    return api().onEvent(channel, listener)
  },
}
