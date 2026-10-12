import type { Properties } from "@panelyth/contracts"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import {
  describeAttributes,
  EntryProperties,
  formatPermissions,
  SelectionProperties,
  type PropertiesFormat,
} from "./index"

// The properties rows shared by the viewer's and the commander's dialogs
// (Stage C09).

const format: PropertiesFormat = {
  bytes: (n) => `${n} B`,
  count: (n) => String(n),
  date: (ms) => `@${ms}`,
}

const file: Properties = {
  id: 1,
  kind: "file",
  name: "notes.txt",
  ext: "txt",
  path: "C:\\work\\notes.txt",
  exists: true,
  sizeBytes: 2048,
  modifiedMs: 20,
  createdMs: 10,
  accessedMs: null,
  width: null,
  height: null,
  attrs: 4 | 1,
  permissions: null,
  linkTarget: null,
  childFolders: null,
  childMedia: null,
  favorite: false,
  rating: 0,
  label: 0,
  tags: [],
}

const rows = (): Record<string, string> => {
  const out: Record<string, string> = {}
  const terms = [...document.querySelectorAll("dt")]
  for (const dt of terms) out[dt.textContent ?? ""] = dt.nextElementSibling?.textContent ?? ""
  return out
}

describe("properties rows", () => {
  it("writes permissions and attributes in words", () => {
    expect(formatPermissions(0o755)).toBe("rwxr-xr-x")
    expect(formatPermissions(0o640)).toBe("rw-r-----")
    expect(formatPermissions(0)).toBe("---------")
    expect(describeAttributes({ attrs: 4 | 1 | 2 | 8, permissions: null })).toBe(
      "Read-only, Hidden, System, Archive",
    )
    expect(describeAttributes({ permissions: null })).toBe("None")
    // Where there are permissions, they are what is shown.
    expect(describeAttributes({ attrs: 4, permissions: 0o444 })).toBe("r--r--r-- (444)")
    expect(describeAttributes({ permissions: 0o7 })).toBe("------rwx (007)")
  })

  it("shows an entry as the viewer always did, with attributes only when asked", () => {
    const { unmount } = render(
      <dl>
        <EntryProperties p={file} format={format} user={<dt>User rows</dt>} />
      </dl>,
    )
    expect(rows()).toMatchObject({
      Type: "File (TXT)",
      Location: "C:\\work\\notes.txt",
      Size: "2048 B (2048 bytes)",
      Created: "@10",
      Modified: "@20",
      Accessed: "Not available",
    })
    expect(screen.getByText("User rows")).toBeInTheDocument()
    expect(screen.queryByTestId("props-attrs")).toBeNull()
    unmount()

    render(
      <dl>
        <EntryProperties p={file} format={format} attributes />
      </dl>,
    )
    expect(rows().Attributes).toBe("Read-only, Hidden")
    expect(screen.queryByTestId("props-link")).toBeNull()
  })

  it("shows where a link points, permissions, a folder's content and a missing entry", () => {
    render(
      <dl>
        <EntryProperties
          p={{
            ...file,
            kind: "link",
            ext: "",
            permissions: 0o777,
            linkTarget: "/srv/data",
            exists: false,
          }}
          format={format}
          attributes
        />
        <EntryProperties
          p={{ ...file, kind: "dir", ext: "", childFolders: 1, childMedia: 2 }}
          format={format}
        />
      </dl>,
    )
    expect(screen.getByTestId("props-link")).toHaveTextContent("/srv/data")
    expect(screen.getByTestId("props-attrs")).toHaveTextContent("rwxrwxrwx (777)")
    // A type without an extension has no empty brackets.
    expect(document.querySelector("dd")).toHaveTextContent(/^Link$/)
    expect(document.body).toHaveTextContent("The file was moved or deleted since it was indexed.")
    expect(document.body).toHaveTextContent("1 folder, 2 images and videos")
  })

  it("adds a selection up, with the files that are neither images nor videos", () => {
    render(
      <dl>
        <SelectionProperties
          info={{ count: 7, bytes: 300, folders: 1, images: 2, videos: 1 }}
          format={format}
        />
      </dl>,
    )
    expect(rows()).toMatchObject({
      Selected: "1 folder, 2 images, 1 video, 3 other files",
      "Total size": "300 B (300 bytes)",
      Note: "Folder sizes are not included.",
    })
  })
})
