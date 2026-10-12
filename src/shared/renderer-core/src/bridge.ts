import type { ErrorCode, EventChannel, EventMap, RpcEnvelope } from "@panelyth/contracts"

/**
 * A failed bridge call: the error code of the envelope, whether a retry can
 * help, and the sidecar's details (e.g. `{ reason: "notReady" }`).
 */
export class PanelythError extends Error {
  override name = "PanelythError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

/** Envelope → result or PanelythError; feature code never sees an envelope. */
export async function unwrap<R>(call: () => Promise<RpcEnvelope<R>>): Promise<R> {
  const envelope = await call()
  if (envelope.ok) return envelope.r
  const { code, message, retryable, details } = envelope.e
  throw new PanelythError(code, message, retryable, details)
}

/** What every preload API has, whatever its capability profile (ADR-0027). */
interface EventSource {
  onEvent<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

export interface BridgeCore<Api> {
  /** The app's preload API; throws SIDECAR_UNAVAILABLE outside the shell. */
  api(): Api
  isAvailable(): boolean
  on<C extends EventChannel>(channel: C, listener: (payload: EventMap[C]) => void): () => void
}

/**
 * The part of a renderer bridge both apps share. Each app builds its own
 * method list on top with its preload's type, so an app can only name the
 * methods of its profile. `unavailable` is the app's translated message.
 */
export function createBridgeCore<Api extends EventSource>(
  unavailable: () => string,
): BridgeCore<Api> {
  // Each app declares window.panelyth with its own preload's type.
  const exposed = (): Api | undefined => (window as unknown as { panelyth?: Api }).panelyth
  const api = (): Api => {
    const value = exposed()
    if (!value) throw new PanelythError("SIDECAR_UNAVAILABLE", unavailable())
    return value
  }
  return {
    api,
    isAvailable: () => exposed() !== undefined,
    on: (channel, listener) => api().onEvent(channel, listener),
  }
}
