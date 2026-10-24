import type {
  GitBranchesResult,
  GitCancelResult,
  GitChangesResult,
  GitLogResult,
  GitRunParams,
  GitRunResult,
  GitStatusResult,
} from "./git"
import type {
  EditEyesParams,
  EditEyesResult,
  AssetPickResult,
  EditFontsResult,
  EditColorsParams,
  EditColorsResult,
  EditEstimateParams,
  EditEstimateResult,
  EditInfoResult,
  EditProbeParams,
  EditProbeResult,
  EditThumbsParams,
  EditThumbsResult,
  EditOpenResult,
  EditRenderParams,
  EditRenderResult,
  EditSaveParams,
  EditSaveResult,
  EditSavedResult,
} from "./edit"
import type {
  BatchParams,
  BatchPickFolderResult,
  BatchPlanResult,
  RecipeListResult,
  RecipeSaveParams,
  RecipeSaveResult,
} from "./batch"
import type { RpcEnvelope } from "./errors"
import type { ProgramEdit, ProgramsResult } from "./programs"
import type { AboutInfo, AppTarget, UpdateState } from "./update"
import type { EventChannel, EventMap } from "./events"
import type {
  TextEditCheckResult,
  TextEditCommitResult,
  TextEditorCommitParams,
  TextEditorSession,
  TextEditAssetCommitResult,
  TextEditorResolveImagesResult,
  TextEditorExportParams,
  TextEditorExportResult,
} from "./textedit"
import type {
  ArchiveCheckResult,
  ArchiveCloseResult,
  ArchiveOpenResult,
  ArchiveToolsResult,
  CompareCancelResult,
  CompareCloseResult,
  CompareDirsParams,
  CompareMarksParams,
  CompareMarksResult,
  ComparePlan,
  CompareShow,
  CompareStartResult,
  CompareView,
  ConnectionsResult,
  RemoteConnectParams,
  RemoteConnectResult,
  RemoteOpenResult,
  SavedConnection,
  SecureStoreResult,
  DiffAction,
  TextDiffOpenResult,
  TextDiffPageResult,
  RenamePlan,
  RenamePreviewResult,
  RenameUndoInfo,
  ClipMode,
  ClipState,
  ConflictDecision,
  ContentItem,
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
  DragStartResult,
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
  MediaWindowCommand,
  MediaWindowCommandResult,
  MediaWindowStep,
  MediaWindowStepResult,
  OpenRequestResult,
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
  ShellRunParams,
  ShellRunToolParams,
  SettingsTab,
  SidecarStatus,
  SystemInfo,
  AppId,
  SystemHardware,
  SystemLoad,
  WindowControlParams,
  WindowFrameInfo,
} from "./rpc"

/** Electron IPC channel names. Only preload and main use these. */
export const IPC_INVOKE = "fv:invoke"
export const IPC_EVENT = "fv:event"

/** Renderer argument that tells preload to expose dev-only methods. */
export const DEV_METHODS_ARG = "--panelyth-dev-methods"

/** Renderer argument: the commander is enabled, so preload exposes app.switch (ADR-0031). */
export const COMMANDER_ENABLED_ARG = "--panelyth-commander"

/** Renderer argument (ADR-0045): the app view draws the window's title strip and its buttons (Windows). */
export const TITLE_BAR_ARG = "--panelyth-title-bar"

/** The main window's frame, for the title strip (ADR-0045); in all three app views. */
export interface WindowFrameApi {
  /** True when this view draws the title strip (the renderer argument). */
  titleBar: boolean
  state(): Promise<RpcEnvelope<WindowFrameInfo>>
  control(action: WindowControlParams["action"]): Promise<RpcEnvelope<OkResult>>
}

/**
 * Shape of `window.panelyth`, exposed by preload through contextBridge.
 * Narrow and typed: there is no generic invoke and no raw ipcRenderer.
 */
export interface PanelythApi {
  app: {
    /** Request an orderly application exit. */
    exit(): Promise<RpcEnvelope<OkResult>>
    /** Show the other app (present only while the commander is enabled; ADR-0031). */
    switch?(to: AppId): Promise<RpcEnvelope<OkResult>>
    /** Once at start: the folder and entry the app was started to show (a file opened from the OS). */
    openRequest(): Promise<RpcEnvelope<OpenRequestResult>>
    /** The product's version and what it runs on (Settings → About). */
    about(): Promise<RpcEnvelope<AboutInfo>>
    /** Opens the log folder, the licence notices or a page of the project. */
    openTarget(target: AppTarget): Promise<RpcEnvelope<OkResult>>
  }
  frame: WindowFrameApi
  /** Settings in a native window (ADR-0039). */
  settings: {
    openWindow(tab?: SettingsTab, section?: string): Promise<RpcEnvelope<OkResult>>
    /** From the settings window only. */
    closeWindow(then?: "shortcuts"): Promise<RpcEnvelope<OkResult>>
  }
  /** Updates (ADR-0038): main checks, downloads and installs; the state arrives as update.state events. */
  update: {
    get(): Promise<RpcEnvelope<UpdateState>>
    check(): Promise<RpcEnvelope<UpdateState>>
    download(): Promise<RpcEnvelope<UpdateState>>
    /** Quits, installs the downloaded version and starts it. */
    install(): Promise<RpcEnvelope<OkResult>>
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
    /** Opens an image/video for viewing: a panelyth-media URL and display size. */
    open(entryId: number): Promise<RpcEnvelope<MediaOpenResult>>
    /** An image or video in a frameless full-screen window of its own (ADR-0033). */
    openWindow(
      entryId: number,
      key: number,
      theme?: string,
      lang?: string,
    ): Promise<RpcEnvelope<OkResult>>
    /** The opener's reply to a mediaWindow.step event. */
    windowAnswer(
      requestId: number,
      item: ContentItem | null,
      done?: boolean,
    ): Promise<RpcEnvelope<OkResult>>
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
  /**
   * "Open with" programs (ADR-0044), shared by both apps. A program is picked
   * in main's native dialog; the renderer names programs and entries by id.
   */
  programs: {
    add(): Promise<RpcEnvelope<ProgramsResult>>
    update(programs: ProgramEdit[]): Promise<RpcEnvelope<ProgramsResult>>
    open(programId: string, entryId: number): Promise<RpcEnvelope<OkResult>>
    /** A folder of the folder tree, by its path (main checks it is a folder). */
    openFolder(programId: string, path: string): Promise<RpcEnvelope<OkResult>>
  }
  clipboard: {
    copyPaths(selection: SelectionDescriptor): Promise<RpcEnvelope<CopyPathsResult>>
    copyText(text: string): Promise<RpcEnvelope<OkResult>>
    copyImage(entryId: number): Promise<RpcEnvelope<CopyImageResult>>
  }
  /** Files to other apps (ADR-0040): the OS's drag of the selection. */
  drag: {
    start(selection: SelectionDescriptor): Promise<RpcEnvelope<DragStartResult>>
  }
  /**
   * The image editor (Stage 12, ADR-0035): a session per window, frames as
   * token URLs, saves as jobs. Viewer profile only (ADR-0027).
   */
  edit: {
    open(entryId: number): Promise<RpcEnvelope<EditOpenResult>>
    render(params: EditRenderParams): Promise<RpcEnvelope<EditRenderResult>>
    info(sessionId: string): Promise<RpcEnvelope<EditInfoResult>>
    estimate(params: EditEstimateParams): Promise<RpcEnvelope<EditEstimateResult>>
    /** "as" opens the native save dialog in main; jobId is null when it was cancelled. */
    save(params: EditSaveParams): Promise<RpcEnvelope<EditSaveResult>>
    close(sessionId: string): Promise<RpcEnvelope<OkResult>>
    /** The entry a finished save wrote, once it is indexed (0 before that). */
    saved(jobId: number): Promise<RpcEnvelope<EditSavedResult>>
    /** Shows a finished save in the system file manager. */
    reveal(jobId: number): Promise<RpcEnvelope<OkResult>>
    /** Stage 13: the color at a point (eyedroppers); nothing but four numbers crosses IPC. */
    probe(params: EditProbeParams): Promise<RpcEnvelope<EditProbeResult>>
    /** Small renderings of several edit lists at once (preset thumbnails). */
    thumbs(params: EditThumbsParams): Promise<RpcEnvelope<EditThumbsResult>>
    /** Count colors: exact for the full picture, an estimate for the preview. */
    colors(params: EditColorsParams): Promise<RpcEnvelope<EditColorsResult>>
    /** Stage 14: the font families text can be drawn with (names only). */
    fonts(sessionId: string): Promise<RpcEnvelope<EditFontsResult>>
    /**
     * Opens the native dialog in main for a picture to use as a watermark, a
     * mask or a texture; `asset` is null when it was cancelled.
     */
    pickAsset(sessionId: string): Promise<RpcEnvelope<AssetPickResult>>
    releaseAsset(sessionId: string, assetId: string): Promise<RpcEnvelope<OkResult>>
    /** Stage 15: red pupils in the picture as the list renders it (the red-eye tool's Auto). */
    eyes(params: EditEyesParams): Promise<RpcEnvelope<EditEyesResult>>
  }
  /** Batch mode of the editor (Stage 16, ADR-0036): a recipe over a selection, as a job. */
  batch: {
    /** Opens the native folder dialog in main; `folder` is a handle and a name, null when cancelled. */
    pickFolder(): Promise<RpcEnvelope<BatchPickFolderResult>>
    /** What the batch would do: counts, the first names, warnings and sample pictures. One call, no pixels. */
    plan(params: BatchParams): Promise<RpcEnvelope<BatchPlanResult>>
    start(params: BatchParams): Promise<RpcEnvelope<JobSnapshot>>
    /** Sends the files a finished batch created to the trash; never the originals. */
    undo(jobId: number): Promise<RpcEnvelope<JobSnapshot>>
  }
  recipes: {
    /** The built-in recipes, then the saved ones. */
    list(): Promise<RpcEnvelope<RecipeListResult>>
    save(params: RecipeSaveParams): Promise<RpcEnvelope<RecipeSaveResult>>
    remove(id: number): Promise<RpcEnvelope<OkResult>>
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
 * Shape of `window.panelyth` in the commander's app view (ADR-0027): only the
 * methods in COMMANDER_METHODS.
 */
/**
 * Panelyth System's API (ADR-0042): the computer, the volumes, a search over
 * volumes, and handing a result to the commander through the shared context.
 */
export interface SystemApi {
  app: {
    exit(): Promise<RpcEnvelope<OkResult>>
    switch(to: AppId): Promise<RpcEnvelope<OkResult>>
    about(): Promise<RpcEnvelope<AboutInfo>>
    openTarget(target: AppTarget): Promise<RpcEnvelope<OkResult>>
  }
  frame: WindowFrameApi
  settings: {
    openWindow(tab?: SettingsTab, section?: string): Promise<RpcEnvelope<OkResult>>
    closeWindow(then?: "shortcuts"): Promise<RpcEnvelope<OkResult>>
  }
  update: {
    get(): Promise<RpcEnvelope<UpdateState>>
    check(): Promise<RpcEnvelope<UpdateState>>
    download(): Promise<RpcEnvelope<UpdateState>>
    install(): Promise<RpcEnvelope<OkResult>>
  }
  sidecar: {
    getStatus(): Promise<RpcEnvelope<SidecarStatus>>
  }
  library: {
    get(): Promise<RpcEnvelope<LibraryState>>
    /** The shared settings only (shared.*); main refuses the apps' own. */
    setSetting(key: string, value: unknown): Promise<RpcEnvelope<OkResult>>
  }
  system: {
    hardware(): Promise<RpcEnvelope<SystemHardware>>
    load(): Promise<RpcEnvelope<SystemLoad>>
  }
  fs: {
    volumes(): Promise<RpcEnvelope<VolumesResult>>
  }
  find: {
    start(params: FindStartParams): Promise<RpcEnvelope<FindStartResult>>
    cancel(findId: number): Promise<RpcEnvelope<FindCancelResult>>
  }
  /** The search's results session. */
  query: {
    page(params: QueryPageParams): Promise<RpcEnvelope<QueryPageResult>>
    close(queryId: number): Promise<RpcEnvelope<QueryCloseResult>>
  }
  dir: {
    /** The folder holding a found entry, for the commander to open. */
    openContaining(entryId: number): Promise<RpcEnvelope<DirOpenResult>>
  }
  context: {
    publish(dirId: number, focusId: number | null): Promise<RpcEnvelope<OkResult>>
  }
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

/**
 * The document window's API (ADR-0033, amended by ADR-0045): its title strip's
 * window buttons and nothing else; the page still reads only its one token.
 */
export interface DocumentFrameApi {
  frame: WindowFrameApi
  /** window.state only. */
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

/**
 * The text editor window's API (ADR-0046), `window.panelyth` there: its own
 * file only, through the session main bound to the window.
 */
export interface TextEditorApi {
  /** The title strip's buttons (ADR-0045). */
  frame: WindowFrameApi
  session(): Promise<RpcEnvelope<TextEditorSession>>
  write(seq: number, text: string): Promise<RpcEnvelope<OkResult>>
  commit(params: TextEditorCommitParams): Promise<RpcEnvelope<TextEditCommitResult>>
  check(): Promise<RpcEnvelope<TextEditCheckResult>>
  setDirty(dirty: boolean): Promise<RpcEnvelope<OkResult>>
  close(discard: boolean): Promise<RpcEnvelope<OkResult>>
  /** Stage C10.7: a picture's bytes in chunks (seq from 0), then the commit into the assets folder. */
  assetChunk(seq: number, data: Uint8Array): Promise<RpcEnvelope<OkResult>>
  assetCommit(name: string): Promise<RpcEnvelope<TextEditAssetCommitResult>>
  /** Stage C10.7: tokens for the pictures these links name. */
  resolveImages(links: string[]): Promise<RpcEnvelope<TextEditorResolveImagesResult>>
  /** Stage C10.8: prints the print view the page laid out to a PDF where the user chooses. */
  exportPdf(params: TextEditorExportParams): Promise<RpcEnvelope<TextEditorExportResult>>
  /** texteditor.closeRequest and settings.changed (the shared appearance). */
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

export interface CommanderApi {
  app: {
    exit(): Promise<RpcEnvelope<OkResult>>
    /** `edit`: show the viewer and open its editor on this picture (Stage 12). */
    switch(to: AppId, edit?: number): Promise<RpcEnvelope<OkResult>>
    /** The product's version and what it runs on (Settings → About). */
    about(): Promise<RpcEnvelope<AboutInfo>>
    /** Opens the log folder, the licence notices or a page of the project. */
    openTarget(target: AppTarget): Promise<RpcEnvelope<OkResult>>
  }
  frame: WindowFrameApi
  /** Settings in a native window (ADR-0039). */
  settings: {
    openWindow(tab?: SettingsTab, section?: string): Promise<RpcEnvelope<OkResult>>
    /** From the settings window only. */
    closeWindow(then?: "shortcuts"): Promise<RpcEnvelope<OkResult>>
  }
  /** Updates (ADR-0038): main checks, downloads and installs; the state arrives as update.state events. */
  update: {
    get(): Promise<RpcEnvelope<UpdateState>>
    check(): Promise<RpcEnvelope<UpdateState>>
    download(): Promise<RpcEnvelope<UpdateState>>
    /** Quits, installs the downloaded version and starts it. */
    install(): Promise<RpcEnvelope<OkResult>>
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
  /** Archives as folders (Stage C07, ADR-0030); pack, unpack and test are `files.start` jobs. */
  archive: {
    open(entryId: number): Promise<RpcEnvelope<ArchiveOpenResult>>
    close(archiveId: number): Promise<RpcEnvelope<ArchiveCloseResult>>
    check(
      selection: SelectionDescriptor,
      destinationDirId: number,
    ): Promise<RpcEnvelope<ArchiveCheckResult>>
    tools(): Promise<RpcEnvelope<ArchiveToolsResult>>
  }
  /**
   * Connections to FTP and FTPS servers (Stage C10.5, ADR-0037). A folder of
   * a connection lists through query.open with remoteId; transfers and
   * deletes are files.start jobs. A password is write-only: it is given to
   * save or connect, and no call returns one.
   */
  remote: {
    /** The saved connections, without secrets. */
    connections(): Promise<RpcEnvelope<ConnectionsResult>>
    /** `password` is encrypted by main before it is stored; `forget` drops the stored one. */
    save(
      connection: SavedConnection,
      password?: string,
      forget?: boolean,
    ): Promise<RpcEnvelope<SavedConnection>>
    remove(connectionId: number): Promise<RpcEnvelope<OkResult>>
    /** Remembers the certificate the user accepted ("" forgets it). */
    trust(connectionId: number, fingerprint: string): Promise<RpcEnvelope<OkResult>>
    connect(params: RemoteConnectParams): Promise<RpcEnvelope<RemoteConnectResult>>
    /** Stops the connect, or the listing, named by its attempt. */
    cancel(attempt: number): Promise<RpcEnvelope<OkResult>>
    disconnect(remoteId: number): Promise<RpcEnvelope<OkResult>>
    /** Lists a folder from the server: by its path, or by its entry id. */
    open(
      remoteId: number,
      folder: string | number,
      attempt?: number,
    ): Promise<RpcEnvelope<RemoteOpenResult>>
    mkdir(remoteDirId: number, name: string): Promise<RpcEnvelope<OkResult>>
    rename(entryId: number, name: string): Promise<RpcEnvelope<OkResult>>
    /** Whether this computer can keep passwords in a secret store. */
    secureStore(): Promise<RpcEnvelope<SecureStoreResult>>
  }
  /**
   * Git (ADR-0043): the status of a panel's folder, runs in the background
   * (their progress is `git.progress`), the commit dialog's change list,
   * branches and the log. Files are a selection or rows of a change list.
   */
  git: {
    status(dirId: number, force?: boolean): Promise<RpcEnvelope<GitStatusResult>>
    changes(dirId: number): Promise<RpcEnvelope<GitChangesResult>>
    run(params: GitRunParams): Promise<RpcEnvelope<GitRunResult>>
    cancel(opId: number): Promise<RpcEnvelope<GitCancelResult>>
    branches(dirId: number): Promise<RpcEnvelope<GitBranchesResult>>
    log(dirId: number, limit?: number): Promise<RpcEnvelope<GitLogResult>>
  }
  /**
   * Compare and synchronize directories (Stage C08): the rows of a compare
   * are a query session; sync, checksum and compare-by-content jobs are
   * files.start jobs.
   */
  compare: {
    dirs(params: CompareDirsParams): Promise<RpcEnvelope<CompareStartResult>>
    cancel(compareId: number): Promise<RpcEnvelope<CompareCancelResult>>
    close(compareId: number): Promise<RpcEnvelope<CompareCloseResult>>
    show(compareId: number, show: readonly CompareShow[]): Promise<RpcEnvelope<CompareView>>
    setAction(
      compareId: number,
      selection: SelectionDescriptor,
      action: DiffAction | "default",
    ): Promise<RpcEnvelope<CompareView>>
    plan(compareId: number): Promise<RpcEnvelope<ComparePlan>>
    /** Shift+F2: what is unique or newer in each of two listings. */
    marks(params: CompareMarksParams): Promise<RpcEnvelope<CompareMarksResult>>
  }
  /** The side-by-side text diff (Stage C08): compared in Go, rows paged. */
  diff: {
    open(leftId: number, rightId: number): Promise<RpcEnvelope<TextDiffOpenResult>>
    page(diffId: number, offset: number, limit: number): Promise<RpcEnvelope<TextDiffPageResult>>
    close(diffId: number): Promise<RpcEnvelope<OkResult>>
  }
  /**
   * Multi-rename (Stage C09): a page of old and new names for a plan, and
   * what the last multi-rename left to undo. The multiRename, undoRename
   * and setAttributes jobs are files.start jobs.
   */
  rename: {
    preview(
      selection: SelectionDescriptor,
      plan: RenamePlan,
      offset: number,
      limit: number,
    ): Promise<RpcEnvelope<RenamePreviewResult>>
    undoInfo(): Promise<RpcEnvelope<RenameUndoInfo>>
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
    /** The panel's entries by type: folders and each extension's count (counted on request). */
    facets(queryId: number): Promise<RpcEnvelope<QueryFacets>>
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
    /** Stage C10.5: the folder tree; immediate subfolders only, hidden ones on request. */
    listDirs(
      path: string,
      showHidden: boolean,
      hideSystem?: boolean,
    ): Promise<RpcEnvelope<ListDirsResult>>
    /** Stage C04: F7 and the delete dialog. */
    mkdir(parentDirId: number, path: string): Promise<RpcEnvelope<FsMkdirResult>>
    canTrash(dirId: number): Promise<RpcEnvelope<FsCanTrashResult>>
    /** Stage C05: Shift+F4's new text file. */
    mkfile(parentDirId: number, name: string): Promise<RpcEnvelope<FsMkfileResult>>
  }
  /** Stage C05: quick view and lister (shared media components, ADR-0025). */
  media: {
    open(entryId: number): Promise<RpcEnvelope<MediaOpenResult>>
    /** An image or video in a frameless full-screen window of its own (ADR-0033). */
    openWindow(
      entryId: number,
      key: number,
      theme?: string,
      lang?: string,
    ): Promise<RpcEnvelope<OkResult>>
    /** The opener's reply to a mediaWindow.step event. */
    windowAnswer(
      requestId: number,
      item: ContentItem | null,
      done?: boolean,
    ): Promise<RpcEnvelope<OkResult>>
    /** The media window: the item it opened for, the previous, next, first or last one, asked of the opener. */
    windowStep(direction: MediaWindowStep): Promise<RpcEnvelope<MediaWindowStepResult>>
    /** The media window: a file command on its item (copy, cut, paste, trash, delete), carried out by the opener. */
    windowCommand(command: MediaWindowCommand): Promise<RpcEnvelope<MediaWindowCommandResult>>
    /** The media window of a file opened from the OS: show its picture in the viewer, at its folder. */
    windowReveal(): Promise<RpcEnvelope<OkResult>>
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
  /** ADR-0033: a PDF or text file in a document window of its own. */
  document: {
    open(entryId: number, theme?: string, lang?: string): Promise<RpcEnvelope<OkResult>>
  }
  /**
   * Stage C05: open with the default app (programs need allowProgram) and
   * edit (F4). Stage C10: the command line and user commands; both run only
   * on the user's Enter or button press (ADR-0027).
   */
  shell: {
    open(entryId: number, allowProgram?: boolean): Promise<RpcEnvelope<OkResult>>
    edit(entryId: number): Promise<RpcEnvelope<OkResult>>
    run(params: ShellRunParams): Promise<RpcEnvelope<OkResult>>
    runTool(params: ShellRunToolParams): Promise<RpcEnvelope<OkResult>>
  }
  /**
   * "Open with" programs (ADR-0044), shared by both apps. A program is picked
   * in main's native dialog; the renderer names programs and entries by id.
   */
  programs: {
    add(): Promise<RpcEnvelope<ProgramsResult>>
    update(programs: ProgramEdit[]): Promise<RpcEnvelope<ProgramsResult>>
    open(programId: string, entryId: number): Promise<RpcEnvelope<OkResult>>
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
  /** Files to other apps (ADR-0040): the OS's drag of the selection. */
  drag: {
    start(selection: SelectionDescriptor): Promise<RpcEnvelope<DragStartResult>>
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
