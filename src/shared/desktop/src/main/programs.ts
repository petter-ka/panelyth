// "Open with" programs (ADR-0044): programs the user picked in Settings,
// offered in both apps' context menus. Main alone writes their list
// (shared.programs): a program's path comes from the native file dialog here,
// and an open names a program and an entry by id. The program is started
// detached, without a shell, with the entry's path as its only argument, so
// neither a file name nor a renderer can add arguments or commands.
import {
  MAX_PROGRAMS,
  SHARED_PROGRAMS_KEY,
  newProgramId,
  programsFor,
  readPrograms,
  type AppId,
  type ExternalProgram,
  type SidecarMethodMap,
  type StoredPrograms,
} from "@panelyth/contracts"
import type { IpcMainInvokeEvent } from "electron"
import { posix, win32 } from "node:path"
import type { MainHandlers } from "./ipc/router"
import { RpcError } from "./sidecar/RpcClient"

/** As workspace.ts: the viewer hands over folders and media only, never a program. */
const VIEWER_KINDS: ReadonlySet<string> = new Set(["dir", "image", "video"])

/** What is at a program's path. */
export interface ProgramStat {
  kind: "file" | "dir"
  /** POSIX: an execute bit is set (Windows decides by extension). */
  executable: boolean
}

export interface ProgramsDeps {
  call<M extends "entry.path" | "library.get" | "library.setSetting">(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]>
  /** Main's native dialog for a program; null when cancelled. */
  pick(event: IpcMainInvokeEvent): Promise<string | null>
  /** Starts a program detached; never through a shell. */
  launch(file: string, args: readonly string[]): Promise<void>
  statOf(path: string): Promise<ProgramStat | null>
  /** The calling app's own view while it is the app shown. */
  canOpen(event: IpcMainInvokeEvent, app: AppId): boolean
  /** The calling app's own view, or the settings window it opened. */
  canEdit(event: IpcMainInvokeEvent, app: AppId): boolean
  /** The list changed: settings.changed to every view. */
  changed(value: StoredPrograms): void
  log(message: string, fields: Record<string, unknown>): void
  platform: NodeJS.Platform
}

type ProgramsMethod = "programs.add" | "programs.update" | "programs.open" | "programs.openFolder"

const refused = (reason: string, message: string): RpcError =>
  new RpcError("PERMISSION_DENIED", message, false, { reason })

/** A macOS app bundle: a folder that `open -a` starts. */
const isAppBundle = (platform: NodeJS.Platform, path: string): boolean =>
  platform === "darwin" && /\.app\/?$/i.test(path)

/** Why `path` cannot be an "Open with" program here, or null when it can. */
export function programProblem(
  platform: NodeJS.Platform,
  path: string,
  stat: ProgramStat | null,
): string | null {
  if (!stat) return `the program was not found: ${path}`
  if (isAppBundle(platform, path)) return stat.kind === "dir" ? null : "this is not an app"
  if (stat.kind !== "file") return "choose a program, not a folder"
  // Without a shell Windows starts .exe and .com files only (a .bat or .cmd needs cmd.exe).
  if (platform === "win32") {
    return /\.(?:exe|com)$/i.test(path) ? null : "choose a program (.exe)"
  }
  return stat.executable ? null : "this file is not a program (it cannot be executed)"
}

/** The name a newly picked program gets: its file name without .exe or .app. */
export function programName(platform: NodeJS.Platform, path: string): string {
  const base = (platform === "win32" ? win32 : posix).basename(path.replace(/[\\/]+$/, ""))
  const name = base.replace(platform === "win32" ? /\.(?:exe|com)$/i : /\.app$/i, "")
  return (name || base).slice(0, 64)
}

/** The program and arguments that open `entry` with `program`. */
export function programInvocation(
  platform: NodeJS.Platform,
  program: string,
  entry: string,
): { file: string; args: string[] } {
  // An app bundle opens a file or folder through Launch Services.
  if (isAppBundle(platform, program)) return { file: "/usr/bin/open", args: ["-a", program, entry] }
  return { file: program, args: [entry] }
}

export function programsHandlers(deps: ProgramsDeps): Pick<MainHandlers, ProgramsMethod> {
  const stored = async (): Promise<ExternalProgram[]> =>
    readPrograms((await deps.call("library.get", {})).settings[SHARED_PROGRAMS_KEY])

  // One change at a time, so two quick edits cannot overwrite each other.
  let queue: Promise<unknown> = Promise.resolve()
  const change = <T>(work: () => Promise<T>): Promise<T> => {
    const next = queue.then(work, work)
    queue = next.catch(() => undefined)
    return next
  }
  const save = async (programs: ExternalProgram[]): Promise<void> => {
    const value: StoredPrograms = { v: 1, programs }
    await deps.call("library.setSetting", { key: SHARED_PROGRAMS_KEY, value })
    deps.changed(value)
  }

  /** The program an open names, from a user's choice in the app on screen (as the commander's commands). */
  const openable = async (
    event: IpcMainInvokeEvent,
    app: AppId,
    programId: string,
  ): Promise<ExternalProgram> => {
    if (!deps.canOpen(event, app)) {
      throw refused("hidden", "programs open from the app's own window while it is shown")
    }
    const program = (await stored()).find((p) => p.id === programId)
    if (!program) throw new RpcError("NOT_FOUND", "this program is no longer in Settings", false)
    return program
  }

  /** Starts `program` with `path` as its only argument, when its target takes the entry. */
  const start = async (
    program: ExternalProgram,
    path: string,
    folder: boolean,
    kind: string,
  ): Promise<void> => {
    if (programsFor([program], folder).length === 0) {
      throw refused(
        "target",
        folder ? `${program.name} opens files only` : `${program.name} opens folders only`,
      )
    }
    // Checked again at each start: the program may have been moved or uninstalled.
    const problem = programProblem(deps.platform, program.path, await deps.statOf(program.path))
    if (problem) throw refused("missing", problem)
    const { file, args } = programInvocation(deps.platform, program.path, path)
    deps.log("programs.open", { program: program.id, name: program.name, kind })
    await deps.launch(file, args)
  }

  const editGuard = (event: IpcMainInvokeEvent, app: AppId): void => {
    if (!deps.canEdit(event, app)) throw refused("hidden", "programs are set in Settings")
  }

  return {
    "programs.add": async (event, _params, app) => {
      editGuard(event, app)
      if ((await stored()).length >= MAX_PROGRAMS) {
        throw refused("full", `at most ${MAX_PROGRAMS} programs can be added`)
      }
      const path = await deps.pick(event)
      if (path === null) return { programs: await stored(), added: null }
      const problem = programProblem(deps.platform, path, await deps.statOf(path))
      if (problem) throw refused("program", problem)
      return change(async () => {
        const programs = await stored()
        const same = programs.find((p) => p.path === path)
        if (same) return { programs, added: same.id }
        if (programs.length >= MAX_PROGRAMS) {
          throw refused("full", `at most ${MAX_PROGRAMS} programs can be added`)
        }
        const program: ExternalProgram = {
          id: newProgramId(programs.map((p) => p.id)),
          name: programName(deps.platform, path),
          path,
          target: "both",
        }
        const next = [...programs, program]
        await save(next)
        deps.log("programs.add", { program: program.id, path })
        return { programs: next, added: program.id }
      })
    },

    // The paths stay as stored: a renderer changes names, targets and the order.
    "programs.update": async (event, { programs: edits }, app) => {
      editGuard(event, app)
      return change(async () => {
        const byId = new Map((await stored()).map((p) => [p.id, p]))
        const next = edits.flatMap((edit) => {
          const program = byId.get(edit.id)
          return program ? [{ ...program, name: edit.name.trim(), target: edit.target }] : []
        })
        await save(next)
        return { programs: next }
      })
    },

    "programs.open": async (event, { programId, entryId }, app) => {
      const program = await openable(event, app, programId)
      const { path, kind, program: runnable } = await deps.call("entry.path", { entryId })
      if (app === "viewer" && (!VIEWER_KINDS.has(kind) || runnable)) {
        throw refused("kind", "this entry cannot be opened from the viewer")
      }
      await start(program, path, kind === "dir", kind)
      return { ok: true }
    },

    // The viewer's folder tree: its rows are paths, not indexed entries.
    "programs.openFolder": async (event, { programId, path }, app) => {
      const program = await openable(event, app, programId)
      const stat = await deps.statOf(path)
      if (stat?.kind !== "dir") throw refused("kind", "this folder was not found")
      // A macOS app bundle is a folder the viewer never hands over (as shell.open).
      if (isAppBundle(deps.platform, path)) {
        throw refused("kind", "this entry cannot be opened from the viewer")
      }
      await start(program, path, true, "dir")
      return { ok: true }
    },
  }
}
