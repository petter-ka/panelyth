import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it } from "vitest"
import { startSidecarMonitoring, useSidecarStore } from "../features/system/sidecarStore"
import { initTheme } from "../features/theme/themeStore"
import { installFakeBridge, readyStatus } from "../test/fakeBridge"
import { AppShell } from "./AppShell"

beforeEach(() => {
  useSidecarStore.setState({ status: null, info: null, pingMs: null, error: null })
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
    expect(await screen.findByText("The FastView backend stopped")).toBeInTheDocument()
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
    expect(localStorage.getItem("fastview.theme")).toBe("light")
    await userEvent.click(toggle)
    expect(toggle).toHaveTextContent("Theme: System")
    await userEvent.click(toggle)
    expect(toggle).toHaveTextContent("Theme: Dark")
    expect(document.documentElement).toHaveClass("dark")
  })

  it("restores a stored preference instead of the default", () => {
    localStorage.setItem("fastview.theme", "light")
    installFakeBridge()
    initTheme()
    render(<AppShell />)
    expect(screen.getByTestId("theme-toggle")).toHaveTextContent("Theme: Light")
    expect(document.documentElement).not.toHaveClass("dark")
  })
})
