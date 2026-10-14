import type {
  ContentItem,
  AppId,
  ArchiveCheckResult,
  ArchiveOpenResult,
  Bookmark,
  ClipMode,
  ClipState,
  CommanderJobParams,
  CompareDirsParams,
  CompareMarksParams,
  CompareMarksResult,
  ComparePlan,
  CompareShow,
  CompareStartResult,
  CompareView,
  ConflictDecision,
  ConflictPolicy,
  CopyPathsResult,
  DiffAction,
  FsMkdirResult,
  FsMkfileResult,
  FileOpenResult,
  FindStartParams,
  FindStartResult,
  MediaOpenResult,
  PreviewEnsureParams,
  PreviewEnsureResult,
  PreviewProfile,
  Properties,
  RenamePlan,
  RenamePreviewResult,
  RenameUndoInfo,
  JobErrorsResult,
  CommanderApi,
  DirOpenResult,
  LibraryState,
  ListDirsResult,
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
  RemoteConnectParams,
  RemoteConnectResult,
  RemoteOpenResult,
  SavedConnection,
  SharedContext,
  ShellRunToolParams,
  SidecarStatus,
  TextDiffOpenResult,
  TextDiffPageResult,
  Volume,
  SettingsTab,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { createBridgeCore, PanelythError, unwrap } from "@panelyth/renderer-core"

// The envelope handling is shared with the viewer (src/shared/renderer-core).
export { PanelythError }

/** The commander's narrow API (ADR-0027); everything goes through here. */
const core = createBridgeCore<CommanderApi>(() => t("Panelyth bridge unavailable"))
const api = core.api

export const isBridgeAvailable = core.isAvailable

/** The preload API of Settings → About: the version, updates and the native menu's items (Stage P06). */
export const aboutApi = (): CommanderApi => core.api()

let library: Promise<LibraryState> | null = null

/** Tests: forget the cached library.db read. */
export function resetBridgeCache(): void {
  library = null
}

export const bridge = {
  switchTo: async (to: AppId): Promise<void> => {
    await unwrap(() => api().app.switch(to))
  },
  /** Shows the viewer with its editor open on a picture (Stage 12); the commander itself edits nothing (ADR-0027). */
  editInViewer: async (entryId: number): Promise<void> => {
    await unwrap(() => api().app.switch("viewer", entryId))
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
  // Stage C08: compare and synchronize directories, the text diff.
  compareDirs: (p: CompareDirsParams): Promise<CompareStartResult> =>
    unwrap(() => api().compare.dirs(p)),
  compareCancel: async (compareId: number): Promise<boolean> =>
    (await unwrap(() => api().compare.cancel(compareId))).cancelled,
  compareClose: async (compareId: number): Promise<void> => {
    await unwrap(() => api().compare.close(compareId))
  },
  compareShow: (compareId: number, show: readonly CompareShow[]): Promise<CompareView> =>
    unwrap(() => api().compare.show(compareId, show)),
  compareSetAction: (
    compareId: number,
    selection: SelectionDescriptor,
    action: DiffAction | "default",
  ): Promise<CompareView> => unwrap(() => api().compare.setAction(compareId, selection, action)),
  comparePlan: (compareId: number): Promise<ComparePlan> =>
    unwrap(() => api().compare.plan(compareId)),
  /** Shift+F2: what is unique or newer in each of two listings. */
  compareMarks: (p: CompareMarksParams): Promise<CompareMarksResult> =>
    unwrap(() => api().compare.marks(p)),
  diffOpen: (leftId: number, rightId: number): Promise<TextDiffOpenResult> =>
    unwrap(() => api().diff.open(leftId, rightId)),
  diffPage: (diffId: number, offset: number, limit: number): Promise<TextDiffPageResult> =>
    unwrap(() => api().diff.page(diffId, offset, limit)),
  diffClose: async (diffId: number): Promise<void> => {
    await unwrap(() => api().diff.close(diffId))
  },
  // Stage C09: the multi-rename preview (one page of it) and what can be undone.
  renamePreview: (
    selection: SelectionDescriptor,
    plan: RenamePlan,
    offset: number,
    limit: number,
  ): Promise<RenamePreviewResult> =>
    unwrap(() => api().rename.preview(selection, plan, offset, limit)),
  renameUndoInfo: (): Promise<RenameUndoInfo> => unwrap(() => api().rename.undoInfo()),
  cancelScan: async (scanId: number): Promise<void> => {
    await unwrap(() => api().dir.cancelScan(scanId))
  },
  openQuery: (d: QueryDescriptor): Promise<QuerySnapshot> => unwrap(() => api().query.open(d)),
  /** thumbProfile: the Thumbnails view's pages carry their cached thumbnails (Stage C10). */
  page: (
    queryId: number,
    offset: number,
    limit: number,
    thumbProfile: PreviewProfile | null = null,
  ): Promise<QueryPageResult> =>
    unwrap(() => api().query.page({ queryId, offset, limit, thumbProfile })),
  closeQuery: async (queryId: number): Promise<void> => {
    await unwrap(() => api().query.close(queryId))
  },
  indexOf: (queryId: number, entryId: number): Promise<QueryIndexOfResult> =>
    unwrap(() => api().query.indexOf(queryId, entryId)),
  volumes: async (): Promise<Volume[]> => (await unwrap(() => api().fs.volumes())).volumes,
  // Stage C10.5 (ADR-0037): connections. A password goes to main and never comes back.
  connections: async (): Promise<SavedConnection[]> =>
    (await unwrap(() => api().remote.connections())).connections,
  saveConnection: (
    connection: SavedConnection,
    password?: string,
    forget?: boolean,
  ): Promise<SavedConnection> => unwrap(() => api().remote.save(connection, password, forget)),
  removeConnection: async (connectionId: number): Promise<void> => {
    await unwrap(() => api().remote.remove(connectionId))
  },
  trustConnection: async (connectionId: number, fingerprint: string): Promise<void> => {
    await unwrap(() => api().remote.trust(connectionId, fingerprint))
  },
  remoteConnect: (params: RemoteConnectParams): Promise<RemoteConnectResult> =>
    unwrap(() => api().remote.connect(params)),
  remoteCancel: async (attempt: number): Promise<void> => {
    await unwrap(() => api().remote.cancel(attempt))
  },
  remoteDisconnect: async (remoteId: number): Promise<void> => {
    await unwrap(() => api().remote.disconnect(remoteId))
  },
  remoteOpen: (
    remoteId: number,
    folder: string | number,
    attempt?: number,
  ): Promise<RemoteOpenResult> => unwrap(() => api().remote.open(remoteId, folder, attempt)),
  remoteMkdir: async (remoteDirId: number, name: string): Promise<void> => {
    await unwrap(() => api().remote.mkdir(remoteDirId, name))
  },
  remoteRename: async (entryId: number, name: string): Promise<void> => {
    await unwrap(() => api().remote.rename(entryId, name))
  },
  secureStore: async (): Promise<boolean> =>
    (await unwrap(() => api().remote.secureStore())).available,
  /** Stage C10.5: the folder tree; one level of subfolders. */
  listDirs: (path: string, showHidden: boolean): Promise<ListDirsResult> =>
    unwrap(() => api().fs.listDirs(path, showHidden)),
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
  /** Settings in a native window (ADR-0039); false when it could not open. */
  openSettingsWindow: async (tab?: SettingsTab): Promise<boolean> =>
    (await unwrap(() => api().settings.openWindow(tab))).ok,
  /** From the settings window: it closes; "shortcuts" has the commander open its shortcuts dialog. */
  closeSettingsWindow: async (then?: "shortcuts"): Promise<void> => {
    await unwrap(() => api().settings.closeWindow(then))
  },
  /** An image or video in a frameless full-screen window of its own (ADR-0033). */
  openMediaWindow: async (
    entryId: number,
    key: number,
    theme?: string,
    lang?: string,
  ): Promise<void> => {
    await unwrap(() => api().media.openWindow(entryId, key, theme, lang))
  },
  /** The media window: the first (0), previous (-1) or next (1) item, asked of the opener. */
  mediaWindowStep: async (direction: -1 | 0 | 1): Promise<ContentItem | null> =>
    (await unwrap(() => api().media.windowStep(direction))).item,
  /** The media window of a file opened from the OS: its picture in the viewer, at its folder. */
  mediaWindowReveal: async (): Promise<void> => {
    await unwrap(() => api().media.windowReveal())
  },
  /** The opener's reply to a mediaWindow.step event. */
  mediaWindowAnswer: async (requestId: number, item: ContentItem | null): Promise<void> => {
    await unwrap(() => api().media.windowAnswer(requestId, item))
  },
  ensurePreviews: (params: PreviewEnsureParams): Promise<PreviewEnsureResult> =>
    unwrap(() => api().preview.ensure(params)),
  properties: (entryId: number): Promise<Properties> => unwrap(() => api().props.get(entryId)),
  /** A read-only token URL for any file; its bytes are read with HTTP Range. */
  openFile: (entryId: number): Promise<FileOpenResult> => unwrap(() => api().file.open(entryId)),
  /** A PDF or text file in a document window of its own (ADR-0033). */
  openDocument: async (entryId: number, theme?: string, lang?: string): Promise<void> => {
    await unwrap(() => api().document.open(entryId, theme, lang))
  },
  /** Opens with the default app; a program needs allowProgram (PERMISSION_DENIED, reason "program"). */
  shellOpen: async (entryId: number, allowProgram?: boolean): Promise<void> => {
    await unwrap(() => api().shell.open(entryId, allowProgram))
  },
  shellEdit: async (entryId: number): Promise<void> => {
    await unwrap(() => api().shell.edit(entryId))
  },
  /**
   * Stage C10: a line typed in the command line, run by main through the OS
   * shell in the folder `dirId`. Called on Enter only (ADR-0027).
   */
  shellRun: async (command: string, dirId: number, console = false): Promise<void> => {
    await unwrap(() => api().shell.run({ command, dirId, ...(console && { console: true }) }))
  },
  /** A user command, by its id in commander.tools; main fills its placeholders from these ids. */
  shellRunTool: async (params: ShellRunToolParams): Promise<void> => {
    await unwrap(() => api().shell.runTool(params))
  },
  mkfile: (parentDirId: number, name: string): Promise<FsMkfileResult> =>
    unwrap(() => api().fs.mkfile(parentDirId, name)),
  on: core.on,
}
