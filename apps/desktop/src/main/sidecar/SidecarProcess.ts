import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { once } from "node:events"
import {
  PROTOCOL_VERSION,
  type EventFrame,
  type HelloFrame,
  type OutboundFrame,
  type SidecarMethod,
  type SidecarMethodMap,
  type SidecarStatus,
} from "@fastview/contracts"
import type { Logger } from "../log"
import { encodeFrame, FrameDecoder } from "./frames"
import { RpcClient, RpcError, type CallOptions } from "./RpcClient"

export interface SidecarOptions {
  binaryPath: string
  logger: Logger
  env?: NodeJS.ProcessEnv
  logLevel?: string
  /** Time allowed between spawn and a valid hello frame. */
  helloTimeoutMs?: number
  /** Restart backoff schedule; its length is the restart budget per window. */
  restartDelaysMs?: readonly number[]
  restartWindowMs?: number
  /** Cap on bytes queued in the child's stdin before calls fail with BUSY. */
  maxStdinBufferBytes?: number
}

type StatusListener = (status: SidecarStatus) => void
type EventListener = (event: EventFrame) => void

/**
 * Owns the Go child process: spawn, handshake, supervision with bounded
 * restarts, and ordered shutdown. Everything here is asynchronous; nothing
 * blocks the main-process event loop.
 */
export class SidecarProcess {
  private child: ChildProcessWithoutNullStreams | null = null
  private client: RpcClient | null = null
  private hello: HelloFrame | null = null
  private readyWaiters: { resolve(): void; reject(e: RpcError): void }[] = []
  private exitTimes: number[] = []
  private restartTimer: NodeJS.Timeout | null = null
  private stopping = false
  private status: SidecarStatus = {
    state: "stopped",
    pid: null,
    protocol: null,
    version: null,
    restarts: 0,
    lastError: null,
    since: Date.now(),
  }
  private readonly statusListeners = new Set<StatusListener>()
  private readonly eventListeners = new Set<EventListener>()

  private readonly helloTimeoutMs: number
  private readonly restartDelaysMs: readonly number[]
  private readonly restartWindowMs: number
  private readonly maxStdinBufferBytes: number

  constructor(private readonly options: SidecarOptions) {
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000
    this.restartDelaysMs = options.restartDelaysMs ?? [250, 1_000, 3_000]
    this.restartWindowMs = options.restartWindowMs ?? 60_000
    this.maxStdinBufferBytes = options.maxStdinBufferBytes ?? 8 * 1024 * 1024
  }

  getStatus(): SidecarStatus {
    return { ...this.status }
  }

  /** Storage roots announced by the sidecar; null until the first hello. */
  getHello(): HelloFrame | null {
    return this.hello
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  start(): void {
    if (this.child || this.stopping) return
    this.spawnChild(this.status.restarts > 0 ? "restarting" : "starting")
  }

  /** Resolves once the sidecar is ready, waiting through starts/restarts. */
  whenReady(timeoutMs = this.helloTimeoutMs): Promise<void> {
    if (this.status.state === "ready") return Promise.resolve()
    if (this.status.state === "failed" || this.status.state === "stopped" || this.stopping) {
      return Promise.reject(
        new RpcError("SIDECAR_UNAVAILABLE", `sidecar is ${this.status.state}`, false),
      )
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e: RpcError) => {
          clearTimeout(timer)
          reject(e)
        },
      }
      const timer = setTimeout(() => {
        this.readyWaiters = this.readyWaiters.filter((w) => w !== waiter)
        reject(new RpcError("SIDECAR_UNAVAILABLE", "sidecar did not become ready in time", true))
      }, timeoutMs)
      this.readyWaiters.push(waiter)
    })
  }

  async call<M extends SidecarMethod>(
    method: M,
    params: SidecarMethodMap[M]["params"],
    options?: CallOptions,
  ): Promise<SidecarMethodMap[M]["result"]> {
    await this.whenReady()
    const client = this.client
    if (!client) throw new RpcError("SIDECAR_UNAVAILABLE", "sidecar is not running", true)
    return client.call(method, params, options)
  }

  /**
   * Ordered shutdown: ask politely, then close stdin (the sidecar exits on
   * EOF), then kill. Never rejects.
   */
  async stop({ requestTimeoutMs = 2_000, exitTimeoutMs = 1_000 } = {}): Promise<void> {
    this.stopping = true
    if (this.restartTimer) clearTimeout(this.restartTimer)
    const child = this.child
    if (!child) {
      this.setStatus({ state: "stopped", pid: null })
      return
    }
    this.setStatus({ state: "stopping" })
    const exited = once(child, "exit").then(() => undefined)

    if (this.client && this.hello) {
      await Promise.race([
        this.client
          .call("system.shutdown", {}, { timeoutMs: requestTimeoutMs })
          .catch(() => undefined),
        exited,
      ])
    }
    child.stdin.end()
    const timedOut = await Promise.race([
      exited.then(() => false),
      delay(exitTimeoutMs).then(() => true),
    ])
    if (timedOut) {
      this.options.logger.warn("sidecar did not exit in time; killing", { pid: child.pid })
      child.kill()
      await Promise.race([exited, delay(exitTimeoutMs)])
    }
    this.setStatus({ state: "stopped", pid: null })
  }

  private spawnChild(state: "starting" | "restarting"): void {
    const { binaryPath, logger } = this.options
    const args = this.options.logLevel ? ["-log-level", this.options.logLevel] : []
    this.hello = null
    this.setStatus({ state, pid: null, protocol: null, version: null })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(binaryPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        env: { ...process.env, ...this.options.env },
      })
    } catch (error) {
      this.handleExit(null, `spawn failed: ${String(error)}`)
      return
    }
    this.child = child

    const decoder = new FrameDecoder()
    const client = new RpcClient({
      send: (frame) => this.write(child, frame),
      onHello: (hello) => this.handleHello(child, hello),
      onEvent: (event) => this.eventListeners.forEach((l) => l(event)),
      onProtocolError: (reason) => this.protocolFailure(child, reason),
    })
    this.client = client

    const helloTimer = setTimeout(() => {
      if (!this.hello && this.child === child) this.protocolFailure(child, "no hello from sidecar")
    }, this.helloTimeoutMs)

    child.stdout.on("data", (chunk: Buffer) => {
      let payloads: Buffer[]
      try {
        payloads = decoder.push(chunk)
      } catch (error) {
        this.protocolFailure(child, String(error))
        return
      }
      for (const payload of payloads) {
        let message: unknown
        try {
          message = JSON.parse(payload.toString("utf8"))
        } catch {
          this.protocolFailure(child, "sidecar sent invalid JSON")
          return
        }
        client.handleMessage(message)
      }
    })

    let stderrTail = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (text: string) => {
      const lines = (stderrTail + text).split("\n")
      stderrTail = lines.pop() ?? ""
      for (const line of lines) if (line.trim()) logger.sidecar(line)
    })

    child.stdin.on("error", (error) => logger.warn("sidecar stdin error", { error: String(error) }))
    child.on("error", (error) => {
      logger.error("sidecar process error", { error: String(error) })
      // A failed spawn (e.g. ENOENT) emits "error" without "exit".
      if (child.pid === undefined) {
        clearTimeout(helloTimer)
        this.handleExit(child, `spawn failed: ${String(error)}`)
      }
    })
    child.once("exit", (code, signal) => {
      clearTimeout(helloTimer)
      if (stderrTail.trim()) logger.sidecar(stderrTail)
      this.handleExit(child, `exited with code ${code ?? "null"} signal ${signal ?? "none"}`)
    })
  }

  private write(child: ChildProcessWithoutNullStreams, frame: OutboundFrame): boolean {
    if (this.child !== child || !child.stdin.writable) return false
    if (child.stdin.writableLength > this.maxStdinBufferBytes) return false
    child.stdin.write(encodeFrame(frame))
    return true
  }

  private handleHello(child: ChildProcessWithoutNullStreams, hello: HelloFrame): void {
    if (this.child !== child) return
    if (hello.protocol !== PROTOCOL_VERSION) {
      this.protocolFailure(
        child,
        `protocol mismatch: sidecar ${hello.protocol}, expected ${PROTOCOL_VERSION}`,
        true,
      )
      return
    }
    this.hello = hello
    this.options.logger.info("sidecar ready", { pid: hello.pid, version: hello.version })
    this.setStatus({
      state: "ready",
      pid: hello.pid,
      protocol: hello.protocol,
      version: hello.version,
      lastError: null,
    })
    const waiters = this.readyWaiters
    this.readyWaiters = []
    waiters.forEach((w) => w.resolve())
  }

  private protocolFailure(
    child: ChildProcessWithoutNullStreams,
    reason: string,
    fatal = false,
  ): void {
    this.options.logger.error("sidecar protocol failure", { reason })
    this.status.lastError = reason
    if (fatal) this.stopping = true
    child.kill()
    if (fatal) this.fail(reason)
  }

  private handleExit(child: ChildProcessWithoutNullStreams | null, reason: string): void {
    if (child && this.child !== child) return
    this.child = null
    this.client?.failAll(new RpcError("SIDECAR_UNAVAILABLE", `sidecar ${reason}`, true))
    this.client = null
    this.hello = null

    if (this.stopping) {
      if (this.status.state !== "failed") this.setStatus({ state: "stopped", pid: null })
      return
    }

    this.options.logger.warn("sidecar exited unexpectedly", { reason })
    const now = Date.now()
    this.exitTimes = [...this.exitTimes.filter((t) => now - t < this.restartWindowMs), now]
    const attempt = this.exitTimes.length - 1
    const delayMs = this.restartDelaysMs[attempt]
    if (delayMs === undefined) {
      this.fail(
        `sidecar crashed ${this.exitTimes.length} times within ${this.restartWindowMs} ms: ${reason}`,
      )
      return
    }
    this.setStatus({
      state: "restarting",
      pid: null,
      restarts: this.status.restarts + 1,
      lastError: this.status.lastError ?? reason,
    })
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      if (!this.stopping) this.spawnChild("restarting")
    }, delayMs)
  }

  private fail(reason: string): void {
    this.setStatus({ state: "failed", pid: null, lastError: reason })
    const waiters = this.readyWaiters
    this.readyWaiters = []
    waiters.forEach((w) => w.reject(new RpcError("SIDECAR_UNAVAILABLE", reason)))
  }

  private setStatus(patch: Partial<SidecarStatus>): void {
    const next = { ...this.status, ...patch }
    if (patch.state && patch.state !== this.status.state) next.since = Date.now()
    this.status = next
    const snapshot = this.getStatus()
    this.statusListeners.forEach((l) => l(snapshot))
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms).unref())
}
