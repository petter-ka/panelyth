import { act } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installFakeBridge } from "../../test/fakeBridge"
import { resetLibraryStore, startLibraryMonitoring, useLibraryStore } from "./libraryStore"

// Stage C03: the bookmarks are the commander's hotlist and the recent
// locations are fed by both apps (docs/shared/APP-SWITCHING.md).

let stop: (() => void) | null = null

beforeEach(() => resetLibraryStore())
afterEach(() => {
  stop?.()
  stop = null
})

describe("shared bookmarks and recent locations", () => {
  it("follows bookmark changes made in the commander", async () => {
    const fake = installFakeBridge()
    await act(async () => {
      stop = startLibraryMonitoring()
    })
    const bookmarks = [{ id: 4, path: "/work", label: "Work", group: "Jobs" }]
    act(() => fake.push("bookmarks.changed", { bookmarks }))
    expect(useLibraryStore.getState().bookmarks).toEqual(bookmarks)
  })

  it("re-reads recent locations when the viewer is shown again", async () => {
    const fake = installFakeBridge()
    await act(async () => {
      stop = startLibraryMonitoring()
    })
    fake.backend.recent = [{ path: "/from/commander", lastOpenedAt: 9 }]
    await act(async () => {
      fake.push("app.visibility", { app: "commander", visible: true })
    })
    expect(useLibraryStore.getState().recent).toEqual([])
    await act(async () => {
      fake.push("app.visibility", { app: "viewer", visible: true })
    })
    expect(useLibraryStore.getState().recent).toEqual([
      { path: "/from/commander", lastOpenedAt: 9 },
    ])
  })
})
