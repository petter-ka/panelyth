import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppSwitchButton,
  applySharedAppearance,
  connectSharedAppearance,
  startSharedAppearanceSync,
  initInterfaceSize,
  initTheme,
  useInterfaceSizeStore,
  useThemeStore,
} from "./index"

describe("AppSwitchButton", () => {
  it("names the other app, shows its shortcut and switches", () => {
    const onSwitch = vi.fn()
    render(<AppSwitchButton target="commander" shortcut="Ctrl+Shift+M" onSwitch={onSwitch} />)
    const button = screen.getByRole("button", { name: "Switch to Commander" })
    expect(button).toHaveAttribute("data-tooltip-content", "Switch to Commander (Ctrl+Shift+M)")
    expect(button).toHaveAttribute("aria-keyshortcuts", "Control+Shift+M")
    fireEvent.click(button)
    expect(onSwitch).toHaveBeenCalledOnce()
  })
})

describe("shared appearance", () => {
  beforeEach(() => {
    localStorage.clear()
    connectSharedAppearance(null)
    initTheme()
    initInterfaceSize()
  })

  it("saves both values when either changes", () => {
    const save = vi.fn()
    connectSharedAppearance(save)
    useThemeStore.getState().setPreference("light")
    expect(save).toHaveBeenLastCalledWith({ theme: "light", interfaceSize: "medium" })
    useInterfaceSizeStore.getState().setSize("large")
    expect(save).toHaveBeenLastCalledWith({ theme: "light", interfaceSize: "large" })
  })

  it("applies a value from the other app without saving it again", () => {
    const save = vi.fn()
    connectSharedAppearance(save)
    expect(applySharedAppearance({ theme: "beige", interfaceSize: "small" })).toBe(true)
    expect(useThemeStore.getState().preference).toBe("beige")
    expect(document.documentElement.dataset.theme).toBe("beige")
    expect(document.documentElement.dataset.interfaceSize).toBe("small")
    expect(localStorage.getItem("panelyth.theme")).toBe("beige")
    expect(save).not.toHaveBeenCalled()
  })

  it("ignores unusable values", () => {
    expect(applySharedAppearance(null)).toBe(false)
    expect(applySharedAppearance({ theme: "neon", interfaceSize: 3 })).toBe(false)
    expect(useThemeStore.getState().preference).toBe("dark")
  })
})

describe("startSharedAppearanceSync", () => {
  beforeEach(() => {
    localStorage.clear()
    initTheme()
    initInterfaceSize()
  })

  const port = (settings: Record<string, unknown> | null) => {
    let listener: ((key: string, value: unknown) => void) | null = null
    return {
      loadSettings: vi.fn(async () => settings),
      saveSetting: vi.fn(),
      onSettingChanged: vi.fn((l: (key: string, value: unknown) => void) => {
        listener = l
        return () => (listener = null)
      }),
      emit: (key: string, value: unknown) => listener?.(key, value),
    }
  }

  it("applies the shared value on start and follows the other app", async () => {
    const p = port({ "shared.appearance": { theme: "light", interfaceSize: "large" } })
    const stop = startSharedAppearanceSync(p)
    await vi.waitFor(() => expect(useThemeStore.getState().preference).toBe("light"))
    expect(useInterfaceSizeStore.getState().size).toBe("large")
    p.emit("shared.appearance", { theme: "dark-brown", interfaceSize: "small" })
    expect(useThemeStore.getState().preference).toBe("dark-brown")
    p.emit("workspace", { theme: "light" })
    expect(useThemeStore.getState().preference).toBe("dark-brown")
    expect(p.saveSetting).not.toHaveBeenCalled()
    stop()
  })

  it("migrates this app's local values the first time", async () => {
    localStorage.setItem("panelyth.theme", "beige")
    initTheme()
    const p = port({})
    const stop = startSharedAppearanceSync(p)
    await vi.waitFor(() =>
      expect(p.saveSetting).toHaveBeenCalledWith("shared.appearance", {
        theme: "beige",
        interfaceSize: "medium",
      }),
    )
    useThemeStore.getState().setPreference("light")
    expect(p.saveSetting).toHaveBeenLastCalledWith("shared.appearance", {
      theme: "light",
      interfaceSize: "medium",
    })
    stop()
  })
})
