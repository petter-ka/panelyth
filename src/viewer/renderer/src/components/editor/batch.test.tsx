// Batch mode of the image editor (Stage 16, ADR-0036): the editor on a
// selection. The list is a recipe, the picture a sample; Go plans and runs.
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { AppShell } from "../../app/AppShell"
import { useNoticeStore } from "../../features/clipboard/clipboard"
import {
  currentRecipe,
  openBatchEditor,
  PLAN_DELAY_MS,
  resetBatchStore,
  runBlocker,
  useBatchStore,
} from "../../features/editor/batchStore"
import batchStoreSource from "../../features/editor/batchStore.ts?raw"
import { DEFAULT_EDITOR_SETTINGS, useEditorSettings } from "../../features/editor/editorSettings"
import {
  openTool,
  resetEditor,
  startEditor,
  toEditList,
  useEditorStore,
} from "../../features/editor/editorStore"
import { toolDef, type ToolId } from "../../features/editor/tools"
import {
  openFolder,
  resetFolderStore,
  startFolderMonitoring,
} from "../../features/folder/folderStore"
import { resetJobsStore, startJobMonitoring } from "../../features/jobs/jobsStore"
import { resetThumbs, startThumbMonitoring } from "../../features/previews/thumbStore"
import { resetShortcutStore } from "../../features/shortcuts/shortcutStore"
import { startSidecarMonitoring, useSidecarStore } from "../../features/system/sidecarStore"
import { resetLayoutStore } from "../../features/tiles/layoutStore"
import { resetSelection, selectAll, selectIndexRanges } from "../../features/tiles/selectionStore"
import { resetViewerImages, startViewerImageMonitoring } from "../../features/viewer/viewerImages"
import { resetViewer } from "../../features/viewer/viewerStore"
import { installFakeBridge, makeItems } from "../../test/fakeBridge"
import { mockViewport } from "../../test/viewport"

let stop: (() => void)[] = []

/** 2 folders, then 10 pictures (ids are index + 1), all selected; the batch editor opens on IMG_2 (id 3). */
async function setup(openIt = true, items = makeItems(12, 2)) {
  const bridge = installFakeBridge()
  bridge.backend.items = items
  stop = [
    startSidecarMonitoring(),
    startFolderMonitoring(),
    startThumbMonitoring(),
    startViewerImageMonitoring(),
    startJobMonitoring(),
    startEditor(),
  ]
  render(<AppShell />)
  await act(() => openFolder("/photos"))
  act(() => selectAll(items.length))
  if (openIt) await act(() => openBatchEditor())
  return bridge
}

type Bridge = Awaited<ReturnType<typeof setup>>
const editor = () => screen.getByTestId("editor")
const state = () => useEditorStore.getState()
const batch = () => useBatchStore.getState()
const click = (el: HTMLElement) => act(async () => void fireEvent.click(el))
const key = (el: HTMLElement, k: string, init: KeyboardEventInit = {}) =>
  act(async () => void fireEvent.keyDown(el, { key: k, ...init }))
const tool = (id: string) => editor().querySelector<HTMLButtonElement>(`button[data-tool="${id}"]`)!
const group = (id: string) =>
  editor().querySelector<HTMLButtonElement>(`button[data-group="${id}"]`)!
const pick = async (id: ToolId) => {
  await click(group(toolDef(id).group))
  if (tool(id).getAttribute("aria-expanded") !== "true") await click(tool(id))
}
const lastPlan = (bridge: Bridge) => bridge.backend.batch.plans.at(-1)!
/** The plan asked for after the recipe or the output rested. */
const planned = (bridge: Bridge, calls: number) =>
  waitFor(() => expect(bridge.backend.batch.plans.length).toBe(calls), {
    timeout: PLAN_DELAY_MS + 1500,
  })

beforeEach(() => {
  mockViewport(1400, 900)
  localStorage.clear()
  resetLayoutStore()
  resetFolderStore()
  resetSelection()
  resetThumbs()
  resetViewer()
  resetViewerImages()
  resetEditor()
  resetBatchStore()
  resetJobsStore()
  resetShortcutStore()
  useNoticeStore.setState({ notice: null })
  useEditorSettings.setState({ settings: DEFAULT_EDITOR_SETTINGS })
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
})
afterEach(() => {
  stop.forEach((s) => s())
  resetEditor()
  resetBatchStore()
})

describe("opening the batch editor", () => {
  it("opens from the batch bar on the pictures of the selection", async () => {
    const bridge = await setup(false)
    await click(within(screen.getByTestId("batch-bar")).getByRole("button", { name: "Edit…" }))
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(editor().dataset.batch).toBe("true")
    expect(editor()).toHaveAccessibleName("Batch editor: 10 pictures")
    expect(screen.getByTestId("batch-title")).toHaveTextContent("Edit 10 pictures")
    // One call planned the whole selection: a descriptor, never a list of ids.
    expect(bridge.backend.batch.plans).toHaveLength(1)
    expect(lastPlan(bridge).source.selection).toMatchObject({ ranges: [[0, 12]], include: [] })
    expect(lastPlan(bridge).recipe).toEqual({
      version: 1,
      ops: [],
      output: {
        format: "keep",
        quality: 92,
        metadata: "keep",
        destination: "beside",
        conflict: "keepBoth",
      },
    })
    // The editor is on the first sample; the others wait in the strip.
    expect(bridge.api.edit.open).toHaveBeenCalledWith(3)
    const samples = within(screen.getByTestId("batch-strip")).getAllByRole("option")
    expect(samples).toHaveLength(10)
    expect(samples[0]).toHaveAttribute("aria-selected", "true")
    expect(screen.getAllByTestId("batch-summary")[0]).toHaveTextContent(
      "10 pictures· 2 skipped· about 1.4 MB· next to the originals",
    )
    // One call asked for the strip's thumbnails.
    expect(bridge.api.preview.ensure).toHaveBeenCalledWith(
      expect.objectContaining({ lane: "batch", items: expect.any(Array) }),
    )
    // Nothing is saved from here: Run stands where Save was.
    expect(screen.queryByTestId("save-controls")).toBeNull()
    expect(screen.getByTestId("batch-run")).toHaveTextContent("Run on 10 pictures")
    expect(screen.queryByTestId("editor-unsaved")).toBeNull()
  })

  it("opens from the tile menu's key: several pictures the batch editor, one the editor", async () => {
    const bridge = await setup(false)
    await key(document.body, "e", { ctrlKey: true })
    await waitFor(() => expect(editor().dataset.batch).toBe("true"))
    await act(async () => resetEditor())
    expect(batch().open).toBe(false)
    // One picture under the focus: the single editor.
    act(() => selectIndexRanges([[4, 5]], { anchorIndex: 4, focusIndex: 4, focusId: 5 }))
    await key(document.body, "e", { ctrlKey: true })
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(editor().dataset.batch).toBeUndefined()
    expect(bridge.api.edit.open).toHaveBeenLastCalledWith(5)
    expect(screen.getByTestId("save-controls")).toBeInTheDocument()
  })

  it("opens nothing when the selection holds no picture, and says so", async () => {
    const bridge = await setup(true, makeItems(3, 3))
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(batch().open).toBe(false)
    expect(bridge.api.edit.open).not.toHaveBeenCalled()
    expect(useNoticeStore.getState().notice?.text).toBe(
      "None of the selected items is a picture that can be edited.",
    )
  })
})

describe("the recipe", () => {
  it("leaves the free-hand tools out and says why", async () => {
    await setup()
    await click(group("retouch"))
    for (const id of ["draw", "clone", "heal", "redeye"]) {
      expect(tool(id)).toBeDisabled()
      expect(tool(id)).toHaveAccessibleDescription(
        "One picture at a time: this tool needs a place in the picture.",
      )
    }
    expect(screen.getAllByTestId("tool-single-only")).toHaveLength(4)
    // Neither the store nor the search lets one in.
    act(() => openTool("draw"))
    expect(state().tool).toBeNull()
    await click(screen.getByRole("button", { name: "Find a tool" }))
    const search = within(screen.getByTestId("tool-search"))
    fireEvent.change(search.getByRole("searchbox"), { target: { value: "heal" } })
    expect(search.getByText("No tool matches")).toBeVisible()
    fireEvent.change(search.getByRole("searchbox"), { target: { value: "crop" } })
    expect(search.getByText("Crop")).toBeVisible()
    // The other groups work as in the editor.
    await key(search.getByRole("searchbox"), "Escape")
    await pick("grayscale")
    expect(toEditList(state().items)).toEqual([{ op: "grayscale", p: expect.any(Object) }])
  })

  it("stays, with its history, when another sample is shown", async () => {
    const bridge = await setup()
    await pick("grayscale")
    await pick("negative")
    const items = state().items
    const samples = within(screen.getByTestId("batch-strip")).getAllByRole("option")
    await click(samples[3]!)
    await waitFor(() => expect(state().entry?.id).toBe(6))
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(bridge.api.edit.open).toHaveBeenLastCalledWith(6)
    // The session of the sample before is closed: one picture is open at a time.
    expect(bridge.backend.edit.closed).toHaveLength(1)
    expect(state().items).toBe(items)
    expect(state().past.length).toBe(2)
    expect(samples[3]).toHaveAttribute("aria-selected", "true")
    // The new sample is rendered with the same recipe.
    await waitFor(() =>
      expect(bridge.backend.edit.renders.at(-1)!.editList.map((op) => op.op)).toEqual([
        "grayscale",
        "negative",
      ]),
    )
    // The arrow keys walk the strip.
    await key(samples[3]!, "ArrowRight")
    await waitFor(() => expect(state().entry?.id).toBe(7))
    // The focus walks with the selection; a quick step back wins over the open that was under way.
    expect(samples[4]).toHaveFocus()
    await key(samples[4]!, "ArrowLeft")
    await waitFor(() => expect(state().entry?.id).toBe(6))
    await waitFor(() => expect(editor().dataset.status).toBe("ready"))
    expect(state().session).not.toBeNull()
  })

  it("is planned again once it rests, in one call", async () => {
    const bridge = await setup()
    await pick("grayscale")
    await pick("sepia")
    await planned(bridge, 2)
    expect(lastPlan(bridge).recipe.ops.map((op) => op.op)).toEqual(["grayscale", "sepia"])
    expect(currentRecipe().ops).toHaveLength(2)
  })

  it("is a built-in or saved one on request: one undo step", async () => {
    const bridge = await setup()
    await pick("negative")
    await click(screen.getByRole("button", { name: "Recipes…" }))
    const dialog = await screen.findByTestId("batch-recipes")
    const web = within(dialog).getByTestId("recipe")
    expect(web).toHaveTextContent("Web, 1600 px")
    expect(web).toHaveTextContent("built in")
    await click(within(web).getByRole("button", { name: "Use Web, 1600 px" }))
    expect(toEditList(state().items).map((op) => op.op)).toEqual(["resize", "sharpen"])
    expect(batch().output).toMatchObject({ format: "jpeg", quality: 85, template: "{name}-web" })
    expect(screen.queryByTestId("batch-recipes")).toBeNull()
    await key(editor(), "z", { ctrlKey: true })
    expect(toEditList(state().items).map((op) => op.op)).toEqual(["negative"])

    // Saving the current recipe: the steps and the output, never a folder.
    await key(editor(), "s", { ctrlKey: true })
    const again = await screen.findByTestId("batch-recipes")
    fireEvent.change(within(again).getByTestId("recipe-name"), { target: { value: " Inverted " } })
    await click(within(again).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(within(again).getByTestId("recipe-saved")).toBeVisible())
    expect(bridge.api.recipes.save).toHaveBeenCalledWith({
      id: 0,
      name: "Inverted",
      recipe: {
        version: 1,
        ops: [{ op: "negative", p: expect.any(Object) }],
        output: expect.objectContaining({ format: "jpeg", template: "{name}-web" }),
      },
    })
    expect(JSON.stringify(bridge.api.recipes.save.mock.calls[0])).not.toContain("folder")
    const mine = within(again)
      .getAllByTestId("recipe")
      .find((r) => r.dataset.recipe === "1")!
    expect(mine).toHaveTextContent("Inverted")
    expect(mine).toHaveTextContent("1 step")
    await click(within(mine).getByRole("button", { name: "Delete Inverted" }))
    await waitFor(() => expect(within(again).getAllByTestId("recipe")).toHaveLength(1))
    expect(bridge.api.recipes.remove).toHaveBeenCalledWith(1)
  })
})

describe("the output", () => {
  it("previews the names the template gives", async () => {
    const bridge = await setup()
    await click(screen.getByTestId("batch-output-open"))
    const dialog = await screen.findByTestId("batch-output")
    expect(within(dialog).getByTestId("batch-names")).toHaveTextContent("IMG_2-edited.jpg")
    fireEvent.change(within(dialog).getByTestId("batch-template"), {
      target: { value: "{n:3}-{name}" },
    })
    await planned(bridge, 2)
    expect(lastPlan(bridge).recipe.output.template).toBe("{n:3}-{name}")
    await waitFor(() =>
      expect(within(dialog).getByTestId("batch-names")).toHaveTextContent("001-IMG_2.jpg"),
    )
    // A token chip adds its token.
    await click(within(dialog).getByRole("button", { name: "Year" }))
    expect(batch().output.template).toBe("{n:3}-{name}{year}")
  })

  it("takes a folder from main's dialog as a handle, never a path", async () => {
    const bridge = await setup()
    await click(screen.getByTestId("batch-output-open"))
    const dialog = await screen.findByTestId("batch-output")
    await click(within(dialog).getByRole("radio", { name: /In one folder/ }))
    await waitFor(() =>
      expect(within(dialog).getByTestId("batch-folder")).toHaveTextContent("Web export"),
    )
    expect(bridge.api.batch.pickFolder).toHaveBeenCalledTimes(1)
    await planned(bridge, 2)
    expect(lastPlan(bridge)).toMatchObject({
      folderId: "0123456789abcdef",
      recipe: { output: { destination: "folder" } },
    })
    expect(screen.getAllByTestId("batch-summary")[0]).toHaveTextContent("into “Web export”")
    await click(within(dialog).getByTestId("batch-run-dialog"))
    await waitFor(() => expect(bridge.backend.batch.starts).toHaveLength(1))
    expect(bridge.backend.batch.starts[0]).toMatchObject({ folderId: "0123456789abcdef" })
    expect(JSON.stringify(bridge.backend.batch.starts[0])).not.toMatch(/[A-Za-z]:\\|\/photos/)
  })

  it("does not run into a folder that was not chosen", async () => {
    const bridge = await setup()
    bridge.backend.batch.folder = null // the dialog is cancelled
    await click(screen.getByTestId("batch-output-open"))
    const dialog = await screen.findByTestId("batch-output")
    await click(within(dialog).getByRole("radio", { name: /In one folder/ }))
    await planned(bridge, 2)
    expect(runBlocker(batch())).toBe("Choose a folder for the results.")
    expect(within(dialog).getByTestId("batch-run-dialog")).toBeDisabled()
    expect(lastPlan(bridge).folderId).toBeUndefined()
  })

  it("asks before the originals are replaced, and sends what a replace uses", async () => {
    const bridge = await setup()
    await click(screen.getByTestId("batch-output-open"))
    const dialog = await screen.findByTestId("batch-output")
    fireEvent.change(within(dialog).getByTestId("batch-template"), { target: { value: "x" } })
    await click(within(dialog).getByRole("radio", { name: /Replace the originals/ }))
    // A replaced original keeps its name and its format.
    expect(within(dialog).queryByTestId("batch-template")).toBeNull()
    await click(within(dialog).getByTestId("batch-run-dialog"))
    const confirm = await screen.findByTestId("batch-confirm-replace")
    expect(screen.getByRole("dialog", { name: "Replace 10 pictures?" })).toBeVisible()
    await click(within(confirm).getByRole("button", { name: "Cancel" }))
    expect(bridge.backend.batch.starts).toHaveLength(0)
    expect(editor()).toBeInTheDocument()

    await click(screen.getByTestId("batch-run"))
    await click(
      within(await screen.findByTestId("batch-confirm-replace")).getByRole("button", {
        name: "Replace the originals",
      }),
    )
    await waitFor(() => expect(bridge.backend.batch.starts).toHaveLength(1))
    expect(bridge.backend.batch.starts[0]!.recipe.output).toEqual({
      format: "keep",
      quality: 92,
      metadata: "keep",
      destination: "replace",
      conflict: "keepBoth",
    })
  })

  it("shows what Go warns of and why a recipe cannot run", async () => {
    const bridge = await setup(false)
    bridge.backend.batch.plan = {
      warnings: ["formatChange", "alphaLoss"],
      problems: [{ code: "missingAsset", op: "watermark", detail: "" }],
      skipped: [
        { reason: "folder", count: 2 },
        { reason: "video", count: 1 },
      ],
    }
    await act(() => openBatchEditor())
    // Run does not start; it shows the reason where it can be fixed.
    await click(screen.getByTestId("batch-run"))
    const dialog = await screen.findByTestId("batch-output")
    expect(bridge.backend.batch.starts).toHaveLength(0)
    expect(within(dialog).getByTestId("batch-problem")).toHaveTextContent(
      "Watermark: choose its picture again.",
    )
    expect(
      within(dialog)
        .getAllByTestId("batch-warning")
        .map((w) => w.textContent),
    ).toEqual([
      "WebP can't be written: those pictures are saved as PNG.",
      "JPEG has no transparency: transparent areas become white.",
    ])
    expect(within(dialog).getByTestId("batch-run-dialog")).toBeDisabled()
    expect(within(dialog).getByTestId("batch-summary")).toHaveTextContent("3 skipped")
  })
})

describe("running", () => {
  it("starts one job, closes the editor and offers to show and undo it", async () => {
    const bridge = await setup()
    await pick("grayscale")
    // Ctrl+Enter runs; the plan that was still waiting is asked for first.
    await key(editor(), "Enter", { ctrlKey: true })
    await waitFor(() => expect(bridge.backend.batch.starts).toHaveLength(1))
    expect(bridge.api.batch.start).toHaveBeenCalledTimes(1)
    expect(bridge.backend.batch.starts[0]).toMatchObject({
      source: { selection: { ranges: [[0, 12]] } },
      recipe: { version: 1, ops: [{ op: "grayscale" }], output: { destination: "beside" } },
    })
    expect(bridge.backend.batch.plans.length).toBeGreaterThanOrEqual(2)
    await waitFor(() => expect(screen.queryByTestId("editor")).toBeNull())
    expect(batch().open).toBe(false)
    expect(useNoticeStore.getState().notice?.text).toBe("Editing 10 pictures in the background.")

    const panel = screen.getByTestId("jobs-panel")
    expect(within(panel).getByText("Editing 10 pictures")).toBeVisible()
    expect(within(panel).queryByTestId("job-undo-batch")).toBeNull()
    const jobId = bridge.backend.nextJob - 1
    act(() => bridge.job(jobId, "completed", { kind: "edit", total: 12, done: 10, skipped: 2 }))
    await click(within(panel).getByRole("button", { name: "Show in folder" }))
    expect(bridge.api.edit.reveal).toHaveBeenCalledWith(jobId)
    await click(within(panel).getByTestId("job-undo-batch"))
    expect(bridge.api.batch.undo).toHaveBeenCalledWith(jobId)
    // A batch is undone once; the undo is a job of its own.
    await waitFor(() => expect(within(panel).queryByTestId("job-undo-batch")).toBeNull())
    expect(within(panel).getByText("Removing 3 edited pictures")).toBeVisible()
  })

  it("stays open and says why when the job cannot start", async () => {
    const bridge = await setup()
    bridge.backend.batch.startError = "the recipe cannot run"
    await click(screen.getByTestId("batch-run"))
    const dialog = await screen.findByTestId("batch-output")
    expect(within(dialog).getByText("the recipe cannot run")).toBeVisible()
    expect(editor()).toBeInTheDocument()
    expect(batch().starting).toBe(false)
  })
})

describe("closing", () => {
  it("closes at once without a recipe, and asks when one was built", async () => {
    await setup()
    await key(editor(), "Escape")
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(batch().open).toBe(false)

    await act(() => openBatchEditor())
    await pick("negative")
    await key(editor(), "Escape")
    const prompt = await screen.findByTestId("batch-close-prompt")
    expect(screen.getByRole("dialog", { name: "Close without running?" })).toBeVisible()
    expect(within(prompt).getByRole("button", { name: "Keep editing" })).toHaveFocus()
    await click(within(prompt).getByRole("button", { name: "Keep editing" }))
    expect(editor()).toBeInTheDocument()
    expect(state().items).toHaveLength(1)

    await click(screen.getByTestId("editor-close"))
    await click(
      within(await screen.findByTestId("batch-close-prompt")).getByRole("button", {
        name: "Close",
      }),
    )
    expect(screen.queryByTestId("editor")).toBeNull()
    expect(batch().open).toBe(false)
    expect(batch().plan).toBeNull()
  })
})

describe("the batch store", () => {
  it("never fans out over the selection", () => {
    // One plan call and one start call for any number of pictures (CLAUDE.md).
    expect(batchStoreSource).not.toMatch(/Promise\.all/)
    expect(batchStoreSource).not.toMatch(/include:\s*\[/)
  })
})
