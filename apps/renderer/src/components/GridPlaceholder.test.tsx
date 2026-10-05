import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { GridPlaceholder } from "./GridPlaceholder"

describe("GridPlaceholder", () => {
  it("caps mounted tiles regardless of the requested count", () => {
    render(<GridPlaceholder count={100_000} />)
    expect(screen.getByTestId("grid-placeholder").children).toHaveLength(24)
  })
})
