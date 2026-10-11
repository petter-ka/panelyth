import { render } from "@testing-library/react"
import { useRef } from "react"
import { describe, expect, it } from "vitest"
import { useScrollMemory } from "./components/useScrollMemory"

function List({ folder }: { folder: number | null }) {
  const el = useRef<HTMLDivElement>(null)
  useScrollMemory(el, "left", folder, "top")
  return <div ref={el} data-testid="list" />
}

describe("useScrollMemory", () => {
  it("puts a folder back where it was scrolled, and opens others at the top", () => {
    const { rerender, getByTestId } = render(<List folder={1} />)
    const list = getByTestId("list")
    list.scrollTop = 840
    list.dispatchEvent(new Event("scroll"))

    rerender(<List folder={2} />)
    expect(list.scrollTop).toBe(0)

    let seen = -1
    list.addEventListener("scroll", () => (seen = list.scrollTop))
    rerender(<List folder={1} />)
    expect(list.scrollTop).toBe(840)
    // A synchronous scroll event, so the virtualizer's offset is current.
    expect(seen).toBe(840)
  })

  it("does not remember views that are not a plain folder", () => {
    const { rerender, getByTestId } = render(<List folder={null} />)
    const list = getByTestId("list")
    list.scrollTop = 300
    list.dispatchEvent(new Event("scroll"))
    rerender(<List folder={null} />)
    expect(list.scrollTop).toBe(300)
    rerender(<List folder={5} />)
    expect(list.scrollTop).toBe(0)
  })
})
