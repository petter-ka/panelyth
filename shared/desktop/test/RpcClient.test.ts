import type { OutboundFrame } from "@panelyth/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RpcClient, RpcError } from "../src/main/sidecar/RpcClient"

function setup(accept = true) {
  const sent: OutboundFrame[] = []
  const hooks = {
    send: vi.fn((f: OutboundFrame) => {
      sent.push(f)
      return accept
    }),
    onHello: vi.fn(),
    onEvent: vi.fn(),
    onProtocolError: vi.fn(),
  }
  return { client: new RpcClient(hooks), sent, hooks }
}

describe("RpcClient", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("correlates responses by id and passes the deadline to Go", async () => {
    const { client, sent } = setup()
    const a = client.call("system.ping", {}, { timeoutMs: 500 })
    const b = client.call("system.info", {})
    expect(sent.map((f) => f.t === "req" && [f.id, f.m, f.deadlineMs])).toEqual([
      [1, "system.ping", 500],
      [2, "system.info", 10_000],
    ])
    client.handleMessage({ t: "res", id: 2, ok: true, r: { version: "x" } })
    client.handleMessage({ t: "res", id: 1, ok: true, r: { pong: true, serverTimeNs: 1 } })
    await expect(a).resolves.toEqual({ pong: true, serverTimeNs: 1 })
    await expect(b).resolves.toEqual({ version: "x" })
    expect(client.inFlight).toBe(0)
  })

  it("maps error envelopes to RpcError", async () => {
    const { client } = setup()
    const p = client.call("system.info", {})
    client.handleMessage({
      t: "res",
      id: 1,
      ok: false,
      e: { code: "BUSY", message: "busy", retryable: true },
    })
    await expect(p).rejects.toMatchObject({ name: "RpcError", code: "BUSY", retryable: true })
  })

  it("times out, sends a cancel frame and ignores the late response", async () => {
    const { client, sent } = setup()
    const p = client.call("system.ping", {}, { timeoutMs: 100 })
    vi.advanceTimersByTime(100)
    await expect(p).rejects.toMatchObject({ code: "TIMEOUT" })
    expect(sent.at(-1)).toEqual({ t: "cancel", id: 1 })
    client.handleMessage({ t: "res", id: 1, ok: true, r: {} })
    expect(client.inFlight).toBe(0)
  })

  it("aborts via AbortSignal", async () => {
    const { client, sent } = setup()
    const controller = new AbortController()
    const p = client.call("system.ping", {}, { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" })
    expect(sent.at(-1)).toEqual({ t: "cancel", id: 1 })
  })

  it("rejects immediately when the transport is saturated", async () => {
    const { client } = setup(false)
    await expect(client.call("system.ping", {})).rejects.toMatchObject({ code: "BUSY" })
    expect(client.inFlight).toBe(0)
  })

  it("failAll rejects every pending call", async () => {
    const { client } = setup()
    const calls = [client.call("system.ping", {}), client.call("system.info", {})]
    client.failAll(new RpcError("SIDECAR_UNAVAILABLE", "gone", true))
    for (const c of calls) await expect(c).rejects.toMatchObject({ code: "SIDECAR_UNAVAILABLE" })
  })

  it("routes hello, events and garbage", () => {
    const { client, hooks } = setup()
    client.handleMessage({
      t: "hello",
      protocol: 1,
      pid: 1,
      version: "v",
      goVersion: "g",
      cacheRoot: "c",
      configRoot: "d",
      thumbnailRoot: "e",
    })
    client.handleMessage({ t: "evt", ch: "x", seq: 1, p: {} })
    client.handleMessage({ t: "nope" })
    expect(hooks.onHello).toHaveBeenCalledOnce()
    expect(hooks.onEvent).toHaveBeenCalledOnce()
    expect(hooks.onProtocolError).toHaveBeenCalledOnce()
  })
})
