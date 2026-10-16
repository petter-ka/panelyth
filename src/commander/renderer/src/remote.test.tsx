import type { Crumb, SavedConnection } from "@panelyth/contracts"
import { useInterfaceSizeStore } from "@panelyth/ui"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetBridgeCache } from "./bridge"
import { AppShell } from "./components/AppShell"
import { fingerprintText } from "./components/ConnectionsDialog"
import { resetCarry, startPanels } from "./features/carry"
import { resetDrives } from "./features/drives"
import { resetFiles } from "./features/files"
import { resetHotlist } from "./features/hotlist"
import { resetKeymap } from "./features/keymap"
import { flushPersist, resetListing, TAB_GRACE_MS, useListingStore } from "./features/listing"
import { resetMarks } from "./features/marks"
import { resetOpen, startOpen } from "./features/open"
import { usePanelsStore } from "./features/panels"
import { resetQueue, startQueue } from "./features/queue"
import { resetRemote, startRemote, useRemoteStore } from "./features/remote"
import { PANELS_KEY, readStoredPanels } from "./features/session"
import { resetSettings } from "./features/settings"
import { resetTabs, useTabsStore } from "./features/tabs"
import { resetViewers } from "./features/viewers"
import {
  folder,
  installFakeCommander,
  item,
  type FakeOptions,
  type FakeServer,
} from "./test/fakeApi"
import { mockViewport } from "./test/viewport"

// Stage C10.5: connections to FTP servers in the panels (CFR-31, ADR-0037;
// docs/commander/stages/C10.5-tabs-tree-ftp-compare.md, scenario 21).

const ROOT: Crumb = { name: "C:\\", path: "C:\\" }
const SRC: Crumb = { name: "src", path: "C:\\src" }
const DST: Crumb = { name: "Backup", path: "C:\\Backup" }

const folders = () => [
  folder(10, SRC.path, [ROOT, SRC], 1, 3),
  folder(20, DST.path, [ROOT, DST], 0, 2),
]

const PASSWORD = "correct horse battery staple"
const PRINT = "ab".repeat(32)
const BASE = 7 * 2 ** 50
const PUB = BASE + 1
const README = BASE + 2
const PHOTO = BASE + 3
const NOTES = BASE + 4

const server = (over: Partial<FakeServer> = {}): FakeServer => ({
  host: "ftp.example.org",
  folders: {
    "/": [item(PUB, "pub", { kind: "dir" }), item(README, "readme.txt", { sizeBytes: 120 })],
    "/pub": [
      item(PHOTO, "photo.jpg", { sizeBytes: 4096 }),
      item(NOTES, "notes.txt", { sizeBytes: 12 }),
    ],
  },
  ...over,
})

const saved = (over: Partial<SavedConnection> = {}): SavedConnection => ({
  id: 1,
  name: "Work",
  group: "",
  host: "ftp.example.org",
  port: 21,
  tls: "explicit",
  user: "alice",
  startPath: "",
  localPath: "",
  active: false,
  encoding: "",
  transfers: 2,
  fingerprint: "",
  hasPassword: false,
  ...over,
})

let stops: (() => void)[] = []

async function start(options: Partial<FakeOptions> = {}) {
  const fake = installFakeCommander({
    folders: folders(),
    home: SRC.path,
    servers: [server()],
    connections: [saved()],
    settings: {
      [PANELS_KEY]: {
        v: 3,
        active: "left",
        left: { tabs: [{ path: SRC.path }] },
        right: { tabs: [{ path: DST.path }] },
      },
    },
    ...options,
  })
  render(<AppShell />)
  await act(async () => {
    stops.push(startQueue(), startRemote(), startOpen())
    stops.push(await startPanels())
  })
  await waitFor(() => expect(path("left")).toHaveTextContent(SRC.path))
  await waitFor(() => expect(path("right")).toHaveTextContent(DST.path))
  return fake
}

type Side = "left" | "right"
const grid = (side: Side) => screen.getByTestId(`grid-${side}`)
const path = (side: Side) => screen.getByTestId(`path-${side}`)
const key = (side: Side, init: KeyboardEventInit & { key: string }) =>
  act(async () => {
    fireEvent.keyDown(grid(side), init)
  })
const click = (el: HTMLElement) =>
  act(async () => {
    fireEvent.click(el)
  })
const rowOf = (side: Side, id: number) => grid(side).querySelector<HTMLElement>(`[data-id="${id}"]`)
const cursorId = (side: Side) =>
  Number(grid(side).querySelector<HTMLElement>("[data-cursor=true]")?.dataset.id)
async function cursorOn(side: Side, id: number) {
  await waitFor(() => expect(rowOf(side, id)).not.toBeNull())
  await act(async () => {
    fireEvent.mouseDown(rowOf(side, id)!, { button: 0 })
  })
}
const panel = (side: Side) => useListingStore.getState()[side]
const notice = () => screen.getByTestId("files-notice")

/** Ctrl+Shift+N, Enter: the first saved connection, connected in a panel. */
async function connectSaved(side: Side = "left") {
  await key(side, { key: "N", ctrlKey: true, shiftKey: true })
  const list = await screen.findByRole("listbox", { name: "Saved connections" })
  await waitFor(() => expect(within(list).getAllByRole("option").length).toBeGreaterThan(0))
  await act(async () => {
    fireEvent.keyDown(list, { key: "Enter" })
  })
}
async function connected(side: Side = "left") {
  await connectSaved(side)
  await waitFor(() => expect(path(side)).toHaveTextContent("ftp://alice@ftp.example.org/"))
  await waitFor(() => expect(rowOf(side, README)).not.toBeNull())
}

beforeEach(() => {
  mockViewport(800, 600)
  resetListing()
  resetCarry()
  resetBridgeCache()
  resetTabs()
  resetDrives()
  resetHotlist()
  resetSettings()
  resetKeymap()
  resetMarks()
  resetFiles()
  resetQueue()
  resetRemote()
  resetOpen()
  resetViewers()
  usePanelsStore.setState({ active: "left", split: 50, layoutToken: 0 })
  useInterfaceSizeStore.setState({ size: "medium" })
})
afterEach(() => {
  stops.forEach((s) => s())
  stops = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe("connecting", () => {
  it("connects to nothing until asked; Ctrl+Shift+N, Enter shows the server in the panel", async () => {
    const fake = await start()
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
    // Not even the list of connections is read before it is wanted.
    expect(fake.api.remote.connections).not.toHaveBeenCalled()

    await connected()
    expect(fake.api.remote.connect).toHaveBeenCalledTimes(1)
    expect(fake.api.remote.connect).toHaveBeenCalledWith({ connectionId: 1, attempt: 1 })
    expect(screen.queryByTestId("connections-dialog")).toBeNull()
    // The path bar says where, and that the connection is encrypted.
    expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/")
    expect(screen.getByTestId("remote-left")).toHaveAttribute("data-encrypted", "true")
    expect(screen.getByTestId("tab-left-0")).toHaveTextContent("Work")
    // The rows are a session over the folder's listing: one remote.open, one query.open.
    expect(fake.api.remote.open).toHaveBeenCalledTimes(1)
    expect(fake.lastDescriptor()).toMatchObject({ dirId: 10, remoteId: 1, scope: "all" })
    expect(rowOf("left", PUB)).not.toBeNull()
    // The other panel is untouched.
    expect(path("right")).toHaveTextContent(DST.path)
  })

  it('moves through the server\'s folders; ".." at its root shows this computer again and closes the connection', async () => {
    const fake = await start()
    await connected()
    await cursorOn("left", PUB)
    await key("left", { key: "Enter" })
    await waitFor(() => expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/pub"))
    // By the folder's id, never by a path the renderer made up.
    expect(fake.api.remote.open).toHaveBeenLastCalledWith(1, PUB, expect.any(Number))
    await waitFor(() => expect(rowOf("left", PHOTO)).not.toBeNull())

    await key("left", { key: "Backspace" })
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    // The cursor is on the folder just left.
    await waitFor(() => expect(cursorId("left")).toBe(PUB))

    await key("left", { key: "Backspace" })
    await waitFor(() => expect(path("left")).toHaveTextContent(SRC.path))
    expect(panel("left").remote).toBeNull()
    await waitFor(() => expect(fake.api.remote.disconnect).toHaveBeenCalledWith(1))
    expect(fake.openConnections()).toEqual([])
  })

  it("types a folder of the server into the path bar; a drive path leaves the connection", async () => {
    const fake = await start()
    await connected()
    await click(path("left"))
    const field = screen.getByLabelText("Path")
    expect(field).toHaveValue("/")
    fireEvent.change(field, { target: { value: "/pub" } })
    await act(async () => {
      fireEvent.keyDown(field, { key: "Enter" })
    })
    await waitFor(() => expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/pub"))

    // A folder that is not there is said in the field; the panel stays.
    await click(path("left"))
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: "/nowhere" } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Path"), { key: "Enter" })
    })
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "There is no such file or folder on the server.",
    )
    expect(panel("left").remote?.path).toBe("/pub")

    fireEvent.change(screen.getByLabelText("Path"), { target: { value: DST.path } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Path"), { key: "Enter" })
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(DST.path))
    await waitFor(() => expect(fake.openConnections()).toEqual([]))
  })

  it("asks for a password that is not stored, says when it was refused, and stores it only when told to", async () => {
    const fake = await start({ servers: [server({ password: PASSWORD })] })
    await connectSaved()
    const prompt = await screen.findByTestId("password-prompt")
    expect(prompt).not.toHaveTextContent("refused")
    fireEvent.change(within(prompt).getByLabelText("Password"), { target: { value: "wrong" } })
    await act(async () => {
      fireEvent.submit(prompt)
    })
    const again = await screen.findByTestId("password-prompt")
    await waitFor(() =>
      expect(again).toHaveTextContent("The server refused the user name or the password."),
    )
    // A new field each time: the refused password is not kept on screen.
    expect(within(again).getByLabelText("Password")).toHaveValue("")
    fireEvent.change(within(again).getByLabelText("Password"), { target: { value: PASSWORD } })
    await click(within(again).getByRole("checkbox"))
    await act(async () => {
      fireEvent.submit(again)
    })
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    expect(fake.api.remote.connect).toHaveBeenLastCalledWith({
      connectionId: 1,
      attempt: 3,
      password: PASSWORD,
    })
    await waitFor(() => expect(fake.storedPassword(1)).toBe(PASSWORD))
    await waitFor(() => expect(fake.connections()[0]!.hasPassword).toBe(true))
    // The password is in no store of the app and in no setting.
    expect(JSON.stringify(useRemoteStore.getState())).not.toContain(PASSWORD)
    expect(JSON.stringify(useListingStore.getState())).not.toContain(PASSWORD)
    act(() => flushPersist())
    expect(JSON.stringify(fake.settings)).not.toContain(PASSWORD)
  })

  it("uses the stored password without showing or asking for it", async () => {
    const fake = await start({
      servers: [server({ password: PASSWORD })],
      connections: [saved({ hasPassword: true })],
      passwords: { 1: PASSWORD },
    })
    await connected()
    expect(screen.queryByTestId("password-prompt")).toBeNull()
    // The renderer sent no password: main put the stored one in.
    expect(fake.api.remote.connect).toHaveBeenCalledWith({ connectionId: 1, attempt: 1 })
  })

  it("shows a certificate it can't verify with its fingerprint; trusting once remembers nothing", async () => {
    const fake = await start({
      servers: [server({ fingerprint: PRINT, subject: "CN=ftp.example.org" })],
    })
    await connectSaved()
    const prompt = await screen.findByTestId("certificate-prompt")
    expect(screen.getByRole("dialog", { name: /can't be verified/ })).toBeInTheDocument()
    expect(within(prompt).getByTestId("fingerprint")).toHaveTextContent(fingerprintText(PRINT))
    expect(prompt).toHaveTextContent("CN=ftp.example.org")
    // Nothing was listed before the user decided.
    expect(fake.api.remote.open).not.toHaveBeenCalled()
    await click(within(prompt).getByRole("button", { name: "Trust this time" }))
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    expect(fake.api.remote.connect).toHaveBeenLastCalledWith({
      connectionId: 1,
      attempt: 2,
      accept: PRINT,
    })
    expect(fake.api.remote.trust).not.toHaveBeenCalled()
    expect(fake.connections()[0]!.fingerprint).toBe("")
  })

  it("remembers a certificate when asked, and warns when it later changes", async () => {
    const fake = await start({ servers: [server({ fingerprint: PRINT })] })
    await connectSaved()
    const prompt = await screen.findByTestId("certificate-prompt")
    await click(within(prompt).getByRole("button", { name: "Always trust this certificate" }))
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    await waitFor(() => expect(fake.api.remote.trust).toHaveBeenCalledWith(1, PRINT))
    await waitFor(() => expect(fake.connections()[0]!.fingerprint).toBe(PRINT))
  })

  it("says so when the certificate is not the one accepted before; Cancel connects to nothing", async () => {
    const fake = await start({
      servers: [server({ fingerprint: "cd".repeat(32) })],
      connections: [saved({ fingerprint: PRINT })],
    })
    await connectSaved()
    const prompt = await screen.findByTestId("certificate-prompt")
    expect(screen.getByRole("dialog", { name: /has changed/ })).toBeInTheDocument()
    expect(prompt).toHaveTextContent("Someone may be listening in")
    await click(within(prompt).getByRole("button", { name: "Cancel" }))
    expect(screen.queryByTestId("certificate-prompt")).toBeNull()
    expect(fake.api.remote.connect).toHaveBeenCalledTimes(1)
    expect(fake.openConnections()).toEqual([])
    expect(path("left")).toHaveTextContent(SRC.path)
  })

  it("never goes on without TLS when the connection asks for it", async () => {
    const fake = await start({ servers: [server({ tls: false })] })
    await connectSaved()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The server does not offer encryption (TLS).",
    )
    // One attempt: no second one without encryption.
    expect(fake.api.remote.connect).toHaveBeenCalledTimes(1)
    expect(fake.openConnections()).toEqual([])
    expect(panel("left").remote).toBeNull()
  })

  it("quick connect (Ctrl+N) warns about plain FTP and marks the panel as not encrypted", async () => {
    const fake = await start({ servers: [server({ host: "10.0.0.7", port: 2121, tls: false })] })
    await key("left", { key: "n", ctrlKey: true })
    const form = await screen.findByTestId("quick-connect")
    fireEvent.change(within(form).getByLabelText("Server"), { target: { value: "10.0.0.7" } })
    fireEvent.change(within(form).getByLabelText("Port"), { target: { value: "2121" } })
    expect(form).not.toHaveTextContent("Not encrypted")
    fireEvent.change(within(form).getByLabelText("Encryption"), { target: { value: "none" } })
    expect(within(form).getByRole("note")).toHaveTextContent(
      "Not encrypted: the password and the files can be read on the way.",
    )
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: PASSWORD } })
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() => expect(path("left")).toHaveTextContent("ftp://10.0.0.7:2121/"))
    expect(fake.api.remote.connect).toHaveBeenCalledWith({
      quick: {
        host: "10.0.0.7",
        port: 2121,
        tls: "none",
        user: "",
        active: false,
        encoding: "",
        transfers: 2,
      },
      attempt: 1,
      password: PASSWORD,
    })
    expect(screen.getByTestId("remote-left")).toHaveAttribute("data-encrypted", "false")
    expect(screen.getByTestId("remote-left")).toHaveTextContent("Not encrypted")
    // Nothing of a quick connection is saved.
    expect(fake.api.remote.save).not.toHaveBeenCalled()
    expect(fake.connections()).toHaveLength(1)
  })

  it("Cancel stops a connect that takes long; a connection it still made is closed", async () => {
    let answer!: () => void
    const delay = new Promise<void>((resolve) => (answer = resolve))
    const fake = await start({ servers: [server({ delay })] })
    await connectSaved()
    const waiting = await screen.findByTestId("connecting")
    await click(within(waiting).getByRole("button", { name: "Cancel" }))
    expect(fake.api.remote.cancel).toHaveBeenCalledWith(1)
    expect(screen.queryByTestId("connecting")).toBeNull()
    await act(async () => {
      answer()
      await delay
    })
    expect(panel("left").remote).toBeNull()
    expect(fake.api.remote.open).not.toHaveBeenCalled()
    expect(fake.openConnections()).toEqual([])
  })

  it("a server that stops answering can be stopped, and the other panel goes on working", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start({ servers: [server({ stall: true })] })
    await connectSaved()
    await waitFor(() => expect(fake.api.remote.open).toHaveBeenCalledTimes(1))
    // The panel keeps its folder; after a moment it says what it waits for.
    expect(path("left")).toHaveTextContent(SRC.path)
    await act(async () => {
      vi.advanceTimersByTime(500)
    })
    const waiting = await screen.findByTestId("remote-busy-left")
    expect(waiting).toHaveTextContent("Waiting for the server…")
    // The other panel is not held up.
    await key("right", { key: "ArrowDown" })
    await key("right", { key: "ArrowDown" })
    expect(panel("right").cursor).toBe(2)

    await click(within(waiting).getByRole("button", { name: "Stop" }))
    const attempt = fake.api.remote.open.mock.calls[0]![2]
    expect(fake.api.remote.cancel).toHaveBeenCalledWith(attempt)
    expect(screen.queryByTestId("remote-busy-left")).toBeNull()
    expect(panel("left").loading).toBe(false)
    expect(panel("left").remote).toBeNull()
    expect(screen.queryByTestId("error-left")).toBeNull()
    expect(path("left")).toHaveTextContent(SRC.path)
  })

  it("a server that can't be reached is said in the dialog, which stays open", async () => {
    await start({ servers: [server({ fail: "timeout" })] })
    await connectSaved()
    expect(await screen.findByRole("alert")).toHaveTextContent("The server did not answer in time.")
    expect(screen.getByTestId("connections-dialog")).toBeInTheDocument()
  })
})

describe("files on a connection", () => {
  it("F5 downloads to the other panel's folder and F6 moves; both are jobs", async () => {
    const fake = await start()
    await connected()
    await cursorOn("left", README)
    await key("left", { key: "F5" })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Download readme.txt")
    expect(within(dialog).getByLabelText("Destination")).toHaveValue(DST.path)
    // No mask, no verify, no queue button: a transfer has its own lane.
    expect(within(dialog).queryByLabelText("File mask")).toBeNull()
    expect(within(dialog).queryByRole("button", { name: "Queue" })).toBeNull()
    await act(async () => {
      fireEvent.submit(dialog)
    })
    // The rows of the server's session: pub, then readme.txt.
    expect(fake.api.files.start).toHaveBeenLastCalledWith({
      kind: "download",
      source: { selection: expect.objectContaining({ ranges: [[1, 2]] }) },
      destinationDirId: 20,
      conflict: "ask",
    })

    await key("left", { key: "F6" })
    const move = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Move readme.txt")
    expect(move).toHaveTextContent("removed from where it was once its copy is complete")
    await act(async () => {
      fireEvent.submit(move)
    })
    expect(fake.api.files.start).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: "download", destinationDirId: 20, move: true }),
    )
  })

  it("F5 towards a server uploads into the folder its panel shows", async () => {
    const fake = await start()
    await connected("right")
    await cursorOn("right", PUB)
    await key("right", { key: "Enter" })
    await waitFor(() => expect(rowOf("right", PHOTO)).not.toBeNull())
    const remoteDirId = panel("right").remote!.dirId

    await cursorOn("left", 10_000_001)
    await key("left", { key: "F5" })
    const dialog = await screen.findByTestId("copy-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Upload file000000.txt")
    const destination = within(dialog).getByLabelText("Destination")
    expect(destination).toHaveValue("ftp://alice@ftp.example.org/pub")
    expect(destination).toHaveAttribute("readonly")
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(fake.api.files.start).toHaveBeenLastCalledWith({
      kind: "upload",
      source: { selection: expect.objectContaining({ queryId: panel("left").query!.queryId }) },
      remoteDirId,
      conflict: "ask",
    })
    // Never a copy or move job with the hidden folder behind the connection.
    expect(fake.api.files.start.mock.calls.every(([p]) => p.kind === "upload")).toBe(true)
  })

  it("F8 always asks and says a server has no trash; F7 and F2 act on the server", async () => {
    const fake = await start()
    await connected()
    await cursorOn("left", README)
    await key("left", { key: "F8" })
    const dialog = await screen.findByTestId("delete-dialog")
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete readme.txt on the server?")
    expect(screen.getByRole("dialog")).toHaveTextContent("A server has no trash.")
    expect(fake.api.fs.canTrash).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.submit(dialog)
    })
    expect(fake.api.files.start).toHaveBeenLastCalledWith({
      kind: "remoteDelete",
      source: { selection: expect.objectContaining({ ranges: [[1, 2]] }) },
    })
    await waitFor(() => expect(rowOf("left", README)).toBeNull())

    await key("left", { key: "F7" })
    fireEvent.change(await screen.findByLabelText("Folder name"), { target: { value: "inbox" } })
    await act(async () => {
      fireEvent.submit(screen.getByLabelText("Folder name").closest("form")!)
    })
    expect(fake.api.remote.mkdir).toHaveBeenCalledWith(panel("left").remote!.dirId, "inbox")
    expect(fake.api.fs.mkdir).not.toHaveBeenCalled()
    // The cursor lands on the new folder, found by its name.
    await waitFor(() =>
      expect(grid("left").querySelector("[data-cursor=true]")).toHaveTextContent("inbox"),
    )

    await key("left", { key: "F2" })
    const name = await screen.findByLabelText("New name")
    fireEvent.change(name, { target: { value: "outbox" } })
    await act(async () => {
      fireEvent.keyDown(name, { key: "Enter" })
    })
    expect(fake.api.remote.rename).toHaveBeenCalledWith(expect.any(Number), "outbox")
    expect(fake.api.files.rename).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(grid("left").querySelector("[data-cursor=true]")).toHaveTextContent("outbox"),
    )
  })

  it("says what is not available on a connection, and starts nothing", async () => {
    const fake = await start()
    await connected()
    await cursorOn("left", README)
    const refused: (KeyboardEventInit & { key: string })[] = [
      { key: "c", ctrlKey: true }, // clipboard
      { key: "v", ctrlKey: true },
      { key: "F5", shiftKey: true }, // copy here
      { key: "F5", altKey: true }, // pack
      { key: "F9", altKey: true }, // unpack
      { key: "m", ctrlKey: true }, // multi-rename
      { key: "F4" }, // edit
      { key: "F4", shiftKey: true }, // new file
      { key: "F7", altKey: true }, // find
      { key: "b", ctrlKey: true }, // branch view
    ]
    for (const chord of refused) {
      resetFiles()
      await key("left", chord)
      expect(notice()).toHaveTextContent("This is not available on a connection.")
    }
    expect(fake.api.files.start).not.toHaveBeenCalled()
    expect(fake.api.clip.set).not.toHaveBeenCalled()
    expect(fake.api.clip.paste).not.toHaveBeenCalled()
    expect(fake.shell).toEqual([])
    expect(screen.queryByRole("dialog")).toBeNull()

    // From the other panel too: nothing is packed onto a server.
    await cursorOn("right", 20_000_000)
    await key("right", { key: "F5", altKey: true })
    expect(notice()).toHaveTextContent("This is not available on a connection.")
    expect(screen.queryByRole("dialog")).toBeNull()
  })

  it("does not copy from one server to another", async () => {
    const fake = await start({
      servers: [server(), server({ host: "mirror.example.org" })],
      connections: [saved(), saved({ id: 2, name: "Mirror", host: "mirror.example.org" })],
    })
    for (const [side, id] of [
      ["left", 1],
      ["right", 2],
    ] as const) {
      await key(side, { key: "N", ctrlKey: true, shiftKey: true })
      await click(await screen.findByTestId(`connection-${id}`))
      await click(screen.getByRole("button", { name: "Connect" }))
      await waitFor(() => expect(panel(side).remote).not.toBeNull())
    }
    expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/")
    expect(path("right")).toHaveTextContent("ftp://alice@mirror.example.org/")
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    await cursorOn("left", README)
    await key("left", { key: "F5" })
    expect(notice()).toHaveTextContent("Files can't be copied from one server to another.")
    expect(fake.api.files.start).not.toHaveBeenCalled()
  })

  it("Enter on a file shows it in the lister; nothing a server sends is started", async () => {
    const BLOB = BASE + 9
    const fake = await start({
      servers: [server({ folders: { "/": [item(BLOB, "blob.bin", { sizeBytes: 5 })] } })],
      contents: { [BLOB]: new TextEncoder().encode("hello") },
    })
    await connectSaved()
    await cursorOn("left", BLOB)
    await key("left", { key: "Enter" })
    expect(await screen.findByTestId("lister")).toBeInTheDocument()
    expect(fake.shell).toEqual([])
  })
})

describe("tabs, sessions and lost connections", () => {
  it("keeps where a tab was on the server, without a password, and restores it as Not connected", async () => {
    const fake = await start({
      servers: [server({ password: PASSWORD })],
      connections: [saved({ hasPassword: true })],
      passwords: { 1: PASSWORD },
    })
    await connected()
    await cursorOn("left", PUB)
    await key("left", { key: "Enter" })
    await waitFor(() => expect(rowOf("left", PHOTO)).not.toBeNull())
    act(() => flushPersist())
    const stored = readStoredPanels(fake.settings[PANELS_KEY])
    expect(stored.left!.tabs[0]).toMatchObject({
      path: SRC.path,
      cursorId: null,
      remote: {
        connectionId: 1,
        label: "Work",
        host: "ftp.example.org",
        port: 21,
        user: "alice",
        encrypted: true,
        path: "/pub",
      },
    })
    expect(JSON.stringify(fake.settings)).not.toContain(PASSWORD)
    expect(JSON.stringify(fake.settings)).not.toContain("remoteId")
  })

  it("after a restart nothing connects: the tab says Not connected until Connect is pressed", async () => {
    const remote = {
      connectionId: 1,
      label: "Work",
      host: "ftp.example.org",
      port: 21,
      user: "alice",
      encrypted: true,
      path: "/pub",
    }
    const fake = await start({
      settings: {
        [PANELS_KEY]: {
          v: 3,
          active: "left",
          left: { tabs: [{ path: SRC.path, remote }] },
          right: { tabs: [{ path: DST.path }] },
        },
      },
    })
    const state = await screen.findByTestId("disconnected-left")
    expect(state).toHaveTextContent("Not connected")
    expect(state).toHaveTextContent("ftp://alice@ftp.example.org/pub")
    expect(screen.getByTestId("tab-left-0")).toHaveTextContent("Work")
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
    expect(fake.api.remote.connections).not.toHaveBeenCalled()
    expect(fake.api.remote.open).not.toHaveBeenCalled()

    await click(within(state).getByRole("button", { name: "Connect" }))
    // Back where the tab was, not at the connection's start folder.
    await waitFor(() => expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/pub"))
    await waitFor(() => expect(rowOf("left", PHOTO)).not.toBeNull())
    expect(screen.queryByTestId("disconnected-left")).toBeNull()
  })

  it('"Show the folder of this computer" makes the tab an ordinary tab again', async () => {
    const fake = await start({
      settings: {
        [PANELS_KEY]: {
          v: 3,
          active: "left",
          left: {
            tabs: [
              {
                path: SRC.path,
                remote: { connectionId: null, host: "old.example.org", port: 21, path: "/" },
              },
            ],
          },
          right: { tabs: [{ path: DST.path }] },
        },
      },
    })
    const state = await screen.findByTestId("disconnected-left")
    await click(within(state).getByRole("button", { name: "Show the folder of this computer" }))
    expect(screen.queryByTestId("disconnected-left")).toBeNull()
    expect(path("left")).toHaveTextContent(SRC.path)
    act(() => flushPersist())
    expect(readStoredPanels(fake.settings[PANELS_KEY]).left!.tabs[0]!.remote).toBeUndefined()
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
  })

  it("a connection that went away becomes Not connected on the next command", async () => {
    const fake = await start()
    await connected()
    fake.dropConnection(1)
    await key("left", { key: "r", ctrlKey: true })
    const state = await screen.findByTestId("disconnected-left")
    expect(state).toHaveTextContent("ftp://alice@ftp.example.org/")
    expect(panel("left").remote).toBeNull()
    expect(screen.queryByTestId("error-left")).toBeNull()
  })

  it("Ctrl+Shift+F disconnects: the panel shows its folder of this computer", async () => {
    const fake = await start()
    await connected()
    await key("left", { key: "F", ctrlKey: true, shiftKey: true })
    await waitFor(() => expect(path("left")).toHaveTextContent(SRC.path))
    expect(fake.api.remote.disconnect).toHaveBeenCalledWith(1)
    expect(fake.openConnections()).toEqual([])
    expect(screen.queryByTestId("disconnected-left")).toBeNull()
  })

  it("a tab left on a server keeps its connection; closing the tab closes it", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const fake = await start()
    await connected()
    // A new tab on the same place, then that tab goes to a folder of this computer.
    await key("left", { key: "t", ctrlKey: true })
    await click(path("left"))
    fireEvent.change(screen.getByLabelText("Path"), { target: { value: DST.path } })
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("Path"), { key: "Enter" })
    })
    await waitFor(() => expect(path("left")).toHaveTextContent(DST.path))
    // The first tab is still on the server, so the connection stays open.
    expect(useTabsStore.getState().left.tabs[0]!.remote).toMatchObject({ remoteId: 1, path: "/" })
    expect(fake.openConnections()).toEqual([1])

    // Shown again after its session was let go: listed from the open connection.
    await act(async () => {
      vi.advanceTimersByTime(TAB_GRACE_MS + 100)
    })
    await click(screen.getByTestId("tab-left-0"))
    await waitFor(() => expect(rowOf("left", README)).not.toBeNull())
    expect(fake.api.remote.connect).toHaveBeenCalledTimes(1)

    // Back on the local tab; closing the server's tab closes the connection.
    await click(screen.getByTestId("tab-left-1"))
    await waitFor(() => expect(path("left")).toHaveTextContent(DST.path))
    await act(async () => {
      vi.advanceTimersByTime(TAB_GRACE_MS + 100)
    })
    await act(async () => {
      fireEvent.mouseDown(screen.getByTestId("tab-left-0"), { button: 1 })
    })
    await waitFor(() => expect(fake.openConnections()).toEqual([]))
  })
})

describe("saved connections", () => {
  it("saves a new connection; the password goes to the save call and nowhere else", async () => {
    const fake = await start({ connections: [] })
    await key("left", { key: "N", ctrlKey: true, shiftKey: true })
    const list = await screen.findByTestId("connections-dialog")
    await waitFor(() => expect(list).toHaveTextContent("No connections saved yet."))
    await click(within(list).getByRole("button", { name: "New…" }))
    const form = await screen.findByTestId("connection-form")
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "Archive" } })
    fireEvent.change(within(form).getByLabelText("Server"), {
      target: { value: "ftp.example.org" },
    })
    fireEvent.change(within(form).getByLabelText("User name"), { target: { value: "alice" } })
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: PASSWORD } })
    fireEvent.change(within(form).getByLabelText("Folder on the server"), {
      target: { value: "/pub" },
    })
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(fake.api.remote.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 0,
        name: "Archive",
        host: "ftp.example.org",
        port: 21,
        tls: "explicit",
        user: "alice",
        startPath: "/pub",
      }),
      PASSWORD,
      undefined,
    )
    // Back in the list, with the connection; the field with the password is gone.
    const back = await screen.findByTestId("connections-dialog")
    await waitFor(() => expect(back).toHaveTextContent("Archive"))
    expect(screen.queryByLabelText("Password")).toBeNull()
    expect(fake.connections()[0]).toMatchObject({ name: "Archive", hasPassword: true })
    expect(JSON.stringify(useRemoteStore.getState())).not.toContain(PASSWORD)
    // Saving connects to nothing.
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
  })

  it("without a secret store no password is saved, and the form says so", async () => {
    const fake = await start({ connections: [], secureStore: false })
    await key("left", { key: "N", ctrlKey: true, shiftKey: true })
    await click(
      within(await screen.findByTestId("connections-dialog")).getByRole("button", { name: "New…" }),
    )
    const form = await screen.findByTestId("connection-form")
    await waitFor(() =>
      expect(form).toHaveTextContent("This computer has no secure store for passwords."),
    )
    expect(within(form).queryByRole("checkbox", { name: /Save the password/ })).toBeNull()
    fireEvent.change(within(form).getByLabelText("Server"), {
      target: { value: "ftp.example.org" },
    })
    fireEvent.change(within(form).getByLabelText("Password"), { target: { value: PASSWORD } })
    await act(async () => {
      fireEvent.submit(form)
    })
    // The connection is saved under its host's name; no password was offered for storing.
    expect(fake.api.remote.save).toHaveBeenCalledWith(
      expect.objectContaining({ name: "ftp.example.org" }),
      undefined,
      undefined,
    )
    expect(fake.storedPassword(1)).toBeUndefined()
    expect(fake.connections()[0]!.hasPassword).toBe(false)
  })

  it("checks the form before sending, and says when a name is taken", async () => {
    const fake = await start()
    await key("left", { key: "N", ctrlKey: true, shiftKey: true })
    await click(
      within(await screen.findByTestId("connections-dialog")).getByRole("button", { name: "New…" }),
    )
    const form = await screen.findByTestId("connection-form")
    await act(async () => {
      fireEvent.submit(form)
    })
    expect(within(form).getByRole("alert")).toHaveTextContent("Enter the server's name or address.")
    expect(fake.api.remote.save).not.toHaveBeenCalled()
    fireEvent.change(within(form).getByLabelText("Name"), { target: { value: "work" } })
    fireEvent.change(within(form).getByLabelText("Server"), {
      target: { value: "other.example.org" },
    })
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() =>
      expect(form).toHaveTextContent("A connection with this name already exists."),
    )
    expect(fake.connections()).toHaveLength(1)
  })

  it("duplicates a connection without its password, and saves a quick connection's settings", async () => {
    const fake = await start({ connections: [saved({ hasPassword: true })], passwords: { 1: "x" } })
    await key("left", { key: "N", ctrlKey: true, shiftKey: true })
    const dialog = await screen.findByTestId("connections-dialog")
    await waitFor(() => expect(dialog).toHaveTextContent("Work"))
    await click(within(dialog).getByRole("button", { name: "Duplicate" }))
    const form = await screen.findByTestId("connection-form")
    expect(within(form).getByLabelText("Name")).toHaveValue("Copy of Work")
    expect(within(form).getByLabelText("Server")).toHaveValue("ftp.example.org")
    // The copy has no stored password: none is ever read back to copy.
    expect(within(form).getByLabelText("Password")).toHaveAttribute("placeholder", "")
    await act(async () => {
      fireEvent.submit(form)
    })
    await waitFor(() => expect(fake.connections()).toHaveLength(2))
    expect(fake.connections().find((c) => c.name === "Copy of Work")).toMatchObject({
      id: 2,
      hasPassword: false,
    })
    expect(fake.storedPassword(2)).toBeUndefined()

    await click(
      within(await screen.findByTestId("connections-dialog")).getByRole("button", {
        name: "Quick connect…",
      }),
    )
    const quick = await screen.findByTestId("quick-connect")
    fireEvent.change(within(quick).getByLabelText("Server"), { target: { value: "10.0.0.7" } })
    fireEvent.change(within(quick).getByLabelText("User name"), { target: { value: "bob" } })
    await click(within(quick).getByRole("button", { name: "Save this connection…" }))
    const fresh = await screen.findByTestId("connection-form")
    expect(within(fresh).getByLabelText("Server")).toHaveValue("10.0.0.7")
    expect(within(fresh).getByLabelText("User name")).toHaveValue("bob")
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
  })

  it("removes a connection only after asking, with its stored password", async () => {
    const fake = await start({ connections: [saved({ hasPassword: true })], passwords: { 1: "x" } })
    await key("left", { key: "N", ctrlKey: true, shiftKey: true })
    const dialog = await screen.findByTestId("connections-dialog")
    await waitFor(() => expect(dialog).toHaveTextContent("Work"))
    await click(within(dialog).getByRole("button", { name: "Remove" }))
    expect(dialog).toHaveTextContent("Remove “Work” and its stored password?")
    expect(fake.api.remote.remove).not.toHaveBeenCalled()
    await click(within(dialog).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(fake.connections()).toEqual([]))
    expect(fake.storedPassword(1)).toBeUndefined()
  })

  it("the drive menu lists the connections, and reading them connects to nothing", async () => {
    const fake = await start()
    await key("left", { key: "F1", altKey: true })
    const menu = await screen.findByTestId("drive-menu-left")
    await waitFor(() => expect(menu).toHaveTextContent("Work"))
    expect(fake.api.remote.connect).not.toHaveBeenCalled()
    await click(within(menu).getByText("Work"))
    await waitFor(() => expect(path("left")).toHaveTextContent("ftp://alice@ftp.example.org/"))
  })
})
