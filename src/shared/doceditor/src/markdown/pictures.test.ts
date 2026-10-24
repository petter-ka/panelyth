import { EditorSelection, EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { TEXTEDIT_IMAGE_CHUNK_BYTES, TEXTEDIT_MAX_IMAGE_BYTES } from "@panelyth/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { fakeApi, type FakeApi } from "../testing/fakeApi"
import { addPictures, pictureInput, pictureMarkdown, type PictureDeps } from "./pictures"

let views: EditorView[] = []
afterEach(() => {
  for (const v of views) v.destroy()
  views = []
})

function setup(doc = "start\nend", cursor = 5) {
  const api: FakeApi = fakeApi()
  const received: { seq: number; bytes: number[]; whole: boolean }[] = []
  api.assetChunk = vi.fn(async (seq: number, data: Uint8Array) => {
    // A copy per chunk: the view must not carry a larger buffer over IPC.
    received.push({
      seq,
      bytes: [...data.slice(0, 2)],
      whole: data.buffer.byteLength === data.byteLength,
    })
    api.assetChunks.push({ seq, size: data.byteLength })
    return { ok: true as const, r: { ok: true } }
  })
  const notices: string[] = []
  const progress: (number | null)[] = []
  const deps: PictureDeps = {
    api,
    notify: (text) => notices.push(text),
    progress: (p) => progress.push(p ? p.sent : null),
  }
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [pictureInput(deps)],
    }),
  })
  views.push(view)
  return { api, view, deps, notices, progress, received }
}

const file = (size: number, name = "photo.png", type = "image/png"): File => {
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i += 4096) bytes[i] = (i / 4096) % 251
  return new File([bytes], name, { type })
}

describe("adding pictures", () => {
  it("sends the bytes in ordered 1 MiB chunks, commits, and links at the position", async () => {
    const { api, view, deps, received, progress } = setup()
    const size = TEXTEDIT_IMAGE_CHUNK_BYTES * 2 + 100
    const n = await addPictures(view, [file(size, "Holiday photo.png")], { pos: 5 }, false, deps)
    expect(n).toBe(1)
    expect(api.assetChunks).toEqual([
      { seq: 0, size: TEXTEDIT_IMAGE_CHUNK_BYTES },
      { seq: 1, size: TEXTEDIT_IMAGE_CHUNK_BYTES },
      { seq: 2, size: 100 },
    ])
    expect(received.every((r) => r.whole)).toBe(true)
    expect(api.assetNames).toEqual(["Holiday photo"])
    expect(view.state.doc.toString()).toBe("start![Holiday photo](<assets/Holiday photo.png>)\nend")
    expect(progress.filter((p) => p !== null).at(-1)).toBe(size)
    expect(progress.at(-1)).toBeNull()
  })

  it("puts several pictures one per line, one after the other", async () => {
    const { api, view, deps } = setup("", 0)
    let inFlight = 0
    let most = 0
    const chunk = api.assetChunk
    api.assetChunk = vi.fn(async (seq: number, data: Uint8Array) => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 1))
      inFlight--
      return chunk(seq, data)
    })
    await addPictures(
      view,
      [file(10, "a.png"), file(10, "b.jpg", "image/jpeg")],
      { pos: 0 },
      false,
      deps,
    )
    expect(most).toBe(1)
    expect(view.state.doc.toString()).toBe("![a](assets/a.png)\n![b](assets/b.png)")
  })

  it("refuses a picture over 25 MB and a file that is not a picture, changing nothing", async () => {
    const { api, view, deps, notices } = setup()
    const big = { name: "huge.png", type: "image/png", size: TEXTEDIT_MAX_IMAGE_BYTES + 1 } as File
    await addPictures(view, [big, file(10, "notes.txt", "text/plain")], { pos: 5 }, false, deps)
    expect(api.assetChunks).toEqual([])
    expect(api.assetNames).toEqual([])
    expect(view.state.doc.toString()).toBe("start\nend")
    expect(notices).toEqual(["huge.png is larger than 25 MB."])
  })

  it("a refusal by the sidecar is a notice; the text stays", async () => {
    const { api, view, deps, notices } = setup()
    api.assetCommit = vi.fn(async () => ({
      ok: false as const,
      e: {
        code: "INVALID_ARGUMENT" as const,
        message: "no",
        retryable: false,
        details: { reason: "notImage" },
      },
    }))
    await addPictures(view, [file(10, "fake.png")], { pos: 5 }, false, deps)
    expect(view.state.doc.toString()).toBe("start\nend")
    expect(notices).toEqual(["fake.png isn't a picture."])
  })

  it("escapes brackets in the name", () => {
    expect(pictureMarkdown("a [b]", "assets/x.png")).toBe("![a \\[b\\]](assets/x.png)")
  })
})

describe("paste and drop", () => {
  const pasteEvent = (files: File[], text = ""): Event => {
    const event = new Event("paste", { bubbles: true, cancelable: true })
    const items = [
      ...files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f })),
      ...(text ? [{ kind: "string", type: "text/plain", getAsFile: () => null }] : []),
    ]
    Object.defineProperty(event, "clipboardData", {
      value: { items, getData: () => text, types: text ? ["text/plain"] : ["Files"] },
    })
    return event
  }

  it("a pasted screenshot goes in at the cursor, named screenshot", async () => {
    const { api, view } = setup("ab", 1)
    const event = pasteEvent([file(20, "image.png")])
    view.contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("a![screenshot](assets/screenshot.png)b"),
    )
    expect(api.assetNames).toEqual(["screenshot"])
  })

  it("follows edits made while the picture uploads", async () => {
    const { api, view } = setup("ab", 1)
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const commit = api.assetCommit
    api.assetCommit = vi.fn(async (name: string) => {
      await gate
      return commit(name)
    })
    view.contentDOM.dispatchEvent(pasteEvent([file(20)]))
    await vi.waitFor(() => expect(api.assetCommit).toHaveBeenCalled())
    view.dispatch({ changes: { from: 0, insert: "XYZ" } })
    release()
    await vi.waitFor(() =>
      expect(view.state.doc.toString()).toBe("XYZa![screenshot](assets/screenshot.png)b"),
    )
  })

  it("text on the clipboard pastes as usual", () => {
    const { api, view } = setup("ab", 1)
    view.contentDOM.dispatchEvent(pasteEvent([], "hello"))
    expect(api.assetChunk).not.toHaveBeenCalled()
    expect(view.state.doc.toString()).toBe("ahellob")
  })

  it("drops picture files, ignores other files, keeps text drops", async () => {
    const { api, view } = setup("ab", 0)
    // jsdom has no layout: the drop lands where posAtCoords says.
    vi.spyOn(view, "posAtCoords").mockReturnValue(2)
    const drop = (files: File[]): Event => {
      const event = new Event("drop", { bubbles: true, cancelable: true })
      Object.defineProperty(event, "dataTransfer", { value: { files, types: ["Files"] } })
      view.contentDOM.dispatchEvent(event)
      return event
    }
    const ignored = drop([file(5, "notes.txt", "text/plain")])
    expect(ignored.defaultPrevented).toBe(true)
    expect(view.state.doc.toString()).toBe("ab")
    drop([file(5, "cat.gif", "image/gif"), file(5, "readme.md", "text/markdown")])
    await vi.waitFor(() => expect(view.state.doc.toString()).toBe("ab![cat](assets/cat.png)"))
    expect(api.assetNames).toEqual(["cat"])
  })
})
