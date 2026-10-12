import type { MenuItemConstructorOptions } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  markActiveApp,
  menuKey,
  menuTemplate,
  type MenuActions,
  type MenuContext,
} from "../src/main/menu"
import { MENU_TEXT, menuText } from "../src/main/menuText"

type Item = MenuItemConstructorOptions

const context = (patch: Partial<MenuContext> = {}): MenuContext => ({
  platform: "win32",
  packaged: true,
  commanderEnabled: true,
  activeApp: "viewer",
  update: { mode: "auto", phase: "idle" },
  text: menuText("en"),
  ...patch,
})

const actions = (): MenuActions => ({
  command: vi.fn(),
  switchApp: vi.fn(),
  openTarget: vi.fn(),
})

const submenu = (item: Item | undefined): Item[] => (item?.submenu as Item[] | undefined) ?? []
const flat = (items: Item[]): Item[] => items.flatMap((i) => [i, ...flat(submenu(i))])
const byId = (items: Item[], id: string): Item | undefined => flat(items).find((i) => i.id === id)
const click = (item: Item | undefined): void =>
  (item?.click as unknown as (() => void) | undefined)?.()

describe("the native menu (Stage P06)", () => {
  it("has File, Edit, View and Help on Windows and Linux, with About under Help", () => {
    const menu = menuTemplate(context(), actions())
    expect(menu.map((m) => m.label)).toEqual(["File", "Edit", "View", "Help"])
    const help = submenu(menu.at(-1))
    expect(help.filter((i) => i.type !== "separator").map((i) => i.label)).toEqual([
      "Keyboard Shortcuts",
      "Check for Updates…",
      "Release Notes",
      "Report a Problem",
      "Panelyth Website",
      "Open Log Folder",
      "Third-Party Licenses",
      "About Panelyth",
    ])
    expect(submenu(menu[0]).map((i) => i.label ?? i.type)).toEqual([
      "Settings…",
      "separator",
      "Exit",
    ])
  })

  it("puts About, the update check and Settings in the app menu on macOS", () => {
    const menu = menuTemplate(context({ platform: "darwin" }), actions())
    expect(menu.map((m) => m.label)).toEqual(["Panelyth", "File", "Edit", "View", "Window", "Help"])
    expect(
      submenu(menu[0])
        .slice(0, 4)
        .map((i) => i.label ?? i.type),
    ).toEqual(["About Panelyth", "Check for Updates…", "separator", "Settings…"])
    // Once each: not under Help again.
    expect(flat(menu).filter((i) => i.id === "about")).toHaveLength(1)
    expect(flat(menu).filter((i) => i.id === "update")).toHaveLength(1)
  })

  it("sends the app's items to the app and opens only fixed targets", () => {
    const act = actions()
    const menu = menuTemplate(context(), act)
    click(byId(menu, "about"))
    click(byId(menu, "update"))
    click(byId(menu, "settings"))
    click(byId(menu, "shortcuts"))
    expect(vi.mocked(act.command).mock.calls.map(([c]) => c)).toEqual([
      "about",
      "checkForUpdates",
      "settings",
      "shortcuts",
    ])
    for (const target of ["releases", "issues", "website", "logs", "notices"]) {
      click(byId(menu, `open-${target}`))
    }
    expect(vi.mocked(act.openTarget).mock.calls.map(([t]) => t)).toEqual([
      "releases",
      "issues",
      "website",
      "logs",
      "notices",
    ])
  })

  it("names the update's next step, and has no update item when updates are off", () => {
    const label = (update: MenuContext["update"]): unknown =>
      byId(menuTemplate(context({ update }), actions()), "update")?.label
    expect(label({ mode: "auto", phase: "upToDate" })).toBe("Check for Updates…")
    expect(label({ mode: "manual", phase: "available" })).toBe("Update Available…")
    expect(label({ mode: "auto", phase: "downloading" })).toBe("Update Available…")
    expect(label({ mode: "auto", phase: "ready" })).toBe("Restart to Update…")
    expect(label({ mode: "off", phase: "idle" })).toBeUndefined()
  })

  it("switches apps from View, and shows no switch without the commander", () => {
    const act = actions()
    const menu = menuTemplate(context({ activeApp: "commander" }), act)
    expect(byId(menu, "app-viewer")).toMatchObject({ type: "radio", checked: false })
    expect(byId(menu, "app-commander")).toMatchObject({ type: "radio", checked: true })
    click(byId(menu, "app-viewer"))
    expect(act.switchApp).toHaveBeenCalledWith("viewer")
    expect(
      byId(menuTemplate(context({ commanderEnabled: false }), act), "app-viewer"),
    ).toBeUndefined()
  })

  it("moves the mark in View on a switch, without a new menu", () => {
    const items: Record<string, { checked: boolean }> = {
      "app-viewer": { checked: true },
      "app-commander": { checked: false },
    }
    const menu = { getMenuItemById: vi.fn((id: string) => items[id] ?? null) }
    markActiveApp(menu, "commander")
    expect(items).toEqual({ "app-viewer": { checked: false }, "app-commander": { checked: true } })
    markActiveApp(menu, "viewer")
    expect(items["app-viewer"]!.checked).toBe(true)
    // No menu, or one without the switch (the commander is off): nothing to do.
    expect(() => markActiveApp(null, "viewer")).not.toThrow()
    expect(() => markActiveApp({ getMenuItemById: () => null }, "viewer")).not.toThrow()
  })

  it("reloads and opens developer tools in development builds only", () => {
    const roles = (packaged: boolean): unknown[] =>
      flat(menuTemplate(context({ packaged }), actions())).map((i) => i.role)
    expect(roles(true)).not.toContain("reload")
    expect(roles(true)).not.toContain("toggleDevTools")
    expect(roles(false)).toEqual(expect.arrayContaining(["reload", "toggleDevTools"]))
  })

  it("is rebuilt only when what it shows changes", () => {
    const key = (patch: Partial<MenuContext>, language = "en"): string =>
      menuKey(context(patch), language)
    expect(key({ update: { mode: "auto", phase: "checking" } })).toBe(key({}))
    expect(key({ update: { mode: "auto", phase: "downloading" } })).toBe(
      key({ update: { mode: "auto", phase: "available" } }),
    )
    expect(key({ update: { mode: "auto", phase: "ready" } })).not.toBe(key({}))
    // A switch never rebuilds: the mark moves on the menu that is there.
    expect(key({ activeApp: "commander" })).toBe(key({}))
    expect(key({}, "hu")).not.toBe(key({}))
  })
})

describe("the menu's text", () => {
  it("has every label in every language of the apps", () => {
    const keys = Object.keys(MENU_TEXT.en!).sort()
    expect(Object.keys(MENU_TEXT).sort()).toEqual(["de", "en", "es", "fr", "hu", "it", "pl", "ru"])
    for (const [language, text] of Object.entries(MENU_TEXT)) {
      expect(Object.keys(text).sort(), language).toEqual(keys)
      for (const [key, label] of Object.entries(text)) {
        expect(label.trim().length, `${language}.${key}`).toBeGreaterThan(0)
      }
      // Items that open a dialog keep their ellipsis in every language.
      for (const key of ["checkForUpdates", "updateAvailable", "restartToUpdate", "settings"]) {
        expect((text as unknown as Record<string, string>)[key], `${language}.${key}`).toMatch(/…$/)
      }
    }
  })

  it("falls back to English", () => {
    expect(menuText("hu").help).toBe("Súgó")
    expect(menuText("xx")).toBe(MENU_TEXT.en)
    expect(menuText(undefined)).toBe(MENU_TEXT.en)
    expect(menuText("toString")).toBe(MENU_TEXT.en)
  })
})
