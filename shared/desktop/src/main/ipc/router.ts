import {
  APP_IDS,
  APP_METHODS,
  DEV_RENDERER_METHODS,
  IPC_EVENT,
  IPC_INVOKE,
  MAIN_METHODS,
  SIDECAR_EVENT_CHANNELS,
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
} from "@fastview/contracts"
import type { IpcMainInvokeEvent, WebContents } from "electron"
import { RpcError } from "../sidecar/RpcClient"
import { isTrustedSender } from "../security"
import { validators } from "./validate"

/** The subset of SidecarProcess the router needs; keeps it unit-testable. */
export interface SidecarPort {
  call(method: SidecarMethod, params: unknown): Promise<unknown>
  getStatus(): SidecarStatus
}

type MainMethod = keyof MainMethodMap

/** Handlers for methods answered in main (dialogs, status). */
export type MainHandlers = {
  [M in MainMethod]: (
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
  /** The visible app; only it may publish the shared context (ADR-0031). Absent = any app. */
  activeApp?: () => AppId
}

type InvokeHandler = (
  event: IpcMainInvokeEvent,
  method: unknown,
  params: unknown,
) => Promise<RpcEnvelope<unknown>>

const mainMethods: ReadonlySet<string> = new Set(MAIN_METHODS)

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

  return async (event, method, params) => {
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
        ) => unknown
        return { ok: true, r: await handler(event, params ?? {}) }
      }
      const r = await options.sidecar.call(method as SidecarMethod, params ?? {})
      if (method === "library.setSetting") {
        const { key, value } = params as { key: string; value: unknown }
        if (key.startsWith("shared.")) options.onSharedSetting?.(key, value)
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
function profileProblem(app: AppId, method: string, params: unknown): string | null {
  const p = params as Record<string, unknown>
  if (method === "context.publish" && p.app !== app) return "context.publish is for the calling app"
  if (app === "viewer" && method === "query.open" && p.scope === "all") {
    return "the viewer lists media only"
  }
  // The commander's file operations arrive in Stage C04; until then only folder sizes.
  if (app === "commander" && method === "jobs.start" && p.kind !== "dirSize") {
    return "the commander can only calculate folder sizes yet"
  }
  return null
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
