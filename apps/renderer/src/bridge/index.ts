// The only module that touches window.fastview. Feature code imports from
// here and receives plain results or FastViewError, never envelopes.
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
  ErrorCode,
  EventChannel,
  EventMap,
  FastViewApi,
  PingResult,
  RpcEnvelope,
  SidecarStatus,
  SystemInfo,
} from "@fastview/contracts"

declare global {
  interface Window {
    fastview?: FastViewApi
  }
}

export class FastViewError extends Error {
  override name = "FastViewError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message)
  }
}

function api(): FastViewApi {
  const bridge = window.fastview
  if (!bridge) throw new FastViewError("SIDECAR_UNAVAILABLE", "FastView bridge is not available")
  return bridge
}

async function unwrap<R>(call: () => Promise<RpcEnvelope<R>>): Promise<R> {
  const envelope = await call()
  if (envelope.ok) return envelope.r
  throw new FastViewError(envelope.e.code, envelope.e.message, envelope.e.retryable)
}

export function isBridgeAvailable(): boolean {
  return window.fastview !== undefined
}

export const bridge = {
  quit: async (): Promise<void> => {
    await unwrap(() => api().app.exit())
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
