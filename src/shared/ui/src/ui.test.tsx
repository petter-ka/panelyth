import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppSwitchButton,
  TooltipProvider,
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

describe("Tooltip", () => {
  const rect = (left: number, top: number, width: number, height: number): DOMRect =>
    ({ left, top, width, height, right: left + width, bottom: top + height }) as DOMRect

  it("is placed against the marked part of its target, the innermost one", async () => {
    render(
      <TooltipProvider delay={0}>
        <div data-testid="tile" data-tooltip-content="IMG_1.jpg">
          <div data-testid="slot" data-tooltip-anchor>
            <div data-testid="picture" data-tooltip-anchor />
          </div>
          <div>IMG_1.jpg</div>
        </div>
      </TooltipProvider>,
    )
    // A 180 px tile whose fitted picture is a 60 px wide strip, lower in the slot.
    screen.getByTestId("tile").getBoundingClientRect = () => rect(100, 100, 180, 204)
    screen.getByTestId("slot").getBoundingClientRect = () => rect(100, 100, 180, 180)
    screen.getByTestId("picture").getBoundingClientRect = () => rect(160, 150, 60, 80)
    fireEvent.pointerOver(screen.getByTestId("picture"))
    const popup = await screen.findByRole("tooltip")
    // Centered on the picture and just above it, not above the tile.
    expect(popup.style.left).toBe("190px")
    expect(popup.style.top).toBe("142px")
  })
})
