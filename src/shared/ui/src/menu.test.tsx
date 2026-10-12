import { fireEvent, render, screen } from "@testing-library/react"
import type { JSX } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import * as icons from "./icons"
import { FLUENT_ICONS, MATERIAL_ICONS } from "./iconPaths"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
  DropdownCheckboxItem,
  DropdownContent,
  DropdownItem,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownRoot,
  DropdownTrigger,
  Notice,
  useIconSetStore,
} from "./index"

// The menus, the chrome icons and the notice moved here from the viewer
// (Stage P01).

describe("context menu", () => {
  function setup(onSelect = vi.fn(), disabled = false) {
    render(
      <ContextMenuRoot>
        <ContextMenuTrigger>
          <div data-testid="target">picture</div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>3 items</ContextMenuLabel>
          <ContextMenuItem shortcut="Ctrl+C" onSelect={onSelect}>
            Copy
          </ContextMenuItem>
          <ContextMenuItem disabled={disabled} onSelect={onSelect}>
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuRadioGroup value="name">
            <ContextMenuRadioItem value="name">By name</ContextMenuRadioItem>
            <ContextMenuRadioItem value="date">By date</ContextMenuRadioItem>
          </ContextMenuRadioGroup>
          <ContextMenuSub label="Move to">
            <ContextMenuItem>Trash</ContextMenuItem>
          </ContextMenuSub>
        </ContextMenuContent>
      </ContextMenuRoot>,
    )
    return onSelect
  }

  it("mounts nothing until it opens", () => {
    setup()
    expect(screen.queryByRole("menu")).toBeNull()
    expect(screen.queryByText("Copy")).toBeNull()
  })

  it("opens on the context-menu event with its items, hints and groups", () => {
    setup()
    fireEvent.contextMenu(screen.getByTestId("target"))
    expect(screen.getByRole("menu")).toBeInTheDocument()
    expect(screen.getByText("3 items")).toBeInTheDocument()
    const copy = screen.getByRole("menuitem", { name: /Copy/ })
    expect(copy).toHaveTextContent("Ctrl+C")
    // No hint, no empty hint element.
    expect(screen.getByRole("menuitem", { name: "Rename" }).querySelector("span")).toBeNull()
    expect(screen.getByRole("menuitemradio", { name: "By name" })).toBeChecked()
    expect(screen.getByRole("menuitemradio", { name: "By date" })).not.toBeChecked()
    expect(screen.getByRole("menuitem", { name: "Move to" })).toHaveAttribute(
      "aria-haspopup",
      "menu",
    )
    expect(screen.getByRole("separator")).toBeInTheDocument()
  })

  it("selects an item and closes", () => {
    const onSelect = setup()
    fireEvent.contextMenu(screen.getByTestId("target"))
    fireEvent.click(screen.getByRole("menuitem", { name: /Copy/ }))
    expect(onSelect).toHaveBeenCalledOnce()
    expect(screen.queryByRole("menu")).toBeNull()
  })

  it("does not select a disabled item", () => {
    const onSelect = setup(vi.fn(), true)
    fireEvent.contextMenu(screen.getByTestId("target"))
    const rename = screen.getByRole("menuitem", { name: "Rename" })
    expect(rename).toHaveAttribute("aria-disabled", "true")
    fireEvent.click(rename)
    expect(onSelect).not.toHaveBeenCalled()
  })
})

describe("dropdown menu", () => {
  it("opens from the keyboard, shows checks and reports changes", () => {
    const onSort = vi.fn()
    const onHidden = vi.fn()
    render(
      <DropdownRoot>
        <DropdownTrigger>Sort</DropdownTrigger>
        <DropdownContent>
          <DropdownRadioGroup value="name" onValueChange={onSort}>
            <DropdownRadioItem value="name">Name</DropdownRadioItem>
            <DropdownRadioItem value="size">Size</DropdownRadioItem>
          </DropdownRadioGroup>
          <DropdownCheckboxItem checked onCheckedChange={onHidden}>
            Hidden files
          </DropdownCheckboxItem>
          <DropdownItem shortcut="F5">Refresh</DropdownItem>
        </DropdownContent>
      </DropdownRoot>,
    )
    expect(screen.queryByRole("menu")).toBeNull()
    fireEvent.keyDown(screen.getByRole("button", { name: "Sort" }), { key: "Enter" })

    expect(screen.getByRole("menuitemradio", { name: "Name" })).toBeChecked()
    expect(screen.getByRole("menuitemcheckbox", { name: "Hidden files" })).toBeChecked()
    expect(screen.getByRole("menuitem", { name: /Refresh/ })).toHaveTextContent("F5")

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Size" }))
    expect(onSort).toHaveBeenCalledExactlyOnceWith("size")
    expect(onHidden).not.toHaveBeenCalled()
  })
})

describe("Notice", () => {
  it("keeps an empty live region while there is nothing to say", () => {
    render(<Notice notice={null} />)
    const region = screen.getByRole("status")
    expect(region).toHaveAttribute("aria-live", "polite")
    expect(region).toBeEmptyDOMElement()
  })

  it("shows the message with its tone and never takes the pointer", () => {
    const { rerender } = render(<Notice notice={{ id: 1, text: "Copied", tone: "info" }} />)
    expect(screen.getByRole("status")).toHaveClass("pointer-events-none")
    expect(screen.getByTestId("notice")).toHaveTextContent("Copied")
    expect(screen.getByTestId("notice")).toHaveAttribute("data-tone", "info")

    rerender(<Notice notice={{ id: 2, text: "Copy failed", tone: "error" }} />)
    expect(screen.getByTestId("notice")).toHaveTextContent("Copy failed")
    expect(screen.getByTestId("notice")).toHaveAttribute("data-tone", "error")
    expect(screen.getByTestId("notice")).toHaveClass("text-danger")
  })
})

describe("chrome icons", () => {
  // Every named icon; not the base component they draw with.
  const named = Object.entries(icons).filter(([name]) => /.Icon$/.test(name)) as [
    string,
    (props: icons.IconProps) => JSX.Element,
  ][]

  beforeEach(() => {
    localStorage.clear()
    useIconSetStore.setState({ iconSet: "default" })
  })

  it("exports the icons the apps use", () => {
    expect(named.length).toBeGreaterThanOrEqual(25)
  })

  it.each(named)("%s has a built-in drawing", (_name, IconComponent) => {
    const { container } = render(<IconComponent size={20} />)
    const svg = container.querySelector("svg")!
    expect(svg).toHaveAttribute("width", "20")
    expect(svg).toHaveAttribute("aria-hidden", "true")
    expect(svg.children.length).toBeGreaterThan(0)
  })

  // A name missing from a library would draw an empty path.
  it.each(["fluent", "material"] as const)("every icon has a %s drawing", (iconSet) => {
    useIconSetStore.setState({ iconSet })
    const paths = Object.values(iconSet === "fluent" ? FLUENT_ICONS : MATERIAL_ICONS)
    for (const [name, IconComponent] of named) {
      const { container, unmount } = render(<IconComponent />)
      const d = container.querySelector("path")?.getAttribute("d")
      expect(d, name).toBeTruthy()
      expect(paths, name).toContain(d)
      unmount()
    }
  })
})
