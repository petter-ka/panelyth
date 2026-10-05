// Main-local workspace handlers (Stage 05): places, shell integration and the
// clipboard. Paths for indexed entries are resolved by the sidecar and never
// travel to the renderer; the index only holds folders and media files, so
// "open" can never launch an executable.
import { readFile, rm, stat } from "node:fs/promises"
import { EOL } from "node:os"
import type { Place, PlaceId, SidecarMethodMap } from "@fastview/contracts"
import type { MainHandlers } from "./ipc/router"

type WorkspaceMethod =
  | "places.list"
  | "shell.open"
  | "shell.reveal"
  | "shell.revealPath"
  | "clipboard.copyPaths"
  | "clipboard.copyText"
  | "clipboard.copyImage"

export interface WorkspaceDeps {
  call<M extends "entry.path" | "selection.paths" | "clipboard.image">(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]>
  getPath(id: PlaceId): string
  /** shell.openPath: resolves to "" on success, otherwise an error message. */
  openPath(path: string): Promise<string>
  showItemInFolder(path: string): void
  writeClipboard(text: string): void
  /** Puts a PNG on the OS clipboard as a picture. */
  writeClipboardImage(png: Buffer): Promise<void>
}

const PLACES: readonly { id: PlaceId; label: string }[] = [
  { id: "home", label: "Home" },
  { id: "desktop", label: "Desktop" },
  { id: "documents", label: "Documents" },
  { id: "downloads", label: "Downloads" },
  { id: "pictures", label: "Pictures" },
  { id: "videos", label: "Videos" },
]

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

/** "WxH" from a PNG's IHDR chunk (test recording only). */
export function pngSize(png: Buffer): string {
  if (png.length < 24) return "invalid"
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`
}

export function workspaceHandlers(deps: WorkspaceDeps): Pick<MainHandlers, WorkspaceMethod> {
  return {
    "places.list": async () => {
      const candidates = PLACES.flatMap(({ id, label }) => {
        try {
          return [{ id, label, path: deps.getPath(id) }]
        } catch {
          return [] // not defined on this platform
        }
      })
      const exists = await Promise.all(candidates.map((p) => isDir(p.path)))
      const places: Place[] = candidates.filter((_, i) => exists[i])
      return { places }
    },
    "shell.open": async (_event, { entryId }) => {
      const { path } = await deps.call("entry.path", { entryId })
      const error = await deps.openPath(path)
      if (error) throw new Error(error)
      return { ok: true }
    },
    "shell.reveal": async (_event, { entryId }) => {
      const { path } = await deps.call("entry.path", { entryId })
      deps.showItemInFolder(path)
      return { ok: true }
    },
    "shell.revealPath": async (_event, { path }) => {
      if (!(await isDir(path))) throw new Error("folder does not exist")
      deps.showItemInFolder(path)
      return { ok: true }
    },
    "clipboard.copyPaths": async (_event, { selection }) => {
      const { paths, truncated } = await deps.call("selection.paths", { selection, limit: 0 })
      if (paths.length > 0) deps.writeClipboard(paths.join(EOL))
      return { count: paths.length, truncated }
    },
    "clipboard.copyText": (_event, { text }) => {
      deps.writeClipboard(text)
      return { ok: true }
    },
    // Go decodes the picture into a temp file (Stage 08.6); main only reads
    // it asynchronously and hands the bitmap to the OS clipboard.
    "clipboard.copyImage": async (_event, { entryId }) => {
      const { file, width, height } = await deps.call("clipboard.image", { entryId })
      try {
        await deps.writeClipboardImage(await readFile(file))
      } finally {
        await rm(file, { force: true })
      }
      return { width, height }
    },
  }
}
