import {
  APP_IDS,
  APP_METHODS,
  DEV_RENDERER_METHODS,
  IPC_EVENT,
  IPC_INVOKE,
  MAIN_METHODS,
  SHARED_PROGRAMS_KEY,
  SIDECAR_EVENT_CHANNELS,
  FRAME_METHODS,
  TEXTEDITOR_METHODS,
  eventGuards,
  type AppId,
  type EventChannel,
  type EventFrame,
  type EventMessage,
  type EventMap,
  type MainMethodMap,
  type RendererMethod,
  type RpcEnvelope,
  type SidecarMethod,
  type SidecarStatus,
  type TextEditorMethod,
} from "@panelyth/contracts"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { RpcError } from "../sidecar/RpcClient"
import { isTrustedSender, originOf } from "../security"
import { validators } from "./validate"

/** The subset of SidecarProcess the router needs; keeps it unit-testable. */
export interface SidecarPort {
  call(method: SidecarMethod, params: unknown, options?: { timeoutMs?: number }): Promise<unknown>
  getStatus(): SidecarStatus
}

type MainMethod = Exclude<keyof MainMethodMap, TextEditorMethod>

/**
 * Handlers for methods answered in main (dialogs, status). `app` is the
 * calling app view, so a handler can apply that app's profile (ADR-0027).
 */
export type MainHandlers = {
  [M in MainMethod]: (
    event: IpcMainInvokeEvent,
    params: MainMethodMap[M]["params"],
    app: AppId,
  ) => Promise<MainMethodMap[M]["result"]> | MainMethodMap[M]["result"]
}

/**
 * The text editor window's methods (ADR-0046), answered in main for the
 * window that calls: its session is found by the sender.
 */
export type TextEditorHandlers = {
  [M in TextEditorMethod]: (
    event: IpcMainInvokeEvent,
    params: MainMethodMap[M]["params"],
  ) => Promise<MainMethodMap[M]["result"]> | MainMethodMap[M]["result"]
}

export interface RouterOptions {
  sidecar: SidecarPort
  main: MainHandlers
  /** Each app view's origin; a call is checked against the profile of the origin it came from (ADR-0027). */
  origins: Readonly<Record<AppId, string>>
  devMethods: boolean
  /** Called after a successful library.setSetting of a shared.* key, so the other app can apply it. */
  onSharedSetting?: (key: string, value: unknown) => void
  /** Called after every successful library.setSetting, with its sender (the settings window relays its writes; ADR-0039). */
  onSettingWritten?: (sender: WebContents, key: string, value: unknown) => void
  /** The visible app; only it may publish the shared context (ADR-0031). Absent = any app. */
  activeApp?: () => AppId
  /** The text editor window's origin and methods (ADR-0046): a profile of its own, not an app's. */
  textEditor?: { origin: string; handlers: TextEditorHandlers }
  /** The document window's origin (ADR-0033): its title strip's window calls and nothing else. */
  documentsOrigin?: string
}

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  method: unknown,
  params: unknown,
) => Promise<RpcEnvelope<unknown>>

const mainMethods: ReadonlySet<string> = new Set(MAIN_METHODS)
const textEditorMethods: ReadonlySet<string> = new Set(TEXTEDITOR_METHODS)
const frameMethods: ReadonlySet<string> = new Set(FRAME_METHODS)

/**
 * Calls that may take longer than the default 10 s: Git reads a large
 * repository's whole status (ADR-0043; the sidecar gives up at 60 s).
 */
const SLOW_CALLS: Readonly<Partial<Record<string, number>>> = {
  "git.status": 65_000,
  "git.changes": 65_000,
  "git.branches": 30_000,
  "git.log": 30_000,
}

// Accepted calls per method: cheap evidence for "one call per range, not per
// tile" in benchmarks. Main-process only; the renderer cannot read it.
const invokeCounts = new Map<string, number>()

export function ipcInvokeCounts(): Record<string, number> {
  return Object.fromEntries(invokeCounts)
}

const fail = (code: RpcError["code"], message: string): RpcEnvelope<never> => ({
  ok: false,
  e: { code, message, retryable: false },
})

/**
 * Builds the single `fv:invoke` handler: sender check → allowlist → param
 * validation → main-local method or forward to Go. Always resolves to an
 * envelope; errors never cross IPC as thrown exceptions.
 */
export function createInvokeHandler(options: RouterOptions): InvokeHandler {
  const allowed = Object.fromEntries(
    APP_IDS.map((app) => [
      app,
      new Set<string>([
        ...APP_METHODS[app],
        ...(options.devMethods && app === "viewer" ? DEV_RENDERER_METHODS : []),
      ]),
    ]),
  ) as unknown as Record<AppId, ReadonlySet<string>>

  /**
   * A window that is no app view: its own window calls (the title strip's
   * buttons; main resolves the window from the sender), and its own methods.
   */
  const windowCall = async (
    event: IpcMainInvokeEvent,
    method: unknown,
    params: unknown,
    own: ReadonlySet<string>,
    handle: (method: string, params: unknown) => unknown,
  ): Promise<RpcEnvelope<unknown>> => {
    if (typeof method !== "string" || !(own.has(method) || frameMethods.has(method))) {
      return fail("METHOD_NOT_FOUND", `method not allowed: ${String(method)}`)
    }
    const invalid = validators[method as RendererMethod](params)
    if (invalid) return fail("INVALID_ARGUMENT", invalid)
    invokeCounts.set(method, (invokeCounts.get(method) ?? 0) + 1)
    try {
      if (frameMethods.has(method)) {
        // `app` only tells an app view whether it is on screen; this sender is none.
        const frame = options.main[method as "window.getState"] as (
          e: IpcMainInvokeEvent,
          p: unknown,
          a: AppId,
        ) => unknown
        return { ok: true, r: await frame(event, params ?? {}, "viewer") }
      }
      return { ok: true, r: await handle(method, params ?? {}) }
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, e: error.toShape() }
      return fail("INTERNAL", String(error))
    }
  }
  const noOwnMethods: ReadonlySet<string> = new Set()

  return async (event, method, params) => {
    // The text editor window: its own file and nothing else (ADR-0046).
    const editor = options.textEditor
    if (editor && isTrustedSender(event.senderFrame, editor.origin)) {
      return windowCall(event, method, params, textEditorMethods, (m, p) =>
        (editor.handlers[m as TextEditorMethod] as (e: IpcMainInvokeEvent, p: unknown) => unknown)(
          event,
          p,
        ),
      )
    }
    // The document window: its title strip's buttons only (ADR-0033, amended).
    if (options.documentsOrigin && isTrustedSender(event.senderFrame, options.documentsOrigin)) {
      return windowCall(event, method, params, noOwnMethods, () => undefined)
    }
    const app = APP_IDS.find((id) => isTrustedSender(event.senderFrame, options.origins[id]))
    if (!app) return fail("PERMISSION_DENIED", "untrusted sender")
    if (typeof method !== "string" || !allowed[app].has(method)) {
      return fail("METHOD_NOT_FOUND", `method not allowed: ${String(method)}`)
    }
    const invalid = validators[method as RendererMethod](params)
    if (invalid) return fail("INVALID_ARGUMENT", invalid)
    const denied = profileProblem(app, method, params)
    if (denied) return fail("PERMISSION_DENIED", denied)
    // A hidden app's publish is dropped: the visible app owns the context.
    if (method === "context.publish" && options.activeApp && options.activeApp() !== app) {
      return { ok: true, r: { ok: false } }
    }
    invokeCounts.set(method, (invokeCounts.get(method) ?? 0) + 1)

    try {
      if (mainMethods.has(method)) {
        const handler = options.main[method as MainMethod] as (
          e: IpcMainInvokeEvent,
          p: unknown,
          a: AppId,
        ) => unknown
        return { ok: true, r: await handler(event, params ?? {}, app) }
      }
      const r = await options.sidecar.call(
        method as SidecarMethod,
        // An edit session belongs to the calling window: one each (ADR-0035).
        method === "edit.open"
          ? { ...(params as object), owner: event.sender.id }
          : profileParams(app, method, params),
        ...(SLOW_CALLS[method] ? [{ timeoutMs: SLOW_CALLS[method] }] : []),
      )
      if (method === "library.setSetting") {
        const { key, value } = params as { key: string; value: unknown }
        if (key.startsWith("shared.")) options.onSharedSetting?.(key, value)
        options.onSettingWritten?.(event.sender, key, value)
      }
      return { ok: true, r }
    } catch (error) {
      if (error instanceof RpcError) return { ok: false, e: error.toShape() }
      return fail("INTERNAL", String(error))
    }
  }
}

/**
 * Per-app parameter rules on top of the allowlist (ADR-0027): an app
 * publishes the shared context only as itself, and the viewer lists media
 * only (the `all` scope is the commander's, ADR-0026).
 */
const COMMANDER_JOB_KINDS: ReadonlySet<unknown> = new Set([
  "copy",
  "move",
  "trash",
  "delete",
  "dirSize",
  // Stage C07: copy out of archives and unpack, pack, test.
  "extract",
  "pack",
  "testArchive",
  // Stage C08: synchronize, checksums, compare by content.
  "sync",
  "hashCreate",
  "hashVerify",
  "compareFiles",
  // Stage C09: multi-rename with its undo, attributes and dates.
  "multiRename",
  "undoRename",
  "setAttributes",
  // Stage C10.5: between a connection and this computer (ADR-0037).
  "download",
  "upload",
  "remoteDelete",
])

/** Jobs only the commander starts: archives (C07), compare jobs (C08), multi-rename and attributes (C09). */
const COMMANDER_ONLY_JOB_KINDS: ReadonlySet<unknown> = new Set([
  "extract",
  "pack",
  "testArchive",
  "sync",
  "hashCreate",
  "hashVerify",
  "compareFiles",
  "multiRename",
  "undoRename",
  "setAttributes",
  "download",
  "upload",
  "remoteDelete",
])

function profileProblem(app: AppId, method: string, params: unknown): string | null {
  const p = params as Record<string, unknown>
  // Each app's settings window shows that app's own tab only (ADR-0039).
  if (
    method === "settings.openWindow" &&
    (p.tab === "viewer" || p.tab === "commander") &&
    p.tab !== app
  ) {
    return "the other app's settings are the other app's"
  }
  if (method === "context.publish" && p.app !== app) return "context.publish is for the calling app"
  // ADR-0044: main starts the "Open with" programs, so only main writes their
  // list (programs.add picks a path in its own dialog).
  if (method === "library.setSetting" && p.key === SHARED_PROGRAMS_KEY) {
    return "the programs are changed through programs.add and programs.update"
  }
  // Panelyth System (ADR-0042) writes the shared settings only (the appearance).
  if (
    app === "system" &&
    method === "library.setSetting" &&
    !(typeof p.key === "string" && p.key.startsWith("shared."))
  ) {
    return "Panelyth System writes the shared settings only"
  }
  // Stage 12: only the commander hands a picture over, and only to the viewer's editor.
  if (
    method === "app.switch" &&
    p.edit !== undefined &&
    (app !== "commander" || p.to !== "viewer")
  ) {
    return "only the commander asks the viewer to edit a picture"
  }
  if (
    app === "viewer" &&
    method === "query.open" &&
    (p.scope === "all" ||
      p.findId !== undefined ||
      p.archiveId !== undefined ||
      p.remoteId !== undefined)
  ) {
    return "the viewer lists media only"
  }
  // The commander's settings include the F4 editor that main starts (Stage C05):
  // only the commander's own view may write them.
  if (
    app === "viewer" &&
    method === "library.setSetting" &&
    typeof p.key === "string" &&
    p.key.startsWith("commander.")
  ) {
    return "commander settings are the commander's"
  }
  // Stage C10.5: hidden folders are the commander's to list (ADR-0026).
  if (
    app === "viewer" &&
    method === "fs.listDirs" &&
    (p.showHidden !== undefined || p.hideSystem !== undefined)
  ) {
    return "the viewer's tree lists visible folders only"
  }
  if (app === "viewer" && method === "jobs.start" && COMMANDER_ONLY_JOB_KINDS.has(p.kind)) {
    return "archive, compare, multi-rename and attribute jobs are the commander's"
  }
  if (app === "commander") {
    // Stage C04: its jobs are file operations, and destinations are folder
    // ids resolved in Go, never paths from the renderer (ADR-0027).
    if (method === "jobs.start" && !COMMANDER_JOB_KINDS.has(p.kind)) {
      return "the commander starts file operations, folder sizes, archive, compare, rename and attribute jobs only"
    }
    if ((method === "jobs.start" || method === "clip.paste") && p.destination !== undefined) {
      return "the commander names destinations by folder id"
    }
  }
  return null
}

/** Folder and query opens name the calling app to the sidecar (Stage P02, ADR-0026). */
const CALLER_APP_METHODS: ReadonlySet<string> = new Set([
  "dir.open",
  "dir.openEntry",
  "dir.openContaining",
  "query.open",
  // A search's results session is the app's that started it (ADR-0042).
  "find.start",
  // Each app lists the jobs it started (ADR-0031 amended).
  "jobs.start",
  "clip.paste",
  "jobs.list",
])

/**
 * What main adds to a call, never a renderer (ADR-0027):
 * - the calling app on folder and query opens (ADR-0026): the sidecar
 *   watches a folder while its app is on screen and budgets sessions per app;
 * - the calling app on job starts and the job list (ADR-0031 amended);
 * - per-app job options (ADR-0029): the commander copies links as links; the
 *   viewer skips them.
 */
export function profileParams(app: AppId, method: string, params: unknown): unknown {
  if (params !== undefined && params !== null && typeof params !== "object") return params
  let p = (params ?? {}) as Record<string, unknown>
  if (
    app === "commander" &&
    (method === "clip.paste" ||
      (method === "jobs.start" && (p.kind === "copy" || p.kind === "move")))
  ) {
    p = { ...p, copyLinks: true }
  }
  // Last, so a renderer cannot name another app.
  return CALLER_APP_METHODS.has(method) ? { ...p, app } : p
}

/**
 * The pages a sidecar event goes to: a job's events to the pages of the app
 * that started it (ADR-0031 amended), so the other app neither lists nor
 * hears of it; everything else to every page.
 */
export function eventTargets<W extends { getURL(): string }>(
  message: EventMessage,
  all: readonly W[],
  origins: Readonly<Record<AppId, string>>,
): W[] {
  if (message.ch !== "job.progress" && message.ch !== "job.conflict") return [...all]
  const app = (message.p as { app?: unknown }).app
  if (!(APP_IDS as readonly unknown[]).includes(app)) return [...all]
  const origin = origins[app as AppId]
  return all.filter((wc) => originOf(wc.getURL()) === origin)
}

export interface IpcMainLike {
  handle(channel: string, listener: InvokeHandler): void
  removeHandler(channel: string): void
}

export function registerIpc(ipcMain: IpcMainLike, options: RouterOptions): () => void {
  ipcMain.handle(IPC_INVOKE, createInvokeHandler(options))
  return () => ipcMain.removeHandler(IPC_INVOKE)
}

export function broadcast<C extends EventChannel>(
  targets: readonly WebContents[],
  channel: C,
  payload: EventMap[C],
): void {
  const message: EventMessage<C> = { ch: channel, p: payload }
  for (const wc of targets) if (!wc.isDestroyed()) wc.send(IPC_EVENT, message)
}

const sidecarChannels: ReadonlySet<string> = new Set(SIDECAR_EVENT_CHANNELS)

/**
 * Validates a sidecar event for forwarding. Go already coalesces, so this is
 * one cheap shape check per batch, never per file. Unknown or malformed
 * events are dropped.
 */
export function forwardableEvent(frame: EventFrame): EventMessage | null {
  if (!sidecarChannels.has(frame.ch)) return null
  const channel = frame.ch as EventChannel
  return eventGuards[channel](frame.p) ? ({ ch: channel, p: frame.p } as EventMessage) : null
}
