import { describe, expect, it } from "vitest"
import { installFakeBridge } from "../test/fakeBridge"
import { bridge, PanelythError } from "."

describe("bridge", () => {
  it("unwraps success envelopes", async () => {
    installFakeBridge()
    await expect(bridge.ping()).resolves.toEqual({ pong: true, serverTimeNs: 1 })
  })

  it("throws PanelythError for error envelopes", async () => {
    const { api } = installFakeBridge()
    api.system.ping.mockResolvedValueOnce({
      ok: false,
      e: { code: "BUSY", message: "busy", retryable: true },
    } as never)
    const error = await bridge.ping().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PanelythError)
    expect(error).toMatchObject({ code: "BUSY", retryable: true })
  })

  it("throws when the preload bridge is missing", async () => {
    await expect(bridge.info()).rejects.toMatchObject({ code: "SIDECAR_UNAVAILABLE" })
  })
})
