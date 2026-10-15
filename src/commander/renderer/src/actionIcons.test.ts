import { NO_OVERRIDES, resolveKeymap } from "@panelyth/renderer-core"
import { describe, expect, it } from "vitest"
import { ACTION_ICONS } from "./components/QuickActionBar"
import { ACTIONS, SCOPES } from "./features/keymap"
import { TOOLBAR_ACTIONS } from "./features/tools"

describe("toolbar icons", () => {
  it("every action that can go on the toolbar has an icon of its own", () => {
    expect(TOOLBAR_ACTIONS.filter((id) => !ACTION_ICONS[id])).toEqual([])
  })
})

describe("deleting from the keyboard", () => {
  it("Delete and Shift+Delete everywhere; on a Mac also ⌘⌫ and ⇧⌘⌫ / ⌥⌘⌫ (its delete key is Backspace)", () => {
    const pc = resolveKeymap(ACTIONS, SCOPES, NO_OVERRIDES, false)
    expect(pc.lookup.panels.get("Delete")).toBe("files.trash")
    expect(pc.lookup.panels.get("Shift+Delete")).toBe("files.delete")
    expect(pc.lookup.panels.get("Mod+Backspace")).toBeUndefined()
    const mac = resolveKeymap(ACTIONS, SCOPES, NO_OVERRIDES, true)
    expect(mac.lookup.panels.get("Delete")).toBe("files.trash")
    expect(mac.lookup.panels.get("Mod+Backspace")).toBe("files.trash")
    expect(mac.lookup.panels.get("Mod+Shift+Backspace")).toBe("files.delete")
    expect(mac.lookup.panels.get("Mod+Alt+Backspace")).toBe("files.delete")
    // Plain Backspace stays the parent folder.
    expect(mac.lookup.panels.get("Backspace")).toBe("nav.up")
  })
})
