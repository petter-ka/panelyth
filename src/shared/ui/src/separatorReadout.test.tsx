import { act, render, screen } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"
import { SeparatorReadout } from "./SeparatorReadout"

/** A group of two panels and the border between them, laid out with fixed rectangles. */
function Layout({ stacked = false }: { stacked?: boolean }) {
  const border = useRef<HTMLDivElement>(null)
  return (
    <div data-testid="group">
      <div data-testid="before" />
      <div
        ref={border}
        role="separator"
        aria-orientation={stacked ? "horizontal" : "vertical"}
        data-separator="inactive"
        data-testid="border"
      />
      <SeparatorReadout separator={border} />
      <div data-testid="after" />
    </div>
  )
}

const place = (id: string, rect: Partial<DOMRect>): void => {
  screen.getByTestId(id).getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 0, height: 0, ...rect }) as DOMRect
}

const setState = async (state: string, valueNow = "25"): Promise<void> => {
  await act(async () => {
    const border = screen.getByTestId("border")
    border.dataset.separator = state
    border.setAttribute("aria-valuenow", valueNow)
  })
}

describe("SeparatorReadout", () => {
  it("shows the two panels' shares while the border is hovered or dragged, and hides after", async () => {
    render(<Layout />)
    place("group", { width: 1000, height: 600 })
    place("before", { width: 250 })
    place("after", { width: 749 })
    place("border", { left: 250, top: 0, width: 1, height: 600 })
    expect(screen.queryByTestId("separator-readout")).toBeNull()

    await setState("hover")
    expect(screen.getByTestId("separator-readout")).toHaveTextContent("25%75%")
    expect(screen.getByTestId("separator-readout")).toHaveAttribute("aria-hidden", "true")

    place("before", { width: 400 })
    place("after", { width: 599 })
    await setState("active", "40")
    expect(screen.getByTestId("separator-readout")).toHaveTextContent("40%60%")

    await setState("inactive")
    expect(screen.queryByTestId("separator-readout")).toBeNull()
  })

  it("stacks the numbers for a border across the panels, and shows on keyboard focus", async () => {
    render(<Layout stacked />)
    place("group", { width: 300, height: 800 })
    place("before", { height: 496 })
    place("after", { height: 303 })
    place("border", { left: 0, top: 496, width: 300, height: 1 })
    await setState("focus", "62")
    const readout = screen.getByTestId("separator-readout")
    expect(readout).toHaveTextContent("62%38%")
    expect(readout).toHaveClass("flex-col")
    // No pointer: at the middle of the border.
    expect(readout.style.left).toBe(`${150 + 14}px`)
    expect(readout.style.top).toBe("496.5px")
  })
})
