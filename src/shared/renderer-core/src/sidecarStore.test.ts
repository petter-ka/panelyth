import type { SidecarStatus } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { createSidecarStore, followSidecar, type SidecarPort } from "./sidecarStore"

// The sidecar status both apps follow (Stage P01; one sidecar serves both,
// ADR-0031).

const status = (state: SidecarStatus["state"], pid: number | null, since: number): SidecarStatus =>
  ({ state, pid, since, restarts: 0, lastError: null }) as SidecarStatus

function fakePort(answer: Promise<SidecarStatus>) {
  let listener: ((status: SidecarStatus) => void) | null = null
  const off = vi.fn(() => {
    listener = null
  })
  const port: SidecarPort = {
    getStatus: () => answer,
    onStatus(next) {
      listener = next
      return off
    },
  }
  return { port, off, push: (s: SidecarStatus) => listener?.(s) }
}

/** A promise settled by the test, to order an answer against the pushes. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe("createSidecarStore", () => {
  it("starts without a status and keeps the app's own fields", () => {
    const store = createSidecarStore({ pingMs: null as number | null })
    expect(store.getState()).toEqual({ status: null, error: null, pingMs: null })
    expect(createSidecarStore().getState()).toEqual({ status: null, error: null })
  })
})

describe("followSidecar", () => {
  it("applies the status fetched at start, for a renderer that loaded late", async () => {
    const store = createSidecarStore()
    const { port } = fakePort(Promise.resolve(status("ready", 10, 5)))
    const onReady = vi.fn()
    followSidecar(store, port, onReady)
    await vi.waitFor(() => expect(store.getState().status?.state).toBe("ready"))
    expect(onReady).toHaveBeenCalledOnce()
  })

  it("does not let an older answer replace a newer push", async () => {
    const store = createSidecarStore()
    const answer = deferred<SidecarStatus>()
    const { port, push } = fakePort(answer.promise)
    followSidecar(store, port)
    push(status("ready", 10, 20))
    answer.resolve(status("starting", null, 5))
    await answer.promise
    await Promise.resolve()
    expect(store.getState().status).toMatchObject({ state: "ready", since: 20 })
  })

  it("runs onReady on each transition into ready, not on a repeated status", () => {
    const store = createSidecarStore()
    const { port, push } = fakePort(new Promise(() => undefined))
    const onReady = vi.fn()
    followSidecar(store, port, onReady)

    push(status("starting", null, 1))
    expect(onReady).not.toHaveBeenCalled()
    push(status("ready", 10, 2))
    push(status("ready", 10, 3))
    expect(onReady).toHaveBeenCalledOnce()

    // A restart: the same state with a new process.
    push(status("ready", 11, 4))
    expect(onReady).toHaveBeenCalledTimes(2)

    // Down and up again with the same pid counts too.
    push(status("failed", null, 5))
    push(status("ready", 11, 6))
    expect(onReady).toHaveBeenCalledTimes(3)
    expect(onReady).toHaveBeenLastCalledWith(expect.objectContaining({ since: 6 }))
  })

  it("records a failed fetch and keeps following the pushes", async () => {
    const store = createSidecarStore()
    const answer = deferred<SidecarStatus>()
    const { port, push } = fakePort(answer.promise)
    followSidecar(store, port)
    answer.reject(new Error("no route"))
    await vi.waitFor(() => expect(store.getState().error).toBe("Error: no route"))
    push(status("ready", 10, 2))
    expect(store.getState().status?.state).toBe("ready")
  })

  it("leaves the app's own fields alone", () => {
    const store = createSidecarStore({ pingMs: 4 as number | null })
    const { port, push } = fakePort(new Promise(() => undefined))
    followSidecar(store, port)
    push(status("ready", 10, 2))
    expect(store.getState().pingMs).toBe(4)
  })

  it("returns the port's unsubscribe", () => {
    const { port, off } = fakePort(new Promise(() => undefined))
    followSidecar(createSidecarStore(), port)()
    expect(off).toHaveBeenCalledOnce()
  })
})
