import type { RpcEnvelope } from "./errors"
import type { EventChannel, EventMap } from "./events"
import type {
  ClipMode,
  ClipState,
  ConflictPolicy,
  EntryRenameResult,
  JobCancelResult,
  JobErrorsResult,
  JobListResult,
  JobSnapshot,
  JobStartParams,
  TagsResult,
  Bookmark,
  CopyImageResult,
  CopyPathsResult,
  LibraryState,
  ListDirsResult,
  OkResult,
  PlacesResult,
  Properties,
  QueryFacets,
  SelectionDescriptor,
  SelectionInfo,
  VolumesResult,
  CancelScanResult,
  DirOpenEntryParams,
  DirOpenParams,
  DirOpenResult,
  EchoResult,
  MediaOpenResult,
  OpenFolderDialogResult,
  PreviewEnsureParams,
  FolderCoversParams,
  FolderCoversResult,
  PreviewEnsureResult,
  PingResult,
  QueryCloseResult,
  QueryDescriptor,
  QueryPageParams,
  QueryPageResult,
  QuerySnapshot,
  SidecarStatus,
  SystemInfo,
  AppId,
} from "./rpc"

/** Electron IPC channel names. Only preload and main use these. */
export const IPC_INVOKE = "fv:invoke"
export const IPC_EVENT = "fv:event"

/** Renderer argument that tells preload to expose dev-only methods. */
export const DEV_METHODS_ARG = "--fastview-dev-methods"

/** Renderer argument: the commander is enabled, so preload exposes app.switch (ADR-0031). */
export const COMMANDER_ENABLED_ARG = "--fastview-commander"

/**
 * Shape of `window.fastview`, exposed by preload through contextBridge.
 * Narrow and typed: there is no generic invoke and no raw ipcRenderer.
 */
export interface FastViewApi {
  app: {
    /** Request an orderly application exit. */
    exit(): Promise<RpcEnvelope<OkResult>>
    /** Show the other app (present only while the commander is enabled; ADR-0031). */
    switch?(to: AppId): Promise<RpcEnvelope<OkResult>>
  }
  system: {
    ping(): Promise<RpcEnvelope<PingResult>>
    info(): Promise<RpcEnvelope<SystemInfo>>
  }
  sidecar: {
    getStatus(): Promise<RpcEnvelope<SidecarStatus>>
  }
  dialog: {
    /** Native folder picker (Electron main). */
    openFolder(): Promise<RpcEnvelope<OpenFolderDialogResult>>
  }
  dir: {
    open(params: DirOpenParams): Promise<RpcEnvelope<DirOpenResult>>
    openEntry(params: DirOpenEntryParams): Promise<RpcEnvelope<DirOpenResult>>
    cancelScan(scanId: number): Promise<RpcEnvelope<CancelScanResult>>
  }
  media: {
    /** Opens an image/video for viewing: a fastview-media URL and display size. */
    open(entryId: number): Promise<RpcEnvelope<MediaOpenResult>>
  }
  preview: {
    ensure(params: PreviewEnsureParams): Promise<RpcEnvelope<PreviewEnsureResult>>
  }
  folder: {
    /** Up to four media previews per folder tile, without indexing the folder. */
    covers(params: FolderCoversParams): Promise<RpcEnvelope<FolderCoversResult>>
  }
  query: {
    open(descriptor: QueryDescriptor): Promise<RpcEnvelope<QuerySnapshot>>
    page(params: QueryPageParams): Promise<RpcEnvelope<QueryPageResult>>
    close(queryId: number): Promise<RpcEnvelope<QueryCloseResult>>
    facets(queryId: number): Promise<RpcEnvelope<QueryFacets>>
  }
  selection: {
    /** Count and total size, resolved in Go. */
    info(selection: SelectionDescriptor): Promise<RpcEnvelope<SelectionInfo>>
    rebase(selection: SelectionDescriptor): Promise<RpcEnvelope<SelectionDescriptor>>
  }
  props: {
    get(entryId: number): Promise<RpcEnvelope<Properties>>
  }
  fs: {
    volumes(): Promise<RpcEnvelope<VolumesResult>>
    /** Immediate subfolders only (lazy tree). */
    listDirs(path: string): Promise<RpcEnvelope<ListDirsResult>>
  }
  places: {
    list(): Promise<RpcEnvelope<PlacesResult>>
  }
  library: {
    get(): Promise<RpcEnvelope<LibraryState>>
    setSetting(key: string, value: unknown): Promise<RpcEnvelope<OkResult>>
    addBookmark(path: string, label: string): Promise<RpcEnvelope<Bookmark>>
    removeBookmark(id: number): Promise<RpcEnvelope<OkResult>>
    tags(): Promise<RpcEnvelope<TagsResult>>
    deleteTag(id: number): Promise<RpcEnvelope<OkResult>>
  }
  /** Batch operations (ADR-0021): progress arrives as job.progress events. */
  jobs: {
    start(params: JobStartParams): Promise<RpcEnvelope<JobSnapshot>>
    cancel(jobId: number): Promise<RpcEnvelope<JobCancelResult>>
    errors(jobId: number, offset: number, limit: number): Promise<RpcEnvelope<JobErrorsResult>>
    list(): Promise<RpcEnvelope<JobListResult>>
  }
  /** The internal file clipboard (Ctrl+C / Ctrl+X / Ctrl+V), held in Go. */
  clip: {
    set(selection: SelectionDescriptor, mode: ClipMode): Promise<RpcEnvelope<ClipState>>
    get(): Promise<RpcEnvelope<ClipState>>
    paste(destination: string, conflict: ConflictPolicy): Promise<RpcEnvelope<JobSnapshot>>
  }
  entry: {
    rename(entryId: number, name: string): Promise<RpcEnvelope<EntryRenameResult>>
  }
  shell: {
    open(entryId: number): Promise<RpcEnvelope<OkResult>>
    reveal(entryId: number): Promise<RpcEnvelope<OkResult>>
    revealPath(path: string): Promise<RpcEnvelope<OkResult>>
  }
  clipboard: {
    copyPaths(selection: SelectionDescriptor): Promise<RpcEnvelope<CopyPathsResult>>
    copyText(text: string): Promise<RpcEnvelope<OkResult>>
    copyImage(entryId: number): Promise<RpcEnvelope<CopyImageResult>>
  }
  /** Present only when dev methods are enabled (benchmarks, development). */
  dev?: {
    echo(payload: string): Promise<RpcEnvelope<EchoResult>>
  }
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

/**
 * Shape of `window.fastview` in the commander's app view (ADR-0027): only the
 * methods in COMMANDER_METHODS.
 */
export interface CommanderApi {
  app: {
    exit(): Promise<RpcEnvelope<OkResult>>
    switch(to: AppId): Promise<RpcEnvelope<OkResult>>
  }
  system: {
    ping(): Promise<RpcEnvelope<PingResult>>
    info(): Promise<RpcEnvelope<SystemInfo>>
  }
  sidecar: {
    getStatus(): Promise<RpcEnvelope<SidecarStatus>>
  }
  library: {
    get(): Promise<RpcEnvelope<LibraryState>>
    setSetting(key: string, value: unknown): Promise<RpcEnvelope<OkResult>>
  }
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
