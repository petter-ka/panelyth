import { act, render } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"
import { useNoticeStore } from "../features/clipboard/clipboard"
import { resetFolderStore, useFolderStore } from "../features/folder/folderStore"
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
