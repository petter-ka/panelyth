import type { CommanderApi, SidecarStatus } from "@panelyth/contracts"
import { PanelythError as SharedPanelythError } from "@panelyth/renderer-core"
import { afterEach, describe, expect, it, vi } from "vitest"
import { bridge, isBridgeAvailable, PanelythError, resetBridgeCache } from "./bridge"
import {
  DEFAULT_SETTINGS,
  loadSettings,
  readSettings,
  resetSettings,
  SETTINGS_KEY,
  setSettingsOpen,
  updateSettings,
  useSettingsStore,
} from "./features/settings"
import { startSidecarMonitoring, useSidecarStore } from "./features/sidecar"

// Stage P01: the commander's bridge, sidecar store and settings store are
// built on src/shared/renderer-core, like the viewer's.

const ok = <R>(r: R) => ({ ok: true as const, r })
const status = (state: SidecarStatus["state"], since: number): SidecarStatus =>
  ({
    state,
    pid: state === "ready" ? 7 : null,
    since,
    restarts: 0,
    lastError: null,
  }) as SidecarStatus

function installApi(stored: Record<string, unknown> = {}) {
  let onStatus: ((status: SidecarStatus) => void) | null = null
  const api = {
    sidecar: { getStatus: vi.fn(async () => ok(status("ready", 1))) },
    library: {
      get: vi.fn(async () => ok({ settings: stored, bookmarks: [], recent: [] })),
      setSetting: vi.fn(async () => ok({ ok: true })),
    },
    onEvent: vi.fn((channel: string, listener: (payload: never) => void) => {
      if (channel === "sidecar.status") onStatus = listener as (status: SidecarStatus) => void
      return () => {
        onStatus = null
      }
    }),
  }
  window.panelyth = api as unknown as CommanderApi
  return { api, push: (s: SidecarStatus) => onStatus?.(s) }
}

afterEach(() => {
  delete window.panelyth
  resetBridgeCache()
  resetSettings()
  useSidecarStore.setState({ status: null, error: null })
})

describe("commander bridge", () => {
  it("throws the shared PanelythError with the details and the retry hint", async () => {
    const { api } = installApi()
    api.sidecar.getStatus.mockResolvedValueOnce({
      ok: false,
      e: { code: "BUSY", message: "busy", retryable: true, details: { reason: "notReady" } },
    } as never)
    const error = await bridge.sidecarStatus().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PanelythError)
    expect(PanelythError).toBe(SharedPanelythError)
    expect(error).toMatchObject({ code: "BUSY", retryable: true, details: { reason: "notReady" } })
  })

  it("says so when the preload bridge is missing", async () => {
    expect(isBridgeAvailable()).toBe(false)
    await expect(bridge.exit()).rejects.toMatchObject({
      code: "SIDECAR_UNAVAILABLE",
      message: "Panelyth bridge unavailable",
    })
  })
})

describe("commander sidecar store", () => {
  it("does nothing without the bridge", () => {
    startSidecarMonitoring()()
    expect(useSidecarStore.getState()).toEqual({ status: null, error: null })
  })

  it("follows pushes and never lets the first answer replace a newer push", async () => {
    const { api, push } = installApi()
    let answer!: (value: unknown) => void
    api.sidecar.getStatus.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)) as never)
    const stop = startSidecarMonitoring()

    push(status("ready", 20))
    answer(ok(status("starting", 5)))
    await vi.waitFor(() => expect(api.sidecar.getStatus).toHaveBeenCalledOnce())
    await Promise.resolve()
    await Promise.resolve()
    expect(useSidecarStore.getState().status).toMatchObject({ state: "ready", since: 20 })

    stop()
    push(status("failed", 30))
    expect(useSidecarStore.getState().status?.state).toBe("ready")
  })
})

describe("commander settings store", () => {
  it("loads commander.settings and saves a change whole, with its version", async () => {
    const { api } = installApi({ [SETTINGS_KEY]: { v: 3, showHidden: false, tabBar: "multiple" } })
    await loadSettings()
    expect(useSettingsStore.getState().settings).toMatchObject({
      showHidden: false,
      tabBar: "multiple",
      confirmTrash: true,
    })
    expect(api.library.setSetting).not.toHaveBeenCalled()

    updateSettings({ confirmTrash: false })
    expect(useSettingsStore.getState().settings.confirmTrash).toBe(false)
    expect(api.library.setSetting).toHaveBeenCalledExactlyOnceWith(SETTINGS_KEY, {
      ...DEFAULT_SETTINGS,
      v: 3,
      showHidden: false,
      tabBar: "multiple",
      confirmTrash: false,
    })
  })

  it("shows hidden entries unless v3 settings turned them off", () => {
    expect(readSettings({ v: 2, showHidden: false }).showHidden).toBe(true)
    expect(readSettings(undefined).showHidden).toBe(true)
    expect(readSettings({ v: 3, showHidden: false }).showHidden).toBe(false)
    expect(readSettings({ v: 3 }).showHidden).toBe(true)
  })

  it("changes in memory without a bridge, and opens its dialog", () => {
    updateSettings({ showToolbar: false })
    setSettingsOpen(true)
    expect(useSettingsStore.getState()).toMatchObject({
      settings: { showToolbar: false },
      open: true,
    })
  })
})
