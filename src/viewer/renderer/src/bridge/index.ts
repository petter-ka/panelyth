// The viewer's only way to window.panelyth. Feature code imports from here
// and receives plain results or PanelythError, never envelopes.
import type {
  AppId,
  BatchFolder,
  BatchParams,
  BatchPlanResult,
  RecipeSaveParams,
  RecipeSaveResult,
  StoredRecipe,
  ClipMode,
  ClipState,
  ConflictPolicy,
  ContentItem,
  JobErrorsResult,
  JobSnapshot,
  JobStartParams,
  Tag,
  Bookmark,
  CopyImageResult,
  CopyPathsResult,
  DragStartResult,
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
  OpenRequest,
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
  EditAsset,
  EditEyesParams,
  NormalizedRect,
  EditColorsParams,
  EditColorsResult,
  EditEstimateParams,
  EditInfoGroup,
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
  PanelythApi,
  PingResult,
  SidecarStatus,
  SystemInfo,
  SettingsTab,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { createBridgeCore, PanelythError, unwrap } from "@panelyth/renderer-core"

declare global {
  interface Window {
    panelyth?: PanelythApi
  }
}

// The envelope handling is shared with the commander (src/shared/renderer-core).
export { PanelythError }

const core = createBridgeCore<PanelythApi>(() => t("Panelyth bridge is not available"))
const api = core.api

export const isBridgeAvailable = core.isAvailable

/** The preload API of Settings → About: the version, updates and the native menu's items (Stage P06). */
export const aboutApi = (): PanelythApi => core.api()

/** True while the commander is enabled: preload then exposes app.switch (ADR-0031). */
export function canSwitchApps(): boolean {
  return window.panelyth?.app.switch !== undefined
}

export const bridge = {
  quit: async (): Promise<void> => {
    await unwrap(() => api().app.exit())
  },
  /** Shows the commander in the same window (ADR-0031). */
  switchToCommander: (): Promise<void> => bridge.switchToApp("commander"),
  /** Shows another app of the family: the commander, or Panelyth System (ADR-0042). */
  switchToApp: async (to: AppId): Promise<void> => {
    const switchApp = api().app.switch
    if (!switchApp) throw new PanelythError("METHOD_NOT_FOUND", t("The commander is not enabled"))
    await unwrap(() => switchApp(to))
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
  /** Settings in a native window (ADR-0039); false when it could not open. */
  openSettingsWindow: async (tab?: SettingsTab): Promise<boolean> =>
    (await unwrap(() => api().settings.openWindow(tab))).ok,
  /** From the settings window: it closes; "shortcuts" has the viewer open its shortcuts dialog. */
  closeSettingsWindow: async (then?: "shortcuts"): Promise<void> => {
    await unwrap(() => api().settings.closeWindow(then))
  },
  /** An image or video in a frameless full-screen window of its own (ADR-0033). */
  openMediaWindow: async (entryId: number, key: number, lang?: string): Promise<void> => {
    await unwrap(() => api().media.openWindow(entryId, key, undefined, lang))
  },
  /** The opener's reply to a mediaWindow.step or mediaWindow.command event. */
  mediaWindowAnswer: async (
    requestId: number,
    item: ContentItem | null,
    done?: boolean,
  ): Promise<void> => {
    await unwrap(() => api().media.windowAnswer(requestId, item, done))
  },
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
  /** Once at start: the folder and entry the app was started to show (a file opened from the OS). */
  takeOpenRequest: async (): Promise<OpenRequest | null> => {
    const ask = api().app.openRequest
    return ask ? (await unwrap(() => ask())).request : null
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
  /** Files to other apps (ADR-0040): main starts the OS's drag of the selection. */
  dragStart: (selection: SelectionDescriptor): Promise<DragStartResult> =>
    unwrap(() => api().drag.start(selection)),
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
  // The image editor (Stage 12, ADR-0035).
  editOpen: (entryId: number): Promise<EditOpenResult> => unwrap(() => api().edit.open(entryId)),
  editRender: (params: EditRenderParams): Promise<EditRenderResult> =>
    unwrap(() => api().edit.render(params)),
  editInfo: async (sessionId: string): Promise<EditInfoGroup[]> =>
    (await unwrap(() => api().edit.info(sessionId))).groups,
  editEstimate: async (params: EditEstimateParams): Promise<number> =>
    (await unwrap(() => api().edit.estimate(params))).bytes,
  editSave: (params: EditSaveParams): Promise<EditSaveResult> =>
    unwrap(() => api().edit.save(params)),
  editClose: async (sessionId: string): Promise<void> => {
    await unwrap(() => api().edit.close(sessionId))
  },
  editSaved: (jobId: number): Promise<EditSavedResult> => unwrap(() => api().edit.saved(jobId)),
  editReveal: async (jobId: number): Promise<void> => {
    await unwrap(() => api().edit.reveal(jobId))
  },
  editProbe: (params: EditProbeParams): Promise<EditProbeResult> =>
    unwrap(() => api().edit.probe(params)),
  editThumbs: (params: EditThumbsParams): Promise<EditThumbsResult> =>
    unwrap(() => api().edit.thumbs(params)),
  editColors: (params: EditColorsParams): Promise<EditColorsResult> =>
    unwrap(() => api().edit.colors(params)),
  editEyes: async (params: EditEyesParams): Promise<NormalizedRect[]> =>
    (await unwrap(() => api().edit.eyes(params))).eyes,
  editFonts: async (sessionId: string): Promise<string[]> =>
    (await unwrap(() => api().edit.fonts(sessionId))).families,
  /** Opens main's file dialog; null when it was cancelled. */
  assetPick: async (sessionId: string): Promise<EditAsset | null> =>
    (await unwrap(() => api().edit.pickAsset(sessionId))).asset,
  assetRelease: async (sessionId: string, assetId: string): Promise<void> => {
    await unwrap(() => api().edit.releaseAsset(sessionId, assetId))
  },
  /** Batch mode (Stage 16): main's folder dialog; a handle and a name, null when cancelled. */
  batchPickFolder: async (): Promise<BatchFolder | null> =>
    (await unwrap(() => api().batch.pickFolder())).folder,
  batchPlan: (params: BatchParams): Promise<BatchPlanResult> =>
    unwrap(() => api().batch.plan(params)),
  batchStart: (params: BatchParams): Promise<JobSnapshot> =>
    unwrap(() => api().batch.start(params)),
  batchUndo: (jobId: number): Promise<JobSnapshot> => unwrap(() => api().batch.undo(jobId)),
  recipeList: async (): Promise<StoredRecipe[]> =>
    (await unwrap(() => api().recipes.list())).recipes,
  recipeSave: (params: RecipeSaveParams): Promise<RecipeSaveResult> =>
    unwrap(() => api().recipes.save(params)),
  recipeDelete: async (id: number): Promise<void> => {
    await unwrap(() => api().recipes.remove(id))
  },
  on: core.on,
}
