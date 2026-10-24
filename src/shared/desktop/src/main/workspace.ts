// Main-local workspace handlers (Stage 05): places, shell integration and the
// clipboard. Paths for indexed entries are resolved by the sidecar and never
// travel to the renderer. The index holds every entry since Stage P02, so
// "open" checks the kind per app profile (ADR-0027): the viewer never
// launches anything but folders and media; the commander opens any file,
// and programs only after the user confirmed (Stage C05).
import { readFile, rm, stat } from "node:fs/promises"
import { EOL } from "node:os"
import { basename, isAbsolute } from "node:path"
import type { Place, PlaceId, SidecarMethodMap } from "@panelyth/contracts"
import type { WebContents } from "electron"
import type { MainHandlers } from "./ipc/router"
import { RpcError } from "./sidecar/RpcClient"

const VIEWER_OPENABLE_KINDS: ReadonlySet<string> = new Set(["dir", "image", "video"])

/** The commander's settings key; `editor` is the F4 program (Stage C05). */
export const COMMANDER_SETTINGS_KEY = "commander.settings"

type WorkspaceMethod =
  | "places.list"
  | "shell.open"
  | "shell.edit"
  | "shell.reveal"
  | "shell.revealPath"
  | "clipboard.copyPaths"
  | "clipboard.copyText"
  | "clipboard.copyImage"
  | "drag.start"

export interface WorkspaceDeps {
  call<M extends "entry.path" | "selection.paths" | "clipboard.image" | "library.get">(
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
  /** The OS's drag of these files from `sender` (ADR-0040), while its pointer is still down. */
  startDrag(sender: WebContents, files: readonly string[]): Promise<void>
  /** Starts a program detached (the F4 editor); never through a shell. */
  launch(file: string, args: readonly string[]): Promise<void>
  /**
   * The built-in text editor (ADR-0046): opens the file in an editor window.
   * The sidecar's refusals (a binary, too large, not on this computer) reach
   * the commander with their reasons.
   */
  openTextEditor(entryId: number): Promise<void>
  platform: NodeJS.Platform
}

/** The editor path from the commander's settings ("" = the built-in editor, ADR-0046). */
export function editorFrom(settings: Record<string, unknown>): string {
  const value = (settings[COMMANDER_SETTINGS_KEY] as { editor?: unknown } | undefined)?.editor
  return typeof value === "string" ? value.trim() : ""
}

/** A refusal the commander shows as a message (details.reason). */
const refused = (reason: string, message: string): RpcError =>
  new RpcError("PERMISSION_DENIED", message, false, { reason })

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
      // XDG user dirs set to the home folder are disabled (xdg-user-dirs
      // writes that for folders that do not exist), and Electron then
      // returns home for them: list home once (Stage P04).
      const home = candidates.find((p) => p.id === "home")?.path
      const places: Place[] = candidates.filter(
        (p, i) => exists[i] && (p.id === "home" || p.path !== home),
      )
      return { places }
    },
    "shell.open": async (_event, { entryId, allowProgram }, app) => {
      const { path, kind, program } = await deps.call("entry.path", { entryId })
      if (app === "viewer") {
        // Folders and media only, never a program (a macOS app bundle is a
        // folder that opening would launch).
        if (!VIEWER_OPENABLE_KINDS.has(kind) || program) {
          throw new Error("this entry cannot be opened from the viewer")
        }
      } else if (program && allowProgram !== true) {
        throw refused("program", "this file is a program; confirm to run it")
      }
      const error = await deps.openPath(path)
      if (error) throw new Error(error)
      return { ok: true }
    },
    // F4 (commander only): the editor from settings, else the built-in one
    // (ADR-0046). The editor path never comes from the call, and nothing goes
    // through a shell, so a file name cannot inject arguments or commands.
    "shell.edit": async (_event, { entryId }) => {
      const { path, kind } = await deps.call("entry.path", { entryId })
      if (kind === "dir") throw refused("folder", "a folder cannot be edited")
      const editor = editorFrom((await deps.call("library.get", {})).settings)
      if (!editor) {
        await deps.openTextEditor(entryId)
        return { ok: true }
      }
      const isFile =
        isAbsolute(editor) &&
        (await stat(editor).then(
          (s) => s.isFile(),
          () => false,
        ))
      if (!isFile) throw refused("editor", `the editor was not found: ${editor}`)
      await deps.launch(editor, [path])
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
    "clipboard.copyPaths": async (_event, { selection, namesOnly }) => {
      const { paths, truncated } = await deps.call("selection.paths", { selection, limit: 0 })
      const lines = namesOnly ? paths.map((p) => basename(p)) : paths
      if (lines.length > 0) deps.writeClipboard(lines.join(EOL))
      return { count: paths.length, truncated }
    },
    // Files to other apps (ADR-0040): the paths go from Go to the OS, never
    // through the renderer. A part of a selection would surprise the drop
    // target, so more than selection.paths gives drags nothing.
    "drag.start": async (event, { selection }) => {
      const { paths, truncated } = await deps.call("selection.paths", { selection, limit: 0 })
      if (paths.length > 0 && !truncated) await deps.startDrag(event.sender, paths)
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
