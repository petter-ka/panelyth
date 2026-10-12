import type { EventChannel, RpcEnvelope } from "@panelyth/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBridgeCore, PanelythError, unwrap } from "./bridge"

// The part of the renderer bridge both apps share (Stage P01): the envelope
// becomes a result or a PanelythError, and the preload API is reached in one
// place.

interface FakeApi {
  onEvent(channel: EventChannel, listener: (payload: never) => void): () => void
  system: { ping(): Promise<RpcEnvelope<{ pong: true }>> }
}

const exposed = window as unknown as { panelyth?: FakeApi }

afterEach(() => {
  delete exposed.panelyth
})

describe("unwrap", () => {
  it("returns the result of a successful call", async () => {
    await expect(unwrap(() => Promise.resolve({ ok: true, r: { n: 7 } }))).resolves.toEqual({
      n: 7,
    })
  })

  it("throws a PanelythError with the code, the retry hint and the details", async () => {
    const failed: RpcEnvelope<never> = {
      ok: false,
      e: { code: "BUSY", message: "try later", retryable: true, details: { reason: "notReady" } },
    }
    const error = await unwrap(() => Promise.resolve(failed)).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PanelythError)
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({
      name: "PanelythError",
      code: "BUSY",
      message: "try later",
      retryable: true,
      details: { reason: "notReady" },
    })
  })

  it("leaves the details undefined when the envelope has none", async () => {
    const failed: RpcEnvelope<never> = {
      ok: false,
      e: { code: "NOT_FOUND", message: "gone", retryable: false },
    }
    const error = (await unwrap(() => Promise.resolve(failed)).catch(
      (e: unknown) => e,
    )) as PanelythError
    expect(error.retryable).toBe(false)
    expect(error.details).toBeUndefined()
  })

  it("passes a rejected call through unchanged", async () => {
    const boom = new Error("ipc closed")
    await expect(unwrap(() => Promise.reject(boom))).rejects.toBe(boom)
  })
})

describe("createBridgeCore", () => {
  it("is unavailable outside the shell and says so in the app's words", () => {
    const core = createBridgeCore<FakeApi>(() => "No bridge here")
    expect(core.isAvailable()).toBe(false)
    expect(() => core.api()).toThrowError(
      expect.objectContaining({ code: "SIDECAR_UNAVAILABLE", message: "No bridge here" }),
    )
    expect(() => core.on("sidecar.status", () => undefined)).toThrow(PanelythError)
  })

  it("reads the preload API at call time, so a late preload is found", () => {
    const core = createBridgeCore<FakeApi>(() => "No bridge here")
    const api: FakeApi = {
      onEvent: () => () => undefined,
      system: { ping: () => Promise.resolve({ ok: true, r: { pong: true } }) },
    }
    exposed.panelyth = api
    expect(core.isAvailable()).toBe(true)
    expect(core.api()).toBe(api)
  })

  it("subscribes through the preload and returns its unsubscribe", () => {
    const off = vi.fn()
    const onEvent = vi.fn(() => off)
    exposed.panelyth = {
      onEvent,
      system: { ping: () => Promise.resolve({ ok: true, r: { pong: true } }) },
    }
    const listener = vi.fn()
    const stop = createBridgeCore<FakeApi>(() => "").on("sidecar.status", listener)
    expect(onEvent).toHaveBeenCalledWith("sidecar.status", listener)
    stop()
    expect(off).toHaveBeenCalledOnce()
  })
})
