import { history, undo } from "@codemirror/commands"
import { EditorState, type Transaction } from "@codemirror/state"
import { TEXTEDIT_CHUNK_CHARS } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { fakeApi, session, VERSION_A, VERSION_B, VERSION_C, type FakeApi } from "../testing/fakeApi"
import { createDocumentController, type DocumentController } from "./controller"

/** A CodeMirror state without a view: the controller's document host. */
function editorHost(text: string) {
  let state = EditorState.create({ doc: text, extensions: [history()] })
  let controller: DocumentController | null = null
  const dispatch = (tr: Transaction): void => {
    state = tr.state
    if (tr.docChanged) controller?.docChanged(state.doc)
  }
  return {
    host: {
      doc: () => state.doc,
      reset(next: string) {
        state = EditorState.create({ doc: next, extensions: [history()] })
      },
    },
    connect(c: DocumentController) {
      controller = c
    },
    type(insert: string, at = state.doc.length) {
      dispatch(state.update({ changes: { from: at, insert } }))
    },
    remove(from: number, to: number) {
      dispatch(state.update({ changes: { from, to } }))
    },
    undo() {
      undo({ state, dispatch })
    },
    text: () => state.doc.toString(),
  }
}

function setup(text = "hello\nworld", api: FakeApi = fakeApi(), reads: string[] = []) {
  const editor = editorHost(text)
  const controller = createDocumentController({
    api,
    session: api.currentSession,
    readText: vi.fn(async () => reads.shift() ?? "from disk"),
    noticeMs: 10,
  })
  controller.attach(editor.host)
  editor.connect(controller)
  return { api, editor, controller, state: () => controller.store.get() }
}

describe("dirty tracking", () => {
  it("tells main only when the state changes, and is clean again after undo", async () => {
    const { api, editor, state } = setup()
    editor.type("!")
    editor.type("?")
    editor.type("#")
    expect(state().dirty).toBe(true)
    expect(api.dirtyCalls).toEqual([true])
    editor.undo()
    // history groups adjacent typing: one undo takes back all three.
    expect(editor.text()).toBe("hello\nworld")
    expect(state().dirty).toBe(false)
    expect(api.dirtyCalls).toEqual([true, false])
  })

  it("deleting what was typed, without undo, is clean too", () => {
    const { api, editor, state } = setup("abc")
    editor.type("d")
    expect(state().dirty).toBe(true)
    editor.remove(3, 4)
    expect(state().dirty).toBe(false)
    expect(api.dirtyCalls).toEqual([true, false])
  })
})

describe("save", () => {
  it("sends the text in ordered chunks, then commits from the base version", async () => {
    const big = "x".repeat(TEXTEDIT_CHUNK_CHARS + 10)
    const { api, editor, controller, state } = setup(big)
    editor.type("\r\nyz")
    await controller.save()
    expect(api.writes.map((w) => w.seq)).toEqual([0, 1])
    expect(api.writes.map((w) => w.text).join("")).toBe(big + "\nyz")
    expect(api.writes[0]!.text.length).toBe(TEXTEDIT_CHUNK_CHARS)
    expect(api.commits).toEqual([{ baseVersion: VERSION_A, force: false, asUtf8: false }])
    expect(state().dirty).toBe(false)
    expect(state().notice?.text).toBe("Saved")
    expect(controller.baseVersion()).toBe(VERSION_B)
    expect(api.dirtyCalls).toEqual([true, false])
  })

  it("never runs two saves at once", async () => {
    const { api, editor, controller } = setup()
    editor.type("!")
    await Promise.all([controller.save(), controller.save()])
    expect(api.commits).toHaveLength(1)
  })

  it("keeps the document dirty when it was edited during the save", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    api.write = vi.fn(async () => {
      editor.type("more")
      return { ok: true as const, r: { ok: true } }
    })
    await controller.save()
    expect(state().dirty).toBe(true)
  })

  it("asks on a conflict and overwrites by sending the text again with force", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    api.commitAnswers.push({ status: "conflict", gone: false })
    await controller.save()
    expect(state().dialog).toEqual({ kind: "conflict", gone: false })
    expect(state().dirty).toBe(true)
    // Ctrl+S while the question is open does nothing.
    await controller.save()
    expect(api.commits).toHaveLength(1)
    await controller.resolveConflict("overwrite")
    expect(api.commits[1]).toEqual({ baseVersion: VERSION_A, force: true, asUtf8: false })
    expect(api.writes.filter((w) => w.seq === 0)).toHaveLength(2)
    expect(state().dialog).toBeNull()
    expect(state().dirty).toBe(false)
  })

  it("reloads on a conflict: the disk's text and version, the edits gone", async () => {
    const { api, editor, controller, state } = setup("hello", fakeApi(), ["changed elsewhere"])
    editor.type("!")
    api.commitAnswers.push({ status: "conflict", gone: false })
    await controller.save()
    api.disk = { version: VERSION_C, sizeBytes: 17, mtimeNs: 3 }
    api.currentSession = session({ version: VERSION_C, lineEnding: "crlf" })
    await controller.resolveConflict("reload")
    expect(editor.text()).toBe("changed elsewhere")
    expect(state().dirty).toBe(false)
    expect(state().dialog).toBeNull()
    expect(state().lineEnding).toBe("crlf")
    expect(controller.baseVersion()).toBe(VERSION_C)
    expect(api.session).toHaveBeenCalled()
  })

  it("cancelling a conflict keeps the edits", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    api.commitAnswers.push({ status: "conflict", gone: true })
    await controller.save()
    expect(state().dialog).toEqual({ kind: "conflict", gone: true })
    await controller.resolveConflict("cancel")
    expect(state().dialog).toBeNull()
    expect(state().dirty).toBe(true)
    expect(editor.text()).toBe("hello\nworld!")
  })

  it("saves as UTF-8 when the encoding cannot hold a character", async () => {
    const api = fakeApi(session({ encoding: "windows-1252" }))
    const { editor, controller, state } = setup("abc", api)
    editor.type("€ → ✓")
    api.commitAnswers.push({ status: "unencodable", line: 1 })
    await controller.save()
    expect(state().dialog).toEqual({ kind: "unencodable", line: 1 })
    await controller.resolveUnencodable("utf8")
    expect(api.commits[1]).toEqual({ baseVersion: VERSION_A, force: false, asUtf8: true })
    expect(state().encoding).toBe("utf-8")
    expect(state().bom).toBe(0)
    expect(state().dirty).toBe(false)
  })

  it("keeps force after a conflict when the overwrite then needs UTF-8", async () => {
    const { api, editor, controller } = setup()
    editor.type("!")
    api.commitAnswers.push({ status: "conflict", gone: false }, { status: "unencodable", line: 2 })
    await controller.save()
    await controller.resolveConflict("overwrite")
    await controller.resolveUnencodable("utf8")
    expect(api.commits.at(-1)).toEqual({ baseVersion: VERSION_A, force: true, asUtf8: true })
  })

  it("an error keeps the edits and says why", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    api.failWrite = {
      ok: false,
      e: { code: "TEXTEDIT_SESSION_GONE", message: "gone", retryable: false },
    }
    await controller.save()
    expect(state().dirty).toBe(true)
    expect(state().saving).toBe(false)
    expect(state().notice).toMatchObject({ tone: "error" })
    expect(state().notice?.text).toMatch(/session has ended/)
    expect(api.commits).toHaveLength(0)

    api.commitAnswers.push({
      ok: false,
      e: { code: "PERMISSION_DENIED", message: "denied", retryable: false },
    })
    await controller.save()
    expect(state().notice?.text).toMatch(/permission/)
    expect(state().dirty).toBe(true)
  })
})

describe("closing with unsaved changes", () => {
  it("Save saves, then closes", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    await controller.requestClose()
    expect(state().dialog).toEqual({ kind: "close" })
    await controller.resolveClose("save")
    expect(api.commits).toHaveLength(1)
    expect(api.closes).toEqual([false])
  })

  it("Save that meets a conflict closes after the overwrite", async () => {
    const { api, editor, controller } = setup()
    editor.type("!")
    api.commitAnswers.push({ status: "conflict", gone: false })
    await controller.requestClose()
    await controller.resolveClose("save")
    expect(api.closes).toEqual([])
    await controller.resolveConflict("overwrite")
    expect(api.closes).toEqual([false])
  })

  it("Don't save closes discarding; Cancel stays", async () => {
    const { api, editor, controller, state } = setup()
    editor.type("!")
    await controller.requestClose()
    await controller.resolveClose("cancel")
    expect(state().dialog).toBeNull()
    expect(api.closes).toEqual([])
    await controller.requestClose()
    await controller.resolveClose("discard")
    expect(api.closes).toEqual([true])
    expect(api.commits).toHaveLength(0)
  })

  it("closes at once when nothing is unsaved", async () => {
    const { api, controller, state } = setup()
    await controller.requestClose()
    expect(state().dialog).toBeNull()
    expect(api.closes).toEqual([false])
  })
})

describe("the check on focus", () => {
  it("offers Reload when the file changed and nothing is unsaved", async () => {
    const { api, controller, state, editor } = setup("old", fakeApi(), ["new"])
    await controller.checkDisk()
    expect(state().banner).toBeNull()
    api.disk = { version: VERSION_C, sizeBytes: 3, mtimeNs: 9 }
    await controller.checkDisk()
    expect(state().banner).toBe("changed")
    await controller.reload()
    expect(editor.text()).toBe("new")
    expect(state().banner).toBeNull()
    expect(controller.baseVersion()).toBe(VERSION_C)
  })

  it("only notes the change when there are unsaved edits; the save then conflicts", async () => {
    const { api, controller, state, editor } = setup()
    editor.type("!")
    api.disk = { version: VERSION_C, sizeBytes: 3, mtimeNs: 9 }
    await controller.checkDisk()
    expect(state().banner).toBeNull()
    expect(state().diskChanged).toBe(true)
  })

  it("says when the file is gone", async () => {
    const { api, controller, state } = setup()
    api.disk = null
    await controller.checkDisk()
    expect(state().banner).toBe("gone")
  })
})
