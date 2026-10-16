import type {
  AppId,
  DirOpenResult,
  FindStartParams,
  FindStartResult,
  LibraryState,
  QueryPageResult,
  SettingsTab,
  SidecarStatus,
  SystemApi,
  SystemHardware,
  SystemLoad,
  Volume,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { createBridgeCore, PanelythError, unwrap } from "@panelyth/renderer-core"

export { PanelythError }

/** Panelyth System's narrow API (ADR-0042, ADR-0027); everything goes through here. */
const core = createBridgeCore<SystemApi>(() => t("Panelyth bridge unavailable"))
const api = core.api

export const isBridgeAvailable = core.isAvailable

/** The preload API of Settings → About: the version and updates. */
export const aboutApi = (): SystemApi => core.api()

export const bridge = {
  hardware: (): Promise<SystemHardware> => unwrap(() => api().system.hardware()),
  load: (): Promise<SystemLoad> => unwrap(() => api().system.load()),
  volumes: async (): Promise<Volume[]> => (await unwrap(() => api().fs.volumes())).volumes,
  startFind: (params: FindStartParams): Promise<FindStartResult> =>
    unwrap(() => api().find.start(params)),
  cancelFind: async (findId: number): Promise<void> => {
    await unwrap(() => api().find.cancel(findId))
  },
  page: (queryId: number, offset: number, limit: number): Promise<QueryPageResult> =>
    unwrap(() => api().query.page({ queryId, offset, limit, thumbProfile: null })),
  closeQuery: async (queryId: number): Promise<void> => {
    await unwrap(() => api().query.close(queryId))
  },
  /** The folder holding a found entry. */
  containingFolder: (entryId: number): Promise<DirOpenResult> =>
    unwrap(() => api().dir.openContaining(entryId)),
  publishContext: async (dirId: number, focusId: number | null): Promise<void> => {
    await unwrap(() => api().context.publish(dirId, focusId))
  },
  switchTo: async (to: AppId): Promise<void> => {
    await unwrap(() => api().app.switch(to))
  },
  sidecarStatus: (): Promise<SidecarStatus> => unwrap(() => api().sidecar.getStatus()),
  library: (): Promise<LibraryState> => unwrap(() => api().library.get()),
  setSetting: async (key: string, value: unknown): Promise<void> => {
    await unwrap(() => api().library.setSetting(key, value))
  },
  /** Opens the settings window; false when it could not open. */
  openSettingsWindow: async (tab?: SettingsTab): Promise<boolean> =>
    (await unwrap(() => api().settings.openWindow(tab))).ok,
  closeSettingsWindow: async (then?: "shortcuts"): Promise<void> => {
    await unwrap(() => api().settings.closeWindow(then))
  },
  on: core.on,
}
