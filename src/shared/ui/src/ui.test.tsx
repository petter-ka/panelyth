import { resetLocale, useLocaleStore } from "@panelyth/i18n"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppSwitchButton,
  AppSwitcher,
  TooltipProvider,
  applySharedAppearance,
  connectSharedAppearance,
  startSharedAppearanceSync,
  initInterfaceSize,
  initTheme,
  setLanguage,
  Icon,
  requestSettingsTab,
  SharedSettingsDialog,
  ShortcutsDialog,
  useIconSetStore,
  useInterfaceSizeStore,
  useStyleStore,
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

describe("AppSwitcher", () => {
  it("marks the current app with the accent and a bar on the rail's edge, not the other", () => {
    render(
      <AppSwitcher
        current="commander"
        shortcut="Ctrl+Shift+M"
        onSwitch={vi.fn()}
        onSettings={vi.fn()}
      />,
    )
    const current = screen.getByTestId("current-app")
    const other = screen.getByTestId("app-switch")
    expect(current).toHaveAttribute("aria-current", "page")
    expect(current).toHaveAttribute("data-target", "commander")
    expect(current.className).toMatch(/text-accent/)
    expect(current.querySelector("span.bg-accent")).not.toBeNull()
    expect(other).not.toHaveAttribute("aria-current")
    expect(other.className).not.toMatch(/accent/)
    expect(other.querySelector("span.bg-accent")).toBeNull()
  })
})

describe("shared appearance", () => {
  beforeEach(() => {
    localStorage.clear()
    resetLocale()
    connectSharedAppearance(null)
    initTheme()
    initInterfaceSize()
  })

  it("saves both values when either changes", () => {
    const save = vi.fn()
    connectSharedAppearance(save)
    useThemeStore.getState().setPreference("light")
    expect(save).toHaveBeenLastCalledWith({
      style: "classic",
      theme: "light",
      interfaceSize: "medium",
      iconSet: "default",
      language: "en",
    })
    useInterfaceSizeStore.getState().setSize("large")
    expect(save).toHaveBeenLastCalledWith({
      style: "classic",
      theme: "light",
      interfaceSize: "large",
      iconSet: "default",
      language: "en",
    })
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

  it("saves and applies the icon library", () => {
    const save = vi.fn()
    connectSharedAppearance(save)
    useIconSetStore.getState().setIconSet("fluent")
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ iconSet: "fluent" }))
    expect(localStorage.getItem("panelyth.iconSet")).toBe("fluent")
    save.mockClear()
    expect(applySharedAppearance({ iconSet: "material" })).toBe(true)
    expect(useIconSetStore.getState().iconSet).toBe("material")
    expect(save).not.toHaveBeenCalled()
    expect(applySharedAppearance({ iconSet: "emoji" })).toBe(false)
    expect(useIconSetStore.getState().iconSet).toBe("material")
    initInterfaceSize()
    expect(useIconSetStore.getState().iconSet).toBe("material")
  })

  it("ignores unusable values", () => {
    expect(applySharedAppearance(null)).toBe(false)
    expect(applySharedAppearance({ theme: "neon", interfaceSize: 3 })).toBe(false)
    expect(useThemeStore.getState().preference).toBe("dark")
  })
})

describe("Settings → Appearance", () => {
  beforeEach(() => {
    localStorage.clear()
    resetLocale()
    connectSharedAppearance(null)
    initTheme()
    initInterfaceSize()
    requestSettingsTab("appearance")
    render(
      <TooltipProvider>
        <SharedSettingsDialog
          currentApp="viewer"
          open
          onClose={vi.fn()}
          showGeneral
          settingsReady
          appSettings={<div />}
          onOpenShortcuts={vi.fn()}
        />
      </TooltipProvider>,
    )
  })

  const chosen = (): string[] =>
    screen.getAllByRole("button", { pressed: true }).map((b) => b.getAttribute("aria-label") ?? "")

  it("groups the themes as dark and light; System clears the choice", () => {
    const dark = screen.getByRole("group", { name: "Dark themes" })
    const light = screen.getByRole("group", { name: "Light themes" })
    expect(
      [dark, light].map((g) => [...g.querySelectorAll("button")].map((b) => b.textContent)),
    ).toEqual([
      ["Dark", "Dark purple", "Dark brown"],
      ["Light", "Beige", "Light brown"],
    ])
    const system = screen.getByRole("checkbox", { name: "System" })
    expect(system).not.toBeChecked()
    expect(chosen()).toContain("Dark")

    fireEvent.click(system)
    expect(useThemeStore.getState().preference).toBe("system")
    expect(system).toBeChecked()
    expect(chosen()).not.toEqual(expect.arrayContaining(["Dark"]))
    for (const g of [dark, light]) expect(g.querySelector("[aria-pressed=true]")).toBeNull()

    // A theme unticks System; unticking it keeps what the system shows (light in jsdom).
    fireEvent.click(screen.getByRole("button", { name: "Beige" }))
    expect(useThemeStore.getState().preference).toBe("beige")
    expect(system).not.toBeChecked()
    fireEvent.click(system)
    fireEvent.click(system)
    expect(useThemeStore.getState().preference).toBe("light")
  })

  it("offers the classic and the liquid glass style, apart from the theme", () => {
    const style = screen.getByRole("group", { name: "Design style" })
    expect([...style.querySelectorAll("button")].map((b) => b.textContent)).toEqual([
      "Classic",
      "Liquid glass",
    ])
    expect(chosen()).toContain("Classic")
    fireEvent.click(screen.getByRole("button", { name: "Liquid glass" }))
    expect(useStyleStore.getState().style).toBe("glass")
    expect(document.documentElement.dataset.style).toBe("glass")
    expect(
      screen.getByText(
        "Translucent panels float over a soft background drawn from the theme's colors.",
      ),
    ).toBeVisible()
    expect(useThemeStore.getState().preference).toBe("dark")
    expect(chosen()).toEqual(expect.arrayContaining(["Liquid glass", "Dark"]))
  })

  it("offers an extra large interface size", () => {
    fireEvent.click(screen.getByRole("button", { name: "Extra large" }))
    expect(useInterfaceSizeStore.getState().size).toBe("xlarge")
    expect(document.documentElement.dataset.interfaceSize).toBe("xlarge")
    expect(applySharedAppearance({ interfaceSize: "xlarge" })).toBe(true)
  })
})

describe("startSharedAppearanceSync", () => {
  beforeEach(() => {
    localStorage.clear()
    resetLocale()
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

  it("opens a fresh profile in the classic style, independent of the theme", () => {
    expect(useStyleStore.getState().style).toBe("classic")
    expect(document.documentElement.dataset.style).toBe("classic")
    useThemeStore.getState().setPreference("light")
    expect(document.documentElement.dataset.style).toBe("classic")
  })

  it("keeps the chosen style locally, applies it before the first render and shares it", () => {
    const save = vi.fn()
    connectSharedAppearance(save)
    useStyleStore.getState().setStyle("glass")
    expect(document.documentElement.dataset.style).toBe("glass")
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ style: "glass" }))
    connectSharedAppearance(null)
    document.documentElement.dataset.style = ""
    initInterfaceSize()
    expect(useStyleStore.getState().style).toBe("glass")
    expect(document.documentElement.dataset.style).toBe("glass")
  })

  it("follows the other app's style and ignores an unknown one", () => {
    expect(applySharedAppearance({ style: "glass" })).toBe(true)
    expect(document.documentElement.dataset.style).toBe("glass")
    expect(localStorage.getItem("panelyth.style")).toBe("glass")
    expect(applySharedAppearance({ style: "aqua" })).toBe(false)
    expect(useStyleStore.getState().style).toBe("glass")
    // A value saved before the style existed leaves this app's style alone.
    expect(applySharedAppearance({ theme: "dark" })).toBe(true)
    expect(useStyleStore.getState().style).toBe("glass")
  })

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

  it("shares the language and applies the other app's", async () => {
    const p = port({})
    const stop = startSharedAppearanceSync(p)
    await setLanguage("de")
    expect(p.saveSetting).toHaveBeenLastCalledWith(
      "shared.appearance",
      expect.objectContaining({ language: "de" }),
    )
    p.emit("shared.appearance", { theme: "dark", interfaceSize: "medium", language: "fr" })
    await vi.waitFor(() => expect(useLocaleStore.getState().locale).toBe("fr"))
    p.emit("shared.appearance", { theme: "dark", interfaceSize: "medium", language: "klingon" })
    expect(useLocaleStore.getState().locale).toBe("fr")
    stop()
  })

  it("migrates this app's local values the first time", async () => {
    localStorage.setItem("panelyth.theme", "beige")
    initTheme()
    const p = port({})
    const stop = startSharedAppearanceSync(p)
    await vi.waitFor(() =>
      expect(p.saveSetting).toHaveBeenCalledWith("shared.appearance", {
        style: "classic",
        theme: "beige",
        interfaceSize: "medium",
        iconSet: "default",
        language: "en",
      }),
    )
    useThemeStore.getState().setPreference("light")
    expect(p.saveSetting).toHaveBeenLastCalledWith("shared.appearance", {
      style: "classic",
      theme: "light",
      interfaceSize: "medium",
      iconSet: "default",
      language: "en",
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

describe("Icon", () => {
  const renderIcon = () =>
    render(
      <Icon name="search" data-testid="icon">
        <path d="M0 0" />
      </Icon>,
    )

  beforeEach(() => {
    localStorage.clear()
    useIconSetStore.setState({ iconSet: "default" })
  })

  it("draws the built-in stroked icon by default", () => {
    renderIcon()
    const svg = screen.getByTestId("icon")
    expect(svg).toHaveAttribute("viewBox", "0 0 16 16")
    expect(svg).toHaveAttribute("stroke", "currentColor")
    expect(svg.querySelector("path")).toHaveAttribute("d", "M0 0")
  })

  it.each(["fluent", "material"] as const)("draws the %s icon when selected", (iconSet) => {
    useIconSetStore.setState({ iconSet })
    renderIcon()
    const svg = screen.getByTestId("icon")
    expect(svg).toHaveAttribute("viewBox", "0 0 24 24")
    expect(svg).toHaveAttribute("fill", "currentColor")
    expect(svg.querySelector("path")?.getAttribute("d")).not.toBe("M0 0")
  })

  it("redraws when the library changes", () => {
    renderIcon()
    act(() => useIconSetStore.getState().setIconSet("material"))
    expect(screen.getByTestId("icon")).toHaveAttribute("viewBox", "0 0 24 24")
  })
})

describe("ShortcutsDialog", () => {
  const actions = [
    {
      id: "nav.back",
      scope: "global",
      group: "Navigation",
      label: "Back",
      defaults: ["Alt+ArrowLeft"],
    },
    {
      id: "nav.up",
      scope: "global",
      group: "Navigation",
      label: "Up one folder",
      defaults: ["Backspace"],
    },
  ]

  it("offers Reset only for a shortcut that was changed", () => {
    const onReset = vi.fn()
    render(
      <ShortcutsDialog
        open
        onOpenChange={() => undefined}
        actions={actions}
        chords={{ "nav.back": ["Alt+ArrowLeft"], "nav.up": ["Ctrl+U"] }}
        customized={new Set(["nav.up"])}
        onSet={() => undefined}
        onReset={onReset}
        onResetAll={() => undefined}
      />,
    )
    expect(screen.getByRole("button", { name: "Change shortcut for Back" })).toBeEnabled()
    expect(screen.queryByRole("button", { name: "Reset shortcut for Back" })).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Reset shortcut for Up one folder" }))
    expect(onReset).toHaveBeenCalledWith("nav.up")
  })
})
