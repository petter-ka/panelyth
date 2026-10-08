import {
  isEventFrame,
  isHelloFrame,
  isResponseFrame,
  type ErrorCode,
  type EventFrame,
  type HelloFrame,
  type OutboundFrame,
  type RpcErrorShape,
  type SidecarMethod,
  type SidecarMethodMap,
} from "@panelyth/contracts"

export class RpcError extends Error implements RpcErrorShape {
  override name = "RpcError"
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly retryable = false,
    readonly details?: unknown,
  ) {
    super(message)
  }

  toShape(): RpcErrorShape {
    return this.details === undefined
      ? { code: this.code, message: this.message, retryable: this.retryable }
      : { code: this.code, message: this.message, retryable: this.retryable, details: this.details }
  }
}

export interface CallOptions {
  timeoutMs?: number
  signal?: AbortSignal
}

interface Pending {
  resolve(value: unknown): void
  reject(error: RpcError): void
  timer: NodeJS.Timeout
  cleanup(): void
}

export interface RpcClientHooks {
  /** Writes a frame; returns false if the transport cannot accept it. */
  send(frame: OutboundFrame): boolean
  onHello(hello: HelloFrame): void
  onEvent(event: EventFrame): void
  onProtocolError(reason: string): void
}

const DEFAULT_TIMEOUT_MS = 10_000

/**
 * Request/response correlation for the sidecar protocol. Transport-agnostic:
 * SidecarProcess feeds decoded messages in and provides `send`.
 */
export class RpcClient {
  private nextId = 1
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly hooks: RpcClientHooks) {}

  get inFlight(): number {
    return this.pending.size
  }

  call<M extends SidecarMethod>(
    method: M,
    params: SidecarMethodMap[M]["params"],
    options: CallOptions = {},
  ): Promise<SidecarMethodMap[M]["result"]> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = options
    if (signal?.aborted) return Promise.reject(new RpcError("CANCELLED", "request aborted"))

    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const onAbort = (): void => this.abandon(id, new RpcError("CANCELLED", "request aborted"))
      const timer = setTimeout(
        () =>
          this.abandon(
            id,
            new RpcError("TIMEOUT", `${method} timed out after ${timeoutMs} ms`, true),
          ),
        timeoutMs,
      )
      signal?.addEventListener("abort", onAbort, { once: true })
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
      })
      // The deadline travels with the request so Go stops working on it too.
      if (!this.hooks.send({ t: "req", id, m: method, p: params, deadlineMs: timeoutMs })) {
        this.settle(id)?.reject(new RpcError("BUSY", "sidecar transport is saturated", true))
      }
    })
  }

  /** Feed one decoded message from the sidecar. */
  handleMessage(message: unknown): void {
    if (isResponseFrame(message)) {
      const pending = this.settle(message.id)
      if (!pending) return // already timed out or cancelled
      if (message.ok) pending.resolve(message.r)
      else {
        const { code, message: text, retryable, details } = message.e
        pending.reject(new RpcError(code, text, retryable, details))
      }
    } else if (isEventFrame(message)) {
      this.hooks.onEvent(message)
    } else if (isHelloFrame(message)) {
      this.hooks.onHello(message)
    } else {
      this.hooks.onProtocolError("unrecognised frame from sidecar")
    }
  }

  /** Reject everything in flight (sidecar exited or restarted). */
  failAll(error: RpcError): void {
    for (const id of [...this.pending.keys()]) this.settle(id)?.reject(error)
  }

  private abandon(id: number, error: RpcError): void {
    const pending = this.settle(id)
    if (!pending) return
    this.hooks.send({ t: "cancel", id })
    pending.reject(error)
  }

  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id)
    if (!pending) return undefined
    this.pending.delete(id)
    clearTimeout(pending.timer)
    pending.cleanup()
    return pending
  }
}
