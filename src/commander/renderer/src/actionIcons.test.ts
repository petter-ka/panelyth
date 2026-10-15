import { describe, expect, it } from "vitest"
import { ACTION_ICONS } from "./components/QuickActionBar"
import { TOOLBAR_ACTIONS } from "./features/tools"

describe("toolbar icons", () => {
  it("every action that can go on the toolbar has an icon of its own", () => {
    expect(TOOLBAR_ACTIONS.filter((id) => !ACTION_ICONS[id])).toEqual([])
  })
})
