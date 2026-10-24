import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { startSidecarMonitoring, useSidecarStore } from "../features/system/sidecarStore"
import { useWindowFrameStore } from "@panelyth/ui"
import { usePaneStore } from "../features/workspace/workspace"
import { initTheme } from "../features/theme/themeStore"
import { installFakeBridge, readyStatus } from "../test/fakeBridge"
import { AppShell } from "./AppShell"

beforeEach(() => {
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
  usePaneStore.setState({ previewPlace: "left" })
})

describe("AppShell", () => {
  it("renders the three panes and the empty state once the backend is ready", async () => {
    installFakeBridge()
    startSidecarMonitoring()
    render(<AppShell />)
    expect(screen.getByRole("navigation", { name: "Locations" })).toBeInTheDocument()
    expect(screen.getByRole("main", { name: "Content" })).toBeInTheDocument()
    expect(screen.getByRole("complementary", { name: "Preview" })).toBeInTheDocument()
    expect(await screen.findByText("No folder open")).toBeInTheDocument()
    expect(screen.queryByTestId("grid-placeholder")).not.toBeInTheDocument()
  })

  it("the switch next to the title moves the preview to a column on the right, and back", async () => {
    installFakeBridge()
    startSidecarMonitoring()
    render(<AppShell />)
    // The columns are rebuilt on a switch, so the buttons are looked up each time.
    const place = (name: string) =>
      within(screen.getByRole("radiogroup", { name: "Preview position" })).getByRole("radio", {
        name,
      })
    expect(place("Preview under the folders")).toBeChecked()
    // Under the folders: the preview shares the left column with the sidebar.
    const leftColumn = () =>
      screen.getByRole("navigation", { name: "Locations" }).closest("#sidebar")
    const preview = () => screen.getByRole("complementary", { name: "Preview" })
    expect(leftColumn()).toContainElement(preview())

    await userEvent.click(place("Preview in a column on the right"))
    expect(place("Preview in a column on the right")).toBeChecked()
    expect(leftColumn()).not.toContainElement(preview())
    expect(preview().closest("#preview")?.parentElement).toBe(leftColumn()?.parentElement)
    expect(screen.getByRole("separator", { name: "Resize preview column" })).toBeInTheDocument()

    await userEvent.click(place("Preview under the folders"))
    expect(leftColumn()).toContainElement(preview())
  })

  it("the title strip takes over the sidebar's title row and the view bar's tile size (ADR-0045)", async () => {
    installFakeBridge()
    startSidecarMonitoring()
    const sizes = () => [
      ...screen.queryAllByRole("group", { name: "Tile size" }),
      ...screen.queryAllByRole("radiogroup", { name: "Tile size" }),
    ]
    const places = () => screen.queryAllByRole("radiogroup", { name: "Preview position" })
    const locations = () => screen.getByRole("navigation", { name: "Locations" })
    render(<AppShell />)
    // No strip (macOS, Linux, full screen): the sidebar's row and the view bar have them.
    expect(within(locations()).getByText("Panelyth")).toBeInTheDocument()
    expect(sizes()).toHaveLength(1)
    expect(places()).toHaveLength(1)
    expect(locations()).toContainElement(places()[0]!)

    act(() => useWindowFrameStore.setState({ titleBar: true, fullScreen: false }))
    // Each control once, in the strip.
    expect(within(locations()).queryByText("Panelyth")).toBeNull()
    expect(sizes()).toHaveLength(1)
    expect(places()).toHaveLength(1)
    const strip = screen.getByTestId("title-bar")
    expect(strip).toContainElement(sizes()[0]!)
    expect(strip).toContainElement(places()[0]!)

    act(() => useWindowFrameStore.setState({ fullScreen: true }))
    expect(locations()).toContainElement(places()[0]!)
    act(() => useWindowFrameStore.setState({ titleBar: false, fullScreen: false }))
  })

  it("shows the grid placeholder while starting, then follows pushed status", async () => {
    const bridge = installFakeBridge({ ...readyStatus, state: "starting", pid: null, since: 1 })
    startSidecarMonitoring()
    render(<AppShell />)
    await waitFor(() => expect(bridge.api.sidecar.getStatus).toHaveBeenCalled())
    expect(screen.getByTestId("grid-placeholder")).toBeInTheDocument()
    act(() => bridge.push("sidecar.status", { ...readyStatus, since: 2 }))
    expect(await screen.findByText("No folder open")).toBeInTheDocument()
  })

  it("shows an error state when the backend failed", async () => {
    installFakeBridge({ ...readyStatus, state: "failed", pid: null, lastError: "crashed 3 times" })
    startSidecarMonitoring()
    render(<AppShell />)
    expect(await screen.findByText("The Panelyth backend stopped")).toBeInTheDocument()
    expect(screen.getByText("crashed 3 times")).toBeInTheDocument()
  })

  it("measures ping and shows the Go version in the status bar", async () => {
    const bridge = installFakeBridge()
    startSidecarMonitoring()
    render(<AppShell />)
    expect(await screen.findByText(/^ping \d+\.\d ms$/)).toBeInTheDocument()
    expect(screen.getByText("go1.27.0")).toBeInTheDocument()
    await userEvent.click(screen.getByTestId("ping"))
    expect(bridge.api.system.ping).toHaveBeenCalledTimes(2)
  })

  it("reports a missing bridge instead of crashing", () => {
    startSidecarMonitoring()
    render(<AppShell />)
    expect(useSidecarStore.getState().error).toMatch(/bridge is not available/)
  })

  it("starts dark by default and cycles dark → light → system → dark", async () => {
    installFakeBridge()
    initTheme()
    render(<AppShell />)
    const toggle = screen.getByTestId("theme-toggle")
    expect(toggle).toHaveTextContent("Theme: Dark")
    expect(document.documentElement).toHaveClass("dark")
    await userEvent.click(toggle)
    expect(toggle).toHaveTextContent("Theme: Light")
    expect(document.documentElement).not.toHaveClass("dark")
    expect(localStorage.getItem("panelyth.theme")).toBe("light")
    await userEvent.click(toggle)
    expect(toggle).toHaveTextContent("Theme: System")
    await userEvent.click(toggle)
    expect(toggle).toHaveTextContent("Theme: Dark")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("restores a stored preference instead of the default", () => {
    localStorage.setItem("panelyth.theme", "light")
    installFakeBridge()
    initTheme()
    render(<AppShell />)
    expect(screen.getByTestId("theme-toggle")).toHaveTextContent("Theme: Light")
    expect(document.documentElement).not.toHaveClass("dark")
  })
})
