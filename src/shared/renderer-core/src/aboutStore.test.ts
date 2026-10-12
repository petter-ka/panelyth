import type { AboutInfo, MenuCommand, UpdateState } from "@panelyth/contracts"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  aboutPortOf,
  checkForUpdates,
  downloadUpdate,
  installUpdate,
  loadAbout,
  openAppTarget,
  setAutoUpdateCheck,
  startAboutSync,
  updateWaiting,
  useAboutStore,
  type AboutApi,
} from "./aboutStore"

const state = (patch: Partial<UpdateState> = {}): UpdateState => ({
  mode: "auto",
  phase: "idle",
  currentVersion: "1.1.0",
  version: null,
  releaseDate: null,
  notes: [],
  percent: 0,
  transferredBytes: 0,
  totalBytes: 0,
  checkedAt: null,
  error: null,
  auto: true,
  ...patch,
})

const info: AboutInfo = {
  name: "Panelyth",
  version: "1.1.0",
  sidecarVersion: "1.1.0+g1647109",
  electron: "44.5.1",
  chrome: "150.0.0.0",
  node: "24.1.0",
  platform: "win32 x64",
  packaged: true,
  copyright: "Copyright © Panelyth contributors",
}

const ok = <R>(r: R) => Promise.resolve({ ok: true as const, r })
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function fakeApi(initial = state()) {
  const listeners = new Map<string, (payload: never) => void>()
  let pending: (() => void) | null = null
  const api = {
    app: {
      about: vi.fn(() => ok(info)),
      openTarget: vi.fn(() => ok({ ok: true })),
    },
    update: {
      // The answer waits until the test lets it go, to order it against an event.
      get: vi.fn(
        () =>
          new Promise<{ ok: true; r: UpdateState }>((resolve) => {
            pending = () => resolve({ ok: true, r: initial })
          }),
      ),
      check: vi.fn(() => ok(state({ phase: "checking" }))),
      download: vi.fn(() => ok(state({ phase: "downloading", version: "1.2.0" }))),
      install: vi.fn(() => ok({ ok: true })),
    },
    onEvent: vi.fn((channel: string, listener: (payload: never) => void) => {
      listeners.set(channel, listener)
      return () => listeners.delete(channel)
    }),
  }
  return {
    api: api as unknown as AboutApi & typeof api,
    emit: (channel: string, payload: unknown) => listeners.get(channel)?.(payload as never),
    answer: () => pending?.(),
    listening: () => [...listeners.keys()].sort(),
  }
}

describe("the About store (Stage P06)", () => {
  beforeEach(() => useAboutStore.setState({ info: null, update: null, problem: null }))

  it("listens first, then asks for the state", async () => {
    const fake = fakeApi(state({ phase: "upToDate" }))
    const onCommand = vi.fn<(command: MenuCommand) => void>()
    const stop = startAboutSync(
      aboutPortOf(() => fake.api, vi.fn()),
      onCommand,
    )
    expect(fake.listening()).toEqual(["menu.command", "update.state"])
    expect(fake.api.update.get).toHaveBeenCalledTimes(1)
    fake.answer()
    await settle()
    expect(useAboutStore.getState().update?.phase).toBe("upToDate")

    fake.emit("menu.command", { command: "about" })
    expect(onCommand).toHaveBeenCalledWith("about")
    stop()
    expect(fake.listening()).toEqual([])
  })

  it("keeps an event that arrived before the answer", async () => {
    const fake = fakeApi(state({ phase: "idle" }))
    startAboutSync(
      aboutPortOf(() => fake.api, vi.fn()),
      vi.fn(),
    )
    fake.emit("update.state", state({ phase: "available", version: "1.2.0" }))
    fake.answer()
    await settle()
    expect(useAboutStore.getState().update).toMatchObject({ phase: "available", version: "1.2.0" })
  })

  it("names the next step; the state comes from main's events, never from a late answer", async () => {
    const fake = fakeApi()
    startAboutSync(
      aboutPortOf(() => fake.api, vi.fn()),
      vi.fn(),
    )
    checkForUpdates()
    // The check finished before its own answer arrived: the event is the newer one.
    fake.emit("update.state", state({ phase: "available", version: "1.2.0" }))
    await settle()
    expect(fake.api.update.check).toHaveBeenCalledTimes(1)
    expect(useAboutStore.getState().update?.phase).toBe("available")
    downloadUpdate()
    await settle()
    expect(fake.api.update.download).toHaveBeenCalledTimes(1)
    expect(useAboutStore.getState().update?.phase).toBe("available")
    installUpdate()
    openAppTarget("logs")
    await settle()
    expect(fake.api.update.install).toHaveBeenCalledTimes(1)
    expect(fake.api.app.openTarget).toHaveBeenCalledWith("logs")
  })

  it("reads the build's details once", async () => {
    const fake = fakeApi()
    startAboutSync(
      aboutPortOf(() => fake.api, vi.fn()),
      vi.fn(),
    )
    loadAbout()
    await settle()
    loadAbout()
    expect(fake.api.app.about).toHaveBeenCalledTimes(1)
    expect(useAboutStore.getState().info).toEqual(info)
  })

  it("saves the automatic check as the shared setting", async () => {
    const fake = fakeApi()
    const save = vi.fn()
    startAboutSync(
      aboutPortOf(() => fake.api, save),
      vi.fn(),
    )
    fake.emit("update.state", state())
    setAutoUpdateCheck(false)
    expect(save).toHaveBeenCalledWith("shared.updates", { v: 1, auto: false })
    expect(useAboutStore.getState().update?.auto).toBe(false)
  })

  it("shows why an action failed", async () => {
    const fake = fakeApi()
    fake.api.app.openTarget.mockImplementation(() =>
      Promise.resolve({
        ok: false as const,
        e: { code: "INTERNAL", message: "no notices in this build", retryable: false },
      } as never),
    )
    startAboutSync(
      aboutPortOf(() => fake.api, vi.fn()),
      vi.fn(),
    )
    openAppTarget("notices")
    await settle()
    expect(useAboutStore.getState().problem).toBe("no notices in this build")
    // The next action clears it.
    checkForUpdates()
    expect(useAboutStore.getState().problem).toBeNull()
  })

  it("knows when a newer version waits for the user", () => {
    const waiting = (update: UpdateState | null): boolean =>
      updateWaiting({ info: null, update, problem: null })
    expect(waiting(null)).toBe(false)
    expect(waiting(state({ phase: "upToDate" }))).toBe(false)
    expect(waiting(state({ phase: "available" }))).toBe(true)
    expect(waiting(state({ phase: "ready" }))).toBe(true)
    expect(waiting(state({ phase: "downloading" }))).toBe(false)
    expect(waiting(state({ mode: "off", phase: "available" }))).toBe(false)
  })
})
