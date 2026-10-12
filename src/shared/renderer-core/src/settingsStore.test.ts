import { describe, expect, it, vi } from "vitest"
import { createSettingsStore } from "./settingsStore"

// An app's own settings (Stage P01): the viewer's and the commander's stores
// are built by this factory.

interface Prefs {
  wheel: "zoom" | "step"
  names: boolean
}

const defaults: Prefs = { wheel: "zoom", names: true }

function setup() {
  const save = vi.fn<(settings: Prefs) => void>()
  const store = createSettingsStore<Prefs>({
    defaults,
    read(value) {
      const v = (value ?? {}) as Partial<Record<keyof Prefs, unknown>>
      return { wheel: v.wheel === "step" ? "step" : "zoom", names: v.names !== false }
    },
    save,
  })
  return { store, save }
}

describe("createSettingsStore", () => {
  it("starts with the defaults and a closed dialog", () => {
    const { store, save } = setup()
    expect(store.useStore.getState()).toEqual({ settings: defaults, open: false })
    expect(save).not.toHaveBeenCalled()
  })

  it("changes one value at once and saves the whole object", () => {
    const { store, save } = setup()
    store.update({ wheel: "step" })
    expect(store.useStore.getState().settings).toEqual({ wheel: "step", names: true })
    expect(save).toHaveBeenCalledExactlyOnceWith({ wheel: "step", names: true })
    expect(defaults).toEqual({ wheel: "zoom", names: true })
  })

  it("loads a stored value through the validation, without saving it back", () => {
    const { store, save } = setup()
    store.load({ wheel: "sideways", names: false })
    expect(store.useStore.getState().settings).toEqual({ wheel: "zoom", names: false })
    store.load(undefined)
    expect(store.useStore.getState().settings).toEqual(defaults)
    store.load("corrupt")
    expect(store.useStore.getState().settings).toEqual(defaults)
    expect(save).not.toHaveBeenCalled()
  })

  it("opens and closes the dialog without touching the settings", () => {
    const { store, save } = setup()
    store.update({ names: false })
    store.setOpen(true)
    expect(store.useStore.getState()).toEqual({
      settings: { wheel: "zoom", names: false },
      open: true,
    })
    store.setOpen(false)
    expect(store.useStore.getState().open).toBe(false)
    expect(save).toHaveBeenCalledOnce()
  })

  it("notifies subscribers once per change", () => {
    const { store } = setup()
    const listener = vi.fn()
    store.useStore.subscribe(listener)
    store.update({ names: false })
    expect(listener).toHaveBeenCalledOnce()
  })

  it("resets to the defaults for tests, without saving", () => {
    const { store, save } = setup()
    store.update({ names: false })
    store.setOpen(true)
    save.mockClear()
    store.reset()
    expect(store.useStore.getState()).toEqual({ settings: defaults, open: false })
    expect(save).not.toHaveBeenCalled()
  })
})
