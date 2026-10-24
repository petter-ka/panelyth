import { beforeEach, describe, expect, it } from "vitest"
import {
  applyLayoutPreset,
  LAYOUT_PRESETS,
  matchingPreset,
  type LayoutState,
} from "./features/layoutPresets"
import { resetListing, useListingStore } from "./features/listing"
import { usePanelsStore } from "./features/panels"
import { resetViewers, useViewersStore } from "./features/viewers"
import { installFakeCommander } from "./test/fakeApi"

// The title strip's layout presets (ADR-0045): each sets the whole window.

const layout = (over: Partial<LayoutState> = {}): LayoutState => ({
  active: "left",
  views: { left: "full", right: "full" },
  tree: "off",
  quick: false,
  arrangement: "side",
  ...over,
})

const windowNow = () => ({
  left: useListingStore.getState().left.view,
  right: useListingStore.getState().right.view,
  tree: usePanelsStore.getState().tree,
  quick: useViewersStore.getState().quick,
})

describe("layout presets", () => {
  beforeEach(() => {
    installFakeCommander({ folders: [] })
    resetListing()
    resetViewers()
    usePanelsStore.setState({ active: "left", tree: "off", arrangement: "side" })
  })

  it("names the preset the window shows, and none after a change by hand", () => {
    expect(matchingPreset(layout())).toBe("details")
    expect(matchingPreset(layout({ views: { left: "brief", right: "brief" } }))).toBe("list")
    expect(matchingPreset(layout({ tree: "one" }))).toBe("tree")
    expect(matchingPreset(layout({ views: { left: "thumbs", right: "thumbs" } }))).toBe("gallery")
    // Quick view: only the active panel's view counts; the other shows the preview.
    expect(
      matchingPreset(
        layout({ quick: true, active: "right", views: { left: "brief", right: "full" } }),
      ),
    ).toBe("preview")
    // Mixed by hand: no preset is lit.
    expect(matchingPreset(layout({ views: { left: "full", right: "brief" } }))).toBeNull()
    expect(matchingPreset(layout({ tree: "two" }))).toBeNull()
    // Single: the active panel alone, as thumbnails.
    expect(
      matchingPreset(layout({ arrangement: "single", views: { left: "thumbs", right: "thumbs" } })),
    ).toBe("single")
    expect(matchingPreset(layout({ arrangement: "single" }))).toBeNull()
    // Stacked: the panels one above the other.
    expect(matchingPreset(layout({ arrangement: "stacked" }))).toBe("stacked")
    expect(
      matchingPreset(layout({ arrangement: "stacked", views: { left: "brief", right: "brief" } })),
    ).toBeNull()
  })

  it("every preset applied is the one the window then matches", () => {
    for (const preset of LAYOUT_PRESETS) {
      applyLayoutPreset(preset.id)
      const now = windowNow()
      expect(
        matchingPreset({
          active: usePanelsStore.getState().active,
          views: { left: now.left, right: now.right },
          tree: now.tree,
          quick: now.quick !== null,
          arrangement: usePanelsStore.getState().arrangement,
        }),
        preset.id,
      ).toBe(preset.id)
    }
  })

  it("sets both panels whichever is active, and opens and closes quick view", () => {
    usePanelsStore.setState({ active: "right" })
    applyLayoutPreset("gallery")
    expect(windowNow()).toMatchObject({ left: "thumbs", right: "thumbs", tree: "off", quick: null })

    applyLayoutPreset("preview")
    // The active panel in columns; quick view follows it and shows in the other panel.
    expect(windowNow()).toMatchObject({ right: "full", quick: "right" })

    applyLayoutPreset("tree")
    expect(windowNow()).toMatchObject({ left: "full", right: "full", tree: "one", quick: null })

    applyLayoutPreset("stacked")
    expect(usePanelsStore.getState().arrangement).toBe("stacked")
    expect(windowNow()).toMatchObject({ tree: "off", quick: null })
    // Every other preset puts the panels side by side again.
    applyLayoutPreset("list")
    expect(usePanelsStore.getState().arrangement).toBe("side")
  })
})
