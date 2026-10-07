import type { RpcEnvelope } from "./errors"
import type { EventChannel, EventMap } from "./events"
import type {
  ClipMode,
  ClipState,
  ConflictDecision,
  FsCanTrashResult,
  FsMkdirResult,
  FsMkfileResult,
  FileOpenResult,
  FindCancelResult,
  FindStartParams,
  FindStartResult,
  PreviewEnsureParams as CommanderPreviewParams,
  CommanderJobParams,
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
  UpdateBookmarkParams,
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
  QueryIndexOfResult,
  QueryLocateParams,
  QueryLocateResult,
  QueryMatchResult,
  SharedContext,
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
    indexOf(queryId: number, entryId: number): Promise<RpcEnvelope<QueryIndexOfResult>>
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
    addBookmark(path: string, label: string, group?: string): Promise<RpcEnvelope<Bookmark>>
    removeBookmark(id: number): Promise<RpcEnvelope<OkResult>>
    updateBookmark(params: UpdateBookmarkParams): Promise<RpcEnvelope<Bookmark>>
    reorderBookmarks(ids: number[]): Promise<RpcEnvelope<OkResult>>
    tags(): Promise<RpcEnvelope<TagsResult>>
    deleteTag(id: number): Promise<RpcEnvelope<OkResult>>
  }
  /** Batch operations (ADR-0021): progress arrives as job.progress events. */
  jobs: {
    start(params: JobStartParams): Promise<RpcEnvelope<JobSnapshot>>
    cancel(jobId: number): Promise<RpcEnvelope<JobCancelResult>>
    errors(jobId: number, offset: number, limit: number): Promise<RpcEnvelope<JobErrorsResult>>
    list(): Promise<RpcEnvelope<JobListResult>>
    /** Stage P03 (ADR-0029). */
    pause(jobId: number): Promise<RpcEnvelope<OkResult>>
    resume(jobId: number): Promise<RpcEnvelope<OkResult>>
    startNow(jobId: number): Promise<RpcEnvelope<OkResult>>
    resolve(
      jobId: number,
      decision: ConflictDecision,
      applyToAll: boolean,
    ): Promise<RpcEnvelope<OkResult>>
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
  /** The shared context (present only while the commander is enabled; ADR-0031). */
  context?: {
    publish(
      dirId: number,
      focusId: number | null,
      selection?: SelectionDescriptor | null,
    ): Promise<RpcEnvelope<OkResult>>
    get(): Promise<RpcEnvelope<SharedContext>>
    /** The carried selection as ranges of this session (Stage C02). */
    selection(version: number, queryId: number): Promise<RpcEnvelope<SelectionDescriptor>>
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
    /** The directory hotlist: the bookmarks shared with the viewer (Stage C03). */
    addBookmark(path: string, label: string, group?: string): Promise<RpcEnvelope<Bookmark>>
    removeBookmark(id: number): Promise<RpcEnvelope<OkResult>>
    updateBookmark(params: UpdateBookmarkParams): Promise<RpcEnvelope<Bookmark>>
    reorderBookmarks(ids: number[]): Promise<RpcEnvelope<OkResult>>
  }
  /** Listing (Stage C01): the all-entries scope, one session per visible panel. */
  dir: {
    open(params: DirOpenParams): Promise<RpcEnvelope<DirOpenResult>>
    openEntry(params: DirOpenEntryParams): Promise<RpcEnvelope<DirOpenResult>>
    cancelScan(scanId: number): Promise<RpcEnvelope<CancelScanResult>>
    /** "Go to file" (Stage C06): the folder holding an entry. */
    openContaining(entryId: number, lane?: string): Promise<RpcEnvelope<DirOpenResult>>
  }
  /** Find files (Stage C06): results stream into a query session. */
  find: {
    start(params: FindStartParams): Promise<RpcEnvelope<FindStartResult>>
    cancel(findId: number): Promise<RpcEnvelope<FindCancelResult>>
  }
  query: {
    open(descriptor: QueryDescriptor): Promise<RpcEnvelope<QuerySnapshot>>
    page(params: QueryPageParams): Promise<RpcEnvelope<QueryPageResult>>
    close(queryId: number): Promise<RpcEnvelope<QueryCloseResult>>
    indexOf(queryId: number, entryId: number): Promise<RpcEnvelope<QueryIndexOfResult>>
    /** Quick search (Stage C02). */
    locate(params: QueryLocateParams): Promise<RpcEnvelope<QueryLocateResult>>
    /** Marking by mask (Stage C02). */
    match(queryId: number, mask: string): Promise<RpcEnvelope<QueryMatchResult>>
  }
  selection: {
    info(selection: SelectionDescriptor): Promise<RpcEnvelope<SelectionInfo>>
    rebase(selection: SelectionDescriptor): Promise<RpcEnvelope<SelectionDescriptor>>
  }
  /** Stage C02: folder sizes only; file operations arrive in C04. */
  jobs: {
    dirSize(selection: SelectionDescriptor): Promise<RpcEnvelope<JobSnapshot>>
    cancel(jobId: number): Promise<RpcEnvelope<JobCancelResult>>
  }
  fs: {
    volumes(): Promise<RpcEnvelope<VolumesResult>>
    /** Stage C04: F7 and the delete dialog. */
    mkdir(parentDirId: number, path: string): Promise<RpcEnvelope<FsMkdirResult>>
    canTrash(dirId: number): Promise<RpcEnvelope<FsCanTrashResult>>
    /** Stage C05: Shift+F4's new text file. */
    mkfile(parentDirId: number, name: string): Promise<RpcEnvelope<FsMkfileResult>>
  }
  /** Stage C05: quick view and lister (shared media components, ADR-0025). */
  media: {
    open(entryId: number): Promise<RpcEnvelope<MediaOpenResult>>
  }
  preview: {
    ensure(params: CommanderPreviewParams): Promise<RpcEnvelope<PreviewEnsureResult>>
  }
  props: {
    get(entryId: number): Promise<RpcEnvelope<Properties>>
  }
  /** Stage C05: any file's bytes through a read-only token URL (ADR-0027). */
  file: {
    open(entryId: number): Promise<RpcEnvelope<FileOpenResult>>
  }
  /** Stage C05: open with the default app (programs need allowProgram) and edit (F4). */
  shell: {
    open(entryId: number, allowProgram?: boolean): Promise<RpcEnvelope<OkResult>>
    edit(entryId: number): Promise<RpcEnvelope<OkResult>>
  }
  places: {
    list(): Promise<RpcEnvelope<PlacesResult>>
  }
  /** Stage C04: file operations on the engine v2 queue (ADR-0029). */
  files: {
    start(params: CommanderJobParams): Promise<RpcEnvelope<JobSnapshot>>
    pause(jobId: number): Promise<RpcEnvelope<OkResult>>
    resume(jobId: number): Promise<RpcEnvelope<OkResult>>
    startNow(jobId: number): Promise<RpcEnvelope<OkResult>>
    resolve(
      jobId: number,
      decision: ConflictDecision,
      applyToAll: boolean,
    ): Promise<RpcEnvelope<OkResult>>
    errors(jobId: number, offset: number, limit: number): Promise<RpcEnvelope<JobErrorsResult>>
    list(): Promise<RpcEnvelope<JobListResult>>
    rename(entryId: number, name: string): Promise<RpcEnvelope<EntryRenameResult>>
  }
  /** The internal file clipboard, shared with the viewer (ADR-0021, ADR-0031). */
  clip: {
    set(selection: SelectionDescriptor, mode: ClipMode): Promise<RpcEnvelope<ClipState>>
    get(): Promise<RpcEnvelope<ClipState>>
    paste(destinationDirId: number, conflict: ConflictPolicy): Promise<RpcEnvelope<JobSnapshot>>
  }
  clipboard: {
    copyPaths(
      selection: SelectionDescriptor,
      namesOnly?: boolean,
    ): Promise<RpcEnvelope<CopyPathsResult>>
    copyText(text: string): Promise<RpcEnvelope<OkResult>>
  }
  context: {
    publish(
      dirId: number,
      focusId: number | null,
      selection?: SelectionDescriptor | null,
    ): Promise<RpcEnvelope<OkResult>>
    get(): Promise<RpcEnvelope<SharedContext>>
    selection(version: number, queryId: number): Promise<RpcEnvelope<SelectionDescriptor>>
  }
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}
