import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TitleBarSegment, TitleBarToggle } from "./TitleBarControls"

describe("the title strip's view switchers", () => {
  it("a segment lights its value and reports a choice", () => {
    const onChange = vi.fn()
    render(
      <TitleBarSegment
        label="View"
        value="full"
        onChange={onChange}
        options={[
          { value: "full", label: "Full view", icon: "F", shortcut: "Ctrl+F2" },
          { value: "brief", label: "Brief view", icon: "B" },
        ]}
      />,
    )
    expect(screen.getByRole("radio", { name: "Full view" })).toHaveAttribute("aria-checked", "true")
    expect(screen.getByRole("radio", { name: "Brief view" })).toHaveAttribute(
      "aria-checked",
      "false",
    )
    fireEvent.click(screen.getByRole("radio", { name: "Brief view" }))
    expect(onChange).toHaveBeenCalledWith("brief")
  })

  it("never takes the focus from the panel or the tiles", () => {
    render(
      <>
        <input aria-label="panel" />
        <TitleBarToggle label="Quick view" pressed={false} onClick={vi.fn()} icon="Q" />
      </>,
    )
    const panel = screen.getByRole("textbox", { name: "panel" })
    panel.focus()
    const toggle = screen.getByRole("button", { name: "Quick view" })
    // A pressed mouse button would move the focus; the switcher refuses it.
    expect(fireEvent.mouseDown(toggle)).toBe(false)
    expect(toggle).toHaveAttribute("aria-pressed", "false")
  })
})
