import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useNoticeStore } from "../features/clipboard/clipboard"
import { resetFolderStore, useFolderStore } from "../features/folder/folderStore"
import { useStartupStore } from "../features/settings/startupFolder"
import { useSidecarStore } from "../features/system/sidecarStore"
import { installFakeBridge } from "../test/fakeBridge"
import { mockViewport } from "../test/viewport"
import { ContentPane } from "./ContentPane"

beforeEach(() => {
  mockViewport(1000, 800)
  installFakeBridge()
  resetFolderStore()
  useNoticeStore.setState({ notice: null })
})

describe("a failed open", () => {
  it("keeps the current folder and announces the error", () => {
    render(<ContentPane />)
    act(() => {
      useFolderStore.setState({
        query: { queryId: 1, version: 1, total: 14 },
        error: "This folder no longer exists.",
      } as never)
    })
    expect(useNoticeStore.getState().notice).toMatchObject({
      text: "This folder no longer exists.",
      tone: "error",
    })
  })

  it("is not announced twice when nothing is shown (the empty state says it)", () => {
    render(<ContentPane />)
    act(() => {
      useFolderStore.setState({ error: "This folder no longer exists." })
    })
    expect(useNoticeStore.getState().notice).toBeNull()
  })
})

describe("the first folder on its way", () => {
  it("shows tiles to come, never 'No folder open', until the start has decided and opened it", () => {
    const sidecar = useSidecarStore.getState()
    try {
      useSidecarStore.setState({ status: { state: "ready" } } as never)
      useStartupStore.setState({ pending: true })
      render(<ContentPane />)
      expect(screen.getByTestId("grid-placeholder")).toBeInTheDocument()
      expect(screen.queryByText("No folder open")).toBeNull()
      // Decided: the folder opens, still tiles to come.
      act(() => {
        useStartupStore.setState({ pending: false })
        useFolderStore.setState({ opening: true })
      })
      expect(screen.getByTestId("grid-placeholder")).toBeInTheDocument()
      // Nothing opened after all (no folder to start with): the empty state says so.
      act(() => useFolderStore.setState({ opening: false }))
      expect(screen.getByText("No folder open")).toBeInTheDocument()
    } finally {
      useStartupStore.setState({ pending: false })
      useSidecarStore.setState(sidecar)
    }
  })
})
