import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TextViewer } from "./TextViewer"

const params = {
  kind: "text" as const,
  name: "notes.txt",
  sizeBytes: 40,
  src: `panelyth-media://m/${"b".repeat(32)}`,
  theme: null,
}

beforeEach(() => {
  // jsdom has no layout: give the scroller a size so the virtualizer renders rows.
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(400)
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 800,
    height: 400,
    top: 0,
    left: 0,
    right: 800,
    bottom: 400,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  })
})
afterEach(() => vi.restoreAllMocks())

function serve(body: string | Uint8Array, status = 200) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body
  const fetchMock = vi.fn(async () => new Response(bytes as BodyInit, { status }))
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

describe("TextViewer", () => {
  it("shows the file's lines and its facts", async () => {
    serve("Grüße aus Köln\r\nzweite Zeile\r\n")
    render(<TextViewer params={params} />)
    await waitFor(() => expect(screen.getByTestId("text-body")).toHaveTextContent("Grüße aus Köln"))
    expect(screen.getByTestId("text-body")).toHaveTextContent("zweite Zeile")
    expect(screen.getByText("2 lines")).toBeInTheDocument()
    expect(screen.getByText("UTF-8")).toBeInTheDocument()
    expect(screen.getByText("CRLF")).toBeInTheDocument()
  })

  it("asks only for the first part of a big file and says it is cut", async () => {
    const fetchMock = serve("x\n")
    render(<TextViewer params={{ ...params, sizeBytes: 100 * 1024 * 1024 }} />)
    await waitFor(() =>
      expect(screen.getByText(/Showing the first 16\.0 MB of 100\.0 MB/)).toBeInTheDocument(),
    )
    expect(fetchMock).toHaveBeenCalledWith(
      params.src,
      expect.objectContaining({ headers: { Range: `bytes=0-${16 * 1024 * 1024 - 1}` } }),
    )
  })

  it("finds text: counts matches, steps with Enter and marks them", async () => {
    serve("alpha\nBeta beta\ngamma\n")
    render(<TextViewer params={params} />)
    await waitFor(() => expect(screen.getByTestId("text-body")).toHaveTextContent("alpha"))
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId("text-body"), { key: "f", ctrlKey: true })
    })
    const input = await screen.findByLabelText("Find in text")
    await act(async () => {
      fireEvent.change(input, { target: { value: "beta" } })
    })
    await waitFor(() => expect(screen.getByText("1 of 2")).toBeInTheDocument())
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" })
    })
    expect(screen.getByText("2 of 2")).toBeInTheDocument()
    expect(document.querySelectorAll("mark.text-hit")).toHaveLength(2)
    expect(document.querySelectorAll("mark.current")).toHaveLength(1)
    await act(async () => {
      fireEvent.change(input, { target: { value: "zzz" } })
    })
    await waitFor(() => expect(screen.getByText("No matches")).toBeInTheDocument())
  })

  it("reports a file that cannot be read", async () => {
    serve("", 404)
    render(<TextViewer params={params} />)
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be read (404)")
  })
})
