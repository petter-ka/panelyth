import {
  SHARED_UPDATES_KEY,
  type AboutInfo,
  type AppTarget,
  type EventChannel,
  type EventMap,
  type MenuCommand,
  type OkResult,
  type RpcEnvelope,
  type UpdateState,
} from "@panelyth/contracts"
import { create } from "zustand"
import { unwrap } from "./bridge"

/**
 * Settings → About (Stage P06, ADR-0038): the product's version and its
 * updates. Main owns both; the apps show the state it sends and name the next
 * step. One store in each app view, fed by that app's bridge.
 */
export interface AboutPort {
  about(): Promise<AboutInfo>
  updateState(): Promise<UpdateState>
  check(): Promise<UpdateState>
  download(): Promise<UpdateState>
  install(): Promise<void>
  openTarget(target: AppTarget): Promise<void>
  saveSetting(key: string, value: unknown): void
  onUpdateState(listener: (state: UpdateState) => void): () => void
  onMenuCommand(listener: (command: MenuCommand) => void): () => void
}

/** The part of a preload API the About tab uses; both apps' profiles have it (ADR-0027). */
export interface AboutApi {
  app: {
    about(): Promise<RpcEnvelope<AboutInfo>>
    openTarget(target: AppTarget): Promise<RpcEnvelope<OkResult>>
  }
  update: {
    get(): Promise<RpcEnvelope<UpdateState>>
    check(): Promise<RpcEnvelope<UpdateState>>
    download(): Promise<RpcEnvelope<UpdateState>>
    install(): Promise<RpcEnvelope<OkResult>>
  }
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

/** The port of an app's bridge: its preload API and its way to save a setting. */
export function aboutPortOf(
  api: () => AboutApi,
  saveSetting: (key: string, value: unknown) => void,
): AboutPort {
  return {
    about: () => unwrap(() => api().app.about()),
    updateState: () => unwrap(() => api().update.get()),
    check: () => unwrap(() => api().update.check()),
    download: () => unwrap(() => api().update.download()),
    install: async () => {
      await unwrap(() => api().update.install())
    },
    openTarget: async (target) => {
      await unwrap(() => api().app.openTarget(target))
    },
    saveSetting,
    onUpdateState: (listener) => api().onEvent("update.state", listener),
    onMenuCommand: (listener) => api().onEvent("menu.command", (e) => listener(e.command)),
  }
}

export interface AboutState {
  info: AboutInfo | null
  update: UpdateState | null
  /** Why the last action of the tab failed (a missing notices file, a refused call). */
  problem: string | null
}

export const useAboutStore = create<AboutState>(() => ({ info: null, update: null, problem: null }))

let port: AboutPort | null = null

const failed = (error: unknown): void =>
  useAboutStore.setState({ problem: error instanceof Error ? error.message : String(error) })

/**
 * Follows the update state and the native menu's items. The state is asked
 * for after listening, and main takes that as the sign that the app can
 * carry out a menu item chosen before it was up.
 */
export function startAboutSync(
  aboutPort: AboutPort,
  onMenuCommand: (command: MenuCommand) => void,
): () => void {
  port = aboutPort
  let pushed = false
  const offState = aboutPort.onUpdateState((update) => {
    pushed = true
    useAboutStore.setState({ update })
  })
  const offMenu = aboutPort.onMenuCommand(onMenuCommand)
  void aboutPort
    .updateState()
    // An event that arrived meanwhile is newer than this answer.
    .then((update) => !pushed && useAboutStore.setState({ update }))
    .catch(() => undefined)
  return () => {
    offState()
    offMenu()
    port = null
  }
}

/** The build's details, read when the About tab is first shown. */
export function loadAbout(): void {
  if (!port || useAboutStore.getState().info) return
  void port
    .about()
    .then((info) => useAboutStore.setState({ info }))
    .catch(failed)
}

/**
 * Asks main for the next step. The state it leads to arrives as update.state
 * events, in order; the call's own answer can be older than an event that
 * overtook it (a check that finishes at once), so it is not shown.
 */
function step(action: (p: AboutPort) => Promise<UpdateState>): void {
  if (!port) return
  useAboutStore.setState({ problem: null })
  void action(port).catch(failed)
}

export const checkForUpdates = (): void => step((p) => p.check())
export const downloadUpdate = (): void => step((p) => p.download())

/** Quits, installs and starts the new version. */
export function installUpdate(): void {
  if (!port) return
  void port.install().catch(failed)
}

export function openAppTarget(target: AppTarget): void {
  if (!port) return
  useAboutStore.setState({ problem: null })
  void port.openTarget(target).catch(failed)
}

/** "Check automatically": saved as shared.updates; main follows it and the other app sees the new state. */
export function setAutoUpdateCheck(auto: boolean): void {
  const update = useAboutStore.getState().update
  if (update) useAboutStore.setState({ update: { ...update, auto } })
  port?.saveSetting(SHARED_UPDATES_KEY, { v: 1, auto })
}

/** True when a newer version is waiting for the user: found, or downloaded. */
export const updateWaiting = (state: AboutState): boolean =>
  state.update !== null &&
  state.update.mode !== "off" &&
  (state.update.phase === "available" || state.update.phase === "ready")
