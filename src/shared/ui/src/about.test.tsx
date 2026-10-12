import type { AboutInfo, UpdateState } from "@panelyth/contracts"
import { startAboutSync, useAboutStore, type AboutPort } from "@panelyth/renderer-core"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  AppSwitcher,
  menuCommandHandler,
  requestSettingsTab,
  SharedSettingsDialog,
  TooltipProvider,
} from "./index"

const state = (patch: Partial<UpdateState> = {}): UpdateState => ({
  mode: "auto",
  phase: "idle",
  currentVersion: "1.1.0",
  version: null,
  releaseDate: null,
  notes: [],
  percent: 0,
  transferredBytes: 0,
  totalBytes: 0,
  checkedAt: null,
  error: null,
  auto: true,
  ...patch,
})

const info: AboutInfo = {
  name: "Panelyth",
  version: "1.1.0",
  sidecarVersion: "1.1.0+g1647109",
  electron: "44.5.1",
  chrome: "150.0.0.0",
  node: "24.1.0",
  platform: "win32 x64",
  packaged: true,
  copyright: "Copyright © Panelyth contributors",
}

/** Main's next state, as its update.state event delivers it. */
let push: (state: UpdateState) => void = () => undefined

function fakePort(initial: UpdateState): AboutPort & Record<string, ReturnType<typeof vi.fn>> {
  return {
    about: vi.fn(async () => info),
    updateState: vi.fn(async () => initial),
    check: vi.fn(async () => ({ ...initial, phase: "checking" as const })),
    download: vi.fn(async () => ({ ...initial, phase: "downloading" as const })),
    install: vi.fn(async () => undefined),
    openTarget: vi.fn(async () => undefined),
    saveSetting: vi.fn(),
    onUpdateState: vi.fn((listener: (state: UpdateState) => void) => {
      push = listener
      return () => undefined
    }),
    onMenuCommand: vi.fn(() => () => undefined),
  } as never
}

async function openAbout(update: UpdateState) {
  const port = fakePort(update)
  startAboutSync(port, vi.fn())
  useAboutStore.setState({ update })
  const onClose = vi.fn()
  const view = render(
    <TooltipProvider>
      <SharedSettingsDialog
        currentApp="viewer"
        open
        onClose={onClose}
        showGeneral
        settingsReady
        appSettings={<div data-testid="app-settings-body" />}
        onOpenShortcuts={vi.fn()}
      />
    </TooltipProvider>,
  )
  fireEvent.click(screen.getByRole("tab", { name: "About" }))
  // The build's details arrive after the tab is shown.
  await act(async () => undefined)
  return { port, onClose, view }
}

describe("Settings → About (Stage P06)", () => {
  beforeEach(() => {
    useAboutStore.setState({ info: null, update: null, problem: null })
    requestSettingsTab(null)
  })

  it("shows the version and the build's details", async () => {
    await openAbout(state({ phase: "upToDate" }))
    expect(screen.getByTestId("about-version")).toHaveTextContent("Version 1.1.0")
    expect(screen.getByTestId("update-status")).toHaveTextContent("Panelyth is up to date.")
    expect(screen.getByTestId("about-details")).toHaveTextContent(
      "Sidecar 1.1.0+g1647109 · Electron 44.5.1 · Chromium 150.0.0.0 · Node 24.1.0 · win32 x64",
    )
  })

  it("checks when asked", async () => {
    const { port } = await openAbout(state())
    expect(screen.getByTestId("update-status")).toHaveTextContent("Not checked yet.")
    await act(async () => void fireEvent.click(screen.getByTestId("update-check")))
    expect(port.check).toHaveBeenCalledTimes(1)
    act(() => push(state({ phase: "checking" })))
    expect(screen.getByTestId("update-status")).toHaveTextContent("Checking for updates…")
    expect(screen.getByTestId("update-check")).toBeDisabled()
  })

  it("offers a found version with what changed, then the download", async () => {
    const { port } = await openAbout(
      state({
        phase: "available",
        version: "1.2.0",
        notes: [{ version: "1.2.0", text: "• Faster folders\n• <b>not markup</b>" }],
      }),
    )
    expect(screen.getByTestId("update-status")).toHaveTextContent("Version 1.2.0 is available.")
    const notes = screen.getByTestId("update-notes")
    expect(notes).toHaveTextContent("Faster folders")
    // Notes are text: a tag in them is shown, never built.
    expect(notes).toHaveTextContent("<b>not markup</b>")
    expect(notes.querySelector("b")).toBeNull()
    await act(async () => void fireEvent.click(screen.getByTestId("update-download")))
    expect(port.download).toHaveBeenCalledTimes(1)
  })

  it("shows the download and then asks for the restart", async () => {
    const first = await openAbout(state({ phase: "downloading", version: "1.2.0", percent: 41.6 }))
    expect(screen.getByTestId("update-status")).toHaveTextContent("Downloading version 1.2.0… 42 %")
    expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "42")
    first.view.unmount()

    const { port } = await openAbout(state({ phase: "ready", version: "1.2.0", percent: 100 }))
    await act(async () => void fireEvent.click(screen.getByTestId("update-install")))
    expect(port.install).toHaveBeenCalledTimes(1)
  })

  it("sends a build that cannot install to the download page", async () => {
    const { port } = await openAbout(
      state({ mode: "manual", phase: "available", version: "1.2.0" }),
    )
    expect(screen.queryByTestId("update-download")).toBeNull()
    fireEvent.click(screen.getByTestId("update-open-page"))
    expect(port.openTarget).toHaveBeenCalledWith("releases")
  })

  it("says why a check failed and lets it be tried again", async () => {
    const { port } = await openAbout(state({ phase: "error", error: "net::ERR_NAME_NOT_RESOLVED" }))
    expect(screen.getByTestId("update-status")).toHaveTextContent(
      "The update check failed: net::ERR_NAME_NOT_RESOLVED",
    )
    await act(async () => void fireEvent.click(screen.getByTestId("update-check")))
    expect(port.check).toHaveBeenCalledTimes(1)
  })

  it("has no update controls in a build without updates, but keeps the links", async () => {
    const { port } = await openAbout(state({ mode: "off" }))
    expect(screen.getByTestId("update-status")).toHaveTextContent(
      "This build does not update itself.",
    )
    expect(screen.queryByTestId("update-check")).toBeNull()
    expect(screen.queryByRole("switch", { name: "Check automatically" })).toBeNull()
    for (const target of ["releases", "issues", "logs", "notices"]) {
      fireEvent.click(screen.getByTestId(`about-open-${target}`))
    }
    expect(vi.mocked(port.openTarget).mock.calls.map(([target]) => target)).toEqual([
      "releases",
      "issues",
      "logs",
      "notices",
    ])
  })

  it("turns the automatic check off and on", async () => {
    const { port } = await openAbout(state({ phase: "upToDate" }))
    const toggle = screen.getByRole("switch", { name: "Check automatically" })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    fireEvent.click(toggle)
    expect(port.saveSetting).toHaveBeenCalledWith("shared.updates", { v: 1, auto: false })
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })
})

describe("the native menu's items in an app", () => {
  beforeEach(() => {
    useAboutStore.setState({ info: null, update: null, problem: null })
    requestSettingsTab(null)
  })

  function mount(update: UpdateState) {
    const port = fakePort(update)
    startAboutSync(port, vi.fn())
    useAboutStore.setState({ update })
    const app = { openSettings: vi.fn(), openShortcuts: vi.fn() }
    return { port, app, run: menuCommandHandler(app) }
  }

  const dialog = (open: boolean) => (
    <TooltipProvider>
      <SharedSettingsDialog
        currentApp="commander"
        open={open}
        onClose={vi.fn()}
        showGeneral
        settingsReady
        appSettings={<div data-testid="app-settings-body" />}
        onOpenShortcuts={vi.fn()}
      />
    </TooltipProvider>
  )

  it("opens Settings on the app's own tab, and Shortcuts", () => {
    const { app, run } = mount(state())
    run("settings")
    expect(app.openSettings).toHaveBeenCalledTimes(1)
    render(dialog(true))
    expect(screen.getByRole("tab", { name: "Commander" })).toHaveAttribute("aria-selected", "true")
    run("shortcuts")
    expect(app.openShortcuts).toHaveBeenCalledTimes(1)
  })

  it("opens About, and the next opening starts on the app's tab again", async () => {
    const { app, run, port } = mount(state())
    run("about")
    expect(app.openSettings).toHaveBeenCalledTimes(1)
    expect(port.check).not.toHaveBeenCalled()
    const view = render(dialog(true))
    await act(async () => undefined)
    expect(screen.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true")
    // The user's own choice holds until the menu asks again.
    fireEvent.click(screen.getByRole("tab", { name: "Appearance" }))
    expect(screen.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true")
    act(() => run("about"))
    expect(screen.getByRole("tab", { name: "About" })).toHaveAttribute("aria-selected", "true")

    view.rerender(dialog(false))
    view.rerender(dialog(true))
    expect(screen.getByRole("tab", { name: "Commander" })).toHaveAttribute("aria-selected", "true")
  })

  it("checks for updates from the menu, unless a version is already waiting", () => {
    const first = mount(state())
    first.run("checkForUpdates")
    expect(first.port.check).toHaveBeenCalledTimes(1)
    const waiting = mount(state({ phase: "available", version: "1.2.0" }))
    waiting.run("checkForUpdates")
    expect(waiting.port.check).not.toHaveBeenCalled()
    expect(waiting.app.openSettings).toHaveBeenCalledTimes(1)
  })
})

describe("the rail's settings button", () => {
  beforeEach(() => useAboutStore.setState({ info: null, update: null, problem: null }))

  const rail = () => (
    <TooltipProvider>
      <AppSwitcher
        current="viewer"
        shortcut="Ctrl+Shift+M"
        onSwitch={vi.fn()}
        onSettings={vi.fn()}
      />
    </TooltipProvider>
  )

  it("marks a version that waits for the user", () => {
    render(rail())
    const button = screen.getByTestId("app-settings")
    expect(button).toHaveAccessibleName("Settings")
    expect(button).not.toHaveAttribute("data-update")
    act(() => useAboutStore.setState({ update: state({ phase: "available", version: "1.2.0" }) }))
    expect(button).toHaveAccessibleName("Settings — Update available")
    expect(button).toHaveAttribute("data-update", "waiting")
  })
})
