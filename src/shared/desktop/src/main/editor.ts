// Main-local handlers of the image editor (Stage 12, ADR-0035, ADR-0027).
// The sidecar renders and saves; main is where paths stay: a frame file
// becomes a one-shot token URL, a "save as" destination comes from the
// native dialog, and a finished save is shown in the file manager by job id.
// A picture for a watermark, a mask or a texture (Stage 14) is picked in the
// native dialog too: the renderer gets an id and a thumbnail token. The folder
// a batch writes into (Stage 16, ADR-0036) is picked here as well and named to
// the renderer by a handle.
import { randomBytes } from "node:crypto"
import { basename, dirname, extname, isAbsolute, join } from "node:path"
import {
  SAVE_EXTENSIONS,
  isBatchPlanResult,
  isEditAssetFile,
  isEditFrameResult,
  isEditThumbFramesResult,
  type BatchParams,
  type EditBatchParams,
  type EditRenderResult,
  type SaveFormat,
  type SidecarMethodMap,
} from "@panelyth/contracts"
import type { IpcMainInvokeEvent } from "electron"
import type { MainHandlers } from "./ipc/router"
import { mintMediaUrl, type MediaTokens } from "./mediaProtocol"
import { RpcError } from "./sidecar/RpcClient"

type EditorSidecarMethod =
  | "edit.frame"
  | "edit.write"
  | "edit.savedPath"
  | "edit.source"
  | "edit.thumbFrames"
  | "edit.assetAdd"
  | "edit.assetDrop"
  | "edit.plan"
  | "edit.batch"

/** The picture types an asset may have; the sidecar checks the content, not the name. */
export const ASSET_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"] as const

export interface EditorDeps {
  call<M extends EditorSidecarMethod>(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]>
  /** Tokens for frames only: a small store, so dragging a slider never evicts an open picture's token. */
  tokens: MediaTokens
  /** Tokens for preset thumbnails (Stage 13): a batch must not evict the frame on the canvas. */
  thumbTokens: MediaTokens
  /** The native save dialog; resolves to null when cancelled. */
  saveDialog(
    event: IpcMainInvokeEvent,
    options: { defaultPath: string; format: SaveFormat },
  ): Promise<string | null>
  showItemInFolder(path: string): void
  /** The native dialog for a picture to use as an asset; resolves to null when cancelled. */
  openDialog(event: IpcMainInvokeEvent, options: { defaultPath: string }): Promise<string | null>
  /** The native dialog for the folder a batch writes into; resolves to null when cancelled. */
  folderDialog(event: IpcMainInvokeEvent): Promise<string | null>
}

/** Picked folders main remembers; the oldest handle is forgotten first. */
export const MAX_BATCH_FOLDERS = 16

/** Frames are files the sidecar names "<session>-<n>.jpg" in its tmp/edit folder; nothing else gets a token here. */
const FRAME_FILE = /^[0-9a-f]{24}-\d{1,9}\.(jpg|png)$/

export function isFrameFile(path: string): boolean {
  return isAbsolute(path) && basename(dirname(path)) === "edit" && FRAME_FILE.test(basename(path))
}

/** The default name of a "save as": "name (edited).ext" beside the original. */
export function defaultSavePath(source: string, format: SaveFormat): string {
  const base = basename(source)
  const stem = base.slice(0, base.length - extname(base).length)
  return join(dirname(source), `${stem} (edited).${SAVE_EXTENSIONS[format][0]}`)
}

/** The chosen path under an extension of the format: a missing or foreign one gets the default added. */
export function withFormatExtension(path: string, format: SaveFormat): string {
  const ext = extname(path).slice(1).toLowerCase()
  return SAVE_EXTENSIONS[format].includes(ext) ? path : `${path}.${SAVE_EXTENSIONS[format][0]}`
}

export function editorHandlers(
  deps: EditorDeps,
): Pick<
  MainHandlers,
  | "edit.render"
  | "edit.save"
  | "edit.reveal"
  | "edit.thumbs"
  | "asset.pick"
  | "asset.release"
  | "batch.pickFolder"
  | "batch.plan"
  | "batch.start"
> {
  // Handle → path of the folders picked for a batch; a path never passes a renderer.
  const folders = new Map<string, string>()
  const withFolder = ({ source, recipe, folderId }: BatchParams): EditBatchParams => {
    if (folderId === undefined) return { source, recipe }
    const folder = folders.get(folderId)
    if (folder === undefined) {
      throw new RpcError("INVALID_ARGUMENT", "choose the destination folder again", false)
    }
    return { source, recipe, folder }
  }
  return {
    "batch.pickFolder": async (event) => {
      const chosen = await deps.folderDialog(event)
      if (chosen === null) return { folder: null }
      if (!isAbsolute(chosen) || chosen.includes("\0")) {
        throw new RpcError("INVALID_PATH", "the folder must be named by an absolute path", false)
      }
      const folderId = randomBytes(8).toString("hex")
      folders.set(folderId, chosen)
      for (const oldest of folders.keys()) {
        if (folders.size <= MAX_BATCH_FOLDERS) break
        folders.delete(oldest)
      }
      return { folder: { folderId, name: basename(chosen) || chosen } }
    },
    "batch.plan": async (_event, params) => {
      const r = await deps.call("edit.plan", withFolder(params))
      if (!isBatchPlanResult(r)) throw new RpcError("INTERNAL", "unexpected plan", false)
      return r
    },
    // The job is listed in the app that runs it (ADR-0031 amended).
    "batch.start": async (_event, params, app) =>
      deps.call("edit.batch", { ...withFolder(params), app }),
    "asset.pick": async (event, { sessionId }) => {
      // The dialog opens in the edited picture's folder: logos tend to live near.
      const { path: source } = await deps.call("edit.source", { sessionId })
      const chosen = await deps.openDialog(event, { defaultPath: dirname(source) })
      if (chosen === null) return { asset: null }
      if (!isAbsolute(chosen) || chosen.includes("\0")) {
        throw new RpcError("INVALID_PATH", "the picture must be named by an absolute path", false)
      }
      const r = await deps.call("edit.assetAdd", { sessionId, path: chosen })
      if (!isEditAssetFile(r) || !isFrameFile(r.thumb.file)) {
        throw new RpcError("INTERNAL", "unexpected asset", false)
      }
      return {
        asset: {
          assetId: r.assetId,
          name: r.name,
          width: r.width,
          height: r.height,
          thumbUrl: mintMediaUrl(deps.thumbTokens, { path: r.thumb.file, mime: "image/png" }),
        },
      }
    },
    "asset.release": async (_event, { sessionId, assetId }) => {
      await deps.call("edit.assetDrop", { sessionId, assetId })
      return { ok: true }
    },
    "edit.thumbs": async (_event, params) => {
      const r = await deps.call("edit.thumbFrames", params)
      if (!isEditThumbFramesResult(r))
        throw new RpcError("INTERNAL", "unexpected thumbnails", false)
      return {
        thumbs: r.thumbs.map((t) =>
          t && isFrameFile(t.file)
            ? {
                url: mintMediaUrl(deps.thumbTokens, { path: t.file, mime: "image/jpeg" }),
                width: t.width,
                height: t.height,
              }
            : null,
        ),
      }
    },
    "edit.render": async (_event, params): Promise<EditRenderResult> => {
      const r = await deps.call("edit.frame", params)
      if (!isEditFrameResult(r)) throw new RpcError("INTERNAL", "unexpected frame", false)
      if (r.superseded || !r.frame) return { rev: r.rev, superseded: true }
      if (!isFrameFile(r.frame.file)) throw new RpcError("INTERNAL", "unexpected frame file", false)
      return {
        rev: r.rev,
        frame: {
          url: mintMediaUrl(deps.tokens, { path: r.frame.file, mime: r.frame.mime }),
          width: r.frame.width,
          height: r.frame.height,
        },
        ...(r.output && { output: r.output }),
        ...(r.histogram && { histogram: r.histogram }),
        ...(r.before && { before: r.before }),
      }
    },
    "edit.save": async (event, params, app) => {
      // The save job is listed in the app that saves (ADR-0031 amended).
      if (params.target !== "as") {
        const { jobId, name } = await deps.call("edit.write", { ...params, app })
        return { jobId, name }
      }
      // The dialog opens beside the original; the path never passes a renderer.
      const { path: source } = await deps.call("edit.source", { sessionId: params.sessionId })
      const chosen = await deps.saveDialog(event, {
        defaultPath: defaultSavePath(source, params.format),
        format: params.format,
      })
      if (chosen === null) return { jobId: null, name: "" }
      if (!isAbsolute(chosen) || chosen.includes("\0")) {
        throw new RpcError("INVALID_PATH", "the destination must be an absolute path", false)
      }
      const path = withFormatExtension(chosen, params.format)
      const { jobId, name } = await deps.call("edit.write", { ...params, path, app })
      return { jobId, name }
    },
    "edit.reveal": async (_event, { jobId }) => {
      const { path } = await deps.call("edit.savedPath", { jobId })
      deps.showItemInFolder(path)
      return { ok: true }
    },
  }
}
