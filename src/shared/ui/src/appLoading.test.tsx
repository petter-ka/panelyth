import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppLoadingOverlay,
  resetAppLoading,
  showAppLoadingNow,
  useAppLoading,
  whileAppLoads,
} from "./AppLoading"

// The loading screen over an app's content while a switch carries a folder
// over or the app starts (docs/shared/APP-SWITCHING.md, "Loading screen").

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const visible = () => useAppLoading.getState().visible

describe("whileAppLoads", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetAppLoading()
  })
  afterEach(() => {
    resetAppLoading()
    vi.useRealTimers()
  })

  it("never shows for work that answers at once", async () => {
    const work = deferred()
    const done = whileAppLoads(work.promise, { label: "Opening…" })
    await vi.advanceTimersByTimeAsync(100)
    work.resolve()
    await done
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(false)
  })

  it("shows after a moment, stays a little and goes when the work is done", async () => {
    const work = deferred()
    const done = whileAppLoads(work.promise, { label: "Opening…" })
    await vi.advanceTimersByTimeAsync(130)
    expect(visible()).toBe(true)
    expect(useAppLoading.getState().label).toBe("Opening…")
    work.resolve()
    await done
    // Shown 130 ms ago: it stays until 200 ms have passed, so it does not blink.
    expect(visible()).toBe(true)
    await vi.advanceTimersByTimeAsync(200)
    expect(visible()).toBe(false)
  })

  it("shows at once when asked, waits for every piece of work and passes failures on", async () => {
    const a = deferred()
    const b = deferred()
    const first = whileAppLoads(a.promise, { label: "Loading…", immediate: true })
    expect(visible()).toBe(true)
    const second = whileAppLoads(b.promise, { label: "Opening…" })
    a.resolve()
    await first
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(true)
    b.reject(new Error("gone"))
    await expect(second).rejects.toThrow("gone")
    await vi.advanceTimersByTimeAsync(500)
    expect(visible()).toBe(false)
  })

  it("waits until what the work started has reached the screen, a second at most", async () => {
    let shown = false
    const done = whileAppLoads(Promise.resolve(), {
      label: "Opening…",
      immediate: true,
      settled: () => shown,
    })
    await vi.advanceTimersByTimeAsync(300)
    expect(useAppLoading.getState().pending).toBe(1)
    shown = true
    await vi.advanceTimersByTimeAsync(50)
    await done
    expect(useAppLoading.getState().pending).toBe(0)

    // A first page that never comes does not keep the screen.
    const stuck = whileAppLoads(Promise.resolve(), { label: "Opening…", settled: () => false })
    await vi.advanceTimersByTimeAsync(1100)
    await stuck
    expect(useAppLoading.getState().pending).toBe(0)
  })

  it("shows at once when the work is about to clear the screen, and only behind work", async () => {
    showAppLoadingNow()
    expect(visible()).toBe(false)
    const work = deferred()
    const done = whileAppLoads(work.promise, { label: "Opening…" })
    showAppLoadingNow()
    expect(visible()).toBe(true)
    work.resolve()
    await done
    await vi.advanceTimersByTimeAsync(200)
    expect(visible()).toBe(false)
  })

  it("lets go after ten seconds, whatever the work does", async () => {
    void whileAppLoads(new Promise(() => undefined), { label: "Opening…", immediate: true })
    expect(visible()).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(visible()).toBe(false)
  })
})

describe("AppLoadingOverlay", () => {
  beforeEach(() => resetAppLoading())

  it("covers the content with the app's glyph and the label while loading", () => {
    const { rerender } = render(<AppLoadingOverlay app="commander" />)
    expect(screen.queryByTestId("app-loading")).toBeNull()
    act(() => useAppLoading.setState({ pending: 1, visible: true, label: "Opening…" }))
    rerender(<AppLoadingOverlay app="commander" />)
    expect(screen.getByTestId("app-loading")).toHaveAttribute("aria-busy", "true")
    expect(screen.getByRole("status")).toHaveTextContent("Opening…")
  })
})
