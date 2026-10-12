// The commander's command line and user commands (Stage C10, ADR-0027).
//
// A command runs through the OS shell (cmd.exe on Windows, /bin/sh
// elsewhere) in a folder the sidecar resolved from an id. Two calls exist:
//
//   shell.run      a line the user typed and confirmed with Enter. It is
//                  passed to the shell as typed. An empty line with the
//                  console flag opens a console in the folder.
//   shell.runTool  a user command stored in library.db. The call carries its
//                  id and entry ids only; main reads the command, asks the
//                  sidecar for the paths and fills the placeholders.
//
// File names are hostile input for the second call: a name may hold "&",
// "%", quotes or a leading "-". quoteSh and quoteCmd are the only places a
// name becomes shell text.
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
import { EOL } from "node:os"
import { join, win32, posix } from "node:path"
import {
  COMMANDER_TOOLS_KEY,
  readUserCommands,
  type SidecarMethodMap,
  type UserCommand,
} from "@panelyth/contracts"
import type { IpcMainInvokeEvent } from "electron"
import type { MainHandlers } from "./ipc/router"
import { RpcError } from "./sidecar/RpcClient"

export type ShellKind = "cmd" | "sh"

export const shellOf = (platform: NodeJS.Platform): ShellKind =>
  platform === "win32" ? "cmd" : "sh"

/** cmd.exe accepts 8191 characters; sh a good deal more per argument. */
export const MAX_EXPANDED_CHARS: Record<ShellKind, number> = { cmd: 8000, sh: 120_000 }

/** A refusal the commander shows as a message (details.reason). */
const refused = (reason: string, message: string): RpcError =>
  new RpcError("PERMISSION_DENIED", message, false, { reason })

const invalid = (reason: string, message: string): RpcError =>
  new RpcError("INVALID_ARGUMENT", message, false, { reason })

// Quoting -------------------------------------------------------------------

/** sh: one word, whatever it holds. A single quote ends the string, is escaped, and starts it again. */
export function quoteSh(value: string): string {
  if (value.includes("\0")) throw invalid("name", "a name contains a NUL character")
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * cmd.exe: the value never becomes command text. Inside quotes cmd still
 * expands "%NAME%", and nothing escapes a percent sign on a command line, so
 * the value travels in an environment variable that the text names. cmd
 * replaces the reference once and does not read the result again: "&", "%",
 * "^" and "!" in a name stay characters (delayed expansion is off, /v:off).
 *
 * Backslashes before the closing quote are doubled, or the program would
 * read \" as an escaped quote (C:\ becomes "C:\\").
 */
export function quoteCmd(value: string, env: Record<string, string>): string {
  // No Windows file name holds these; they would end the quoted text.
  if (/["\r\n\0]/.test(value)) throw invalid("name", "a name contains a quote or a line break")
  if (value === "") return '""'
  const name = `PANELYTH_ARG${Object.keys(env).length}`
  env[name] = value.replace(/\\+$/, (tail) => tail + tail)
  return `"%${name}%"`
}

/** A name a program could read as an option ("-rf") is passed as a path (./-rf). */
export function safeName(shell: ShellKind, name: string): string {
  return name.startsWith("-") ? `.${shell === "cmd" ? "\\" : "/"}${name}` : name
}

// Placeholders --------------------------------------------------------------

type ValueKey = "P" | "T" | "N" | "L"

export type TemplatePart =
  | { kind: "text"; text: string }
  /** %P, %T, %N, %L; neighbours are one argument (%P%N is the cursor entry's path). */
  | { kind: "value"; keys: ValueKey[] }
  /** %S: one argument per marked name. */
  | { kind: "names" }

/** "%NAME%" with a name of two or more characters is the shell's own variable, not ours. */
const ENV_REFERENCE = /^%[A-Za-z_][A-Za-z0-9_()]+%/

export function parseTemplate(template: string): TemplatePart[] {
  const parts: TemplatePart[] = []
  let text = ""
  /** Whether the last part can take another key: nothing was written after it. */
  let open = false
  const flush = (): void => {
    if (text !== "") parts.push({ kind: "text", text })
    text = ""
  }
  for (let i = 0; i < template.length;) {
    const next = template[i + 1]
    if (template[i] !== "%" || next === undefined) {
      text += template[i]
      open = false
      i++
    } else if (next === "%") {
      text += "%"
      open = false
      i += 2
    } else if (ENV_REFERENCE.test(template.slice(i))) {
      const reference = ENV_REFERENCE.exec(template.slice(i))![0]
      text += reference
      open = false
      i += reference.length
    } else if (next === "P" || next === "T" || next === "N" || next === "L") {
      const last = parts.at(-1)
      if (open && last?.kind === "value") last.keys.push(next)
      else {
        flush()
        parts.push({ kind: "value", keys: [next] })
      }
      open = true
      i += 2
    } else if (next === "S") {
      flush()
      parts.push({ kind: "names" })
      open = false
      i += 2
    } else {
      text += "%"
      open = false
      i++
    }
  }
  flush()
  return unquoted(parts)
}

/** "%P%N" written inside quotes: the quotes go, the value brings its own. */
function unquoted(parts: TemplatePart[]): TemplatePart[] {
  for (let i = 1; i < parts.length - 1; i++) {
    const before = parts[i - 1]!
    const after = parts[i + 1]!
    if (parts[i]!.kind !== "value" || before.kind !== "text" || after.kind !== "text") continue
    const quote = before.text.at(-1)
    if ((quote !== '"' && quote !== "'") || after.text[0] !== quote) continue
    before.text = before.text.slice(0, -1)
    after.text = after.text.slice(1)
  }
  return parts.filter((p) => p.kind !== "text" || p.text !== "")
}

export interface TemplateNeeds {
  other: boolean
  cursor: boolean
  names: boolean
  listFile: boolean
}

export function templateNeeds(parts: readonly TemplatePart[]): TemplateNeeds {
  const has = (key: ValueKey): boolean =>
    parts.some((p) => p.kind === "value" && p.keys.includes(key))
  return {
    other: has("T"),
    cursor: has("N"),
    names: parts.some((p) => p.kind === "names"),
    listFile: has("L"),
  }
}

export interface ToolValues {
  /** Folders end with a separator, so %P%N is a path. */
  P: string
  T: string | null
  N: string | null
  L: string | null
  names: readonly string[] | null
}

/** The command text for a shell; `env` receives what cmd.exe reads its values from. */
export function expandTemplate(
  shell: ShellKind,
  parts: readonly TemplatePart[],
  values: ToolValues,
  env: Record<string, string>,
): string {
  const quote = (value: string): string => (shell === "cmd" ? quoteCmd(value, env) : quoteSh(value))
  let out = ""
  let length = 0
  for (const part of parts) {
    if (part.kind === "text") {
      out += part.text
      length += part.text.length
      continue
    }
    const words =
      part.kind === "names"
        ? (values.names ?? []).map((name) => safeName(shell, name))
        : [
            part.keys
              .map((key, i) => {
                const value = values[key]
                if (value === null) throw invalid("noEntry", "the command needs an entry")
                // A name alone is an argument; after a folder it is part of a path.
                return key === "N" && i === 0 ? safeName(shell, value) : value
              })
              .join(""),
          ]
    out += words.map(quote).join(" ")
    length += words.reduce((n, w) => n + w.length + 3, 0)
  }
  if (length > MAX_EXPANDED_CHARS[shell]) {
    throw invalid("tooLong", "the command is too long; pass the marked files with %L")
  }
  return out
}

// Starting ------------------------------------------------------------------

/** How a command is started. `env` is added to the app's environment. */
export interface Invocation {
  file: string
  args: string[]
  cwd: string
  env: Record<string, string>
  /** Windows: the arguments are passed as written (cmd.exe has its own quoting rules). */
  verbatim: boolean
  /** Windows: no console window for the shell itself. */
  hidden: boolean
}

export interface InvocationOptions {
  cwd: string
  /** A console window that stays open. */
  console: boolean
  env?: Record<string, string>
  /** The app's environment (SystemRoot, TERMINAL). */
  processEnv: NodeJS.ProcessEnv
}

/**
 * cmd.exe by its full path. A bare "cmd.exe" would be searched in the
 * command's working folder first, which is the folder the user is browsing.
 */
export function cmdPath(processEnv: NodeJS.ProcessEnv): string {
  const root = processEnv.SystemRoot ?? processEnv.windir
  const base = root && win32.isAbsolute(root) ? root : "C:\\Windows"
  return win32.join(base, "System32", "cmd.exe")
}

const appleScriptString = (text: string): string =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`

export function invocation(
  platform: NodeJS.Platform,
  command: string,
  options: InvocationOptions,
): Invocation {
  const { cwd, processEnv } = options
  const env = { ...options.env }
  if (platform === "win32") {
    const cmd = cmdPath(processEnv)
    if (!options.console) {
      // /d: no AutoRun commands; /v:off: "!" is a character; /s /c "...": the
      // outer quotes go and the rest runs exactly as written.
      return {
        file: cmd,
        args: ["/d", "/v:off", "/s", "/c", `"${command}"`],
        cwd,
        env,
        verbatim: true,
        hidden: true,
      }
    }
    if (command === "") {
      // A console in the folder and nothing else: the user's own cmd.exe, with
      // whatever they set it up to start with.
      return {
        file: cmd,
        args: ["/d", "/v:on", "/s", "/c", `"start "Panelyth Commander" "!PANELYTH_SHELL!""`],
        cwd,
        env: { ...env, PANELYTH_SHELL: cmd },
        verbatim: true,
        hidden: true,
      }
    }
    // A hidden cmd.exe starts a visible one that stays open (/k). The command
    // reaches it through delayed expansion ("!NAME!"), which happens after the
    // outer cmd.exe split its line: no character of the command is read twice.
    return {
      file: cmd,
      args: [
        "/d",
        "/v:on",
        "/s",
        "/c",
        `"start "Panelyth Commander" "!PANELYTH_SHELL!" /d /v:off /s /k "!PANELYTH_RUN!""`,
      ],
      cwd,
      env: { ...env, PANELYTH_SHELL: cmd, PANELYTH_RUN: command },
      verbatim: true,
      hidden: true,
    }
  }
  if (!options.console) {
    return { file: "/bin/sh", args: ["-c", command], cwd, env, verbatim: false, hidden: false }
  }
  const terminal = processEnv.TERMINAL
  const emulator = terminal && posix.isAbsolute(terminal) ? terminal : "x-terminal-emulator"
  if (command === "") {
    // A terminal in the folder and nothing else.
    return platform === "darwin"
      ? {
          file: "/usr/bin/open",
          args: ["-a", "Terminal", cwd],
          cwd,
          env,
          verbatim: false,
          hidden: false,
        }
      : { file: emulator, args: [], cwd, env, verbatim: false, hidden: false }
  }
  // The command, then the user's shell, so the window stays open.
  const script = `${command}\nexec "\${SHELL:-/bin/sh}"`
  if (platform === "darwin") {
    return {
      file: "/usr/bin/osascript",
      args: [
        "-e",
        `tell application "Terminal" to do script ${appleScriptString(`cd ${quoteSh(cwd)} && ${command}`)}`,
        "-e",
        'tell application "Terminal" to activate',
      ],
      cwd,
      env,
      verbatim: false,
      hidden: false,
    }
  }
  return {
    file: emulator,
    args: ["-e", "/bin/sh", "-c", script],
    cwd,
    env,
    verbatim: false,
    hidden: false,
  }
}

/**
 * Windows: the program a command names without a folder, when a file of that
 * name is in the working folder. cmd.exe would run that file instead of the
 * one on PATH; a user command must not start what happens to lie in the
 * folder being browsed.
 */
export async function shadowedProgram(
  command: string,
  cwd: string,
  processEnv: NodeJS.ProcessEnv,
  exists: (path: string) => Promise<boolean>,
): Promise<string | null> {
  const text = command.trimStart()
  const quoted = text.startsWith('"')
  const end = quoted ? text.indexOf('"', 1) : text.search(/[\s&|<>()^]/)
  const program = quoted
    ? text.slice(1, end < 0 ? undefined : end)
    : end < 0
      ? text
      : text.slice(0, end)
  if (program === "" || /[\\/:%]/.test(program)) return null
  const extensions = (processEnv.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((e) => /^\.[A-Za-z0-9]{1,8}$/.test(e))
    .slice(0, 16)
  const candidates = [program, ...extensions.map((e) => program + e)]
  const found = await Promise.all(candidates.map((name) => exists(win32.join(cwd, name))))
  const hit = found.indexOf(true)
  return hit < 0 ? null : candidates[hit]!
}

/**
 * Starts a command and lets it go: nothing is read from it, and what it
 * starts outlives the app. Resolves once the shell process exists.
 */
export function startInvocation(
  start: Invocation,
  processEnv: NodeJS.ProcessEnv = process.env,
): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(start.file, start.args, {
      cwd: start.cwd,
      env: { ...processEnv, ...start.env },
      stdio: "ignore",
      shell: false,
      windowsVerbatimArguments: start.verbatim,
      windowsHide: start.hidden,
      // Its own session elsewhere. On Windows the shell keeps its (hidden)
      // console: a detached cmd.exe has none, and every console program it
      // starts would open a window of its own. The programs it starts are not
      // tied to the app either way; only a shell still waiting ends with it.
      detached: process.platform !== "win32",
    })
    child.once("error", reject)
    child.once("spawn", () => {
      child.unref()
      resolve(child)
    })
  })
}

const LIST_MAX_AGE_MS = 24 * 60 * 60 * 1000

/**
 * The %L file: the full paths, one per line, UTF-8. A program started
 * detached may read it at any time, so lists are removed a day later (on the
 * next use) instead of when the command ends.
 */
export async function writeListFile(
  dir: string,
  paths: readonly string[],
  now = Date.now(),
): Promise<string> {
  await mkdir(dir, { recursive: true })
  const old = await readdir(dir).catch(() => [] as string[])
  await Promise.all(
    old.slice(0, 256).map(async (name) => {
      const file = join(dir, name)
      const age = await stat(file).then(
        (s) => now - s.mtimeMs,
        () => 0,
      )
      if (age > LIST_MAX_AGE_MS) await rm(file, { force: true }).catch(() => undefined)
    }),
  )
  const file = join(dir, `list-${randomUUID()}.txt`)
  // A new file of the user's own: never an existing one, never a link.
  await writeFile(file, paths.join(EOL) + EOL, { encoding: "utf8", flag: "wx", mode: 0o600 })
  return file
}

// Handlers ------------------------------------------------------------------

export interface ShellRunDeps {
  call<M extends "entry.path" | "selection.paths" | "library.get">(
    method: M,
    params: SidecarMethodMap[M]["params"],
  ): Promise<SidecarMethodMap[M]["result"]>
  /** Starts the command; in test mode it is recorded instead. */
  start(invocation: Invocation): Promise<void>
  /** The call comes from the commander's own view while that view is shown. */
  allowed(event: IpcMainInvokeEvent): boolean
  /** Main logs every command (ADR-0027). */
  log(message: string, fields: Record<string, unknown>): void
  /** Writes the %L file (one full path per line) and returns its path. */
  writeList(paths: readonly string[]): Promise<string>
  isDir(path: string): Promise<boolean>
  exists(path: string): Promise<boolean>
  platform: NodeJS.Platform
  processEnv: NodeJS.ProcessEnv
}

type ShellRunMethod = "shell.run" | "shell.runTool"

const LOGGED_CHARS = 500

export function shellRunHandlers(deps: ShellRunDeps): Pick<MainHandlers, ShellRunMethod> {
  const path = deps.platform === "win32" ? win32 : posix
  const shell = shellOf(deps.platform)

  const guard = (event: IpcMainInvokeEvent): void => {
    if (!deps.allowed(event)) {
      throw refused("hidden", "commands run from the commander's own window while it is shown")
    }
  }

  /** A folder id as a path (the sidecar resolves it; the renderer never sends one). */
  const folder = async (dirId: number): Promise<string> => {
    const { path: dir, kind } = await deps.call("entry.path", { entryId: dirId })
    if (kind !== "dir") throw refused("folder", "commands run in a folder")
    return dir
  }

  /** cmd.exe cannot start in a network folder (it would fall back to the Windows folder). */
  const workingFolder = (dir: string): string => {
    if (shell === "cmd" && /^[\\/]{2}/.test(dir)) {
      throw refused("unc", "cmd.exe cannot run in a network folder; map it to a drive letter")
    }
    return dir
  }

  const withSeparator = (dir: string): string =>
    dir.endsWith(path.sep) || dir.endsWith("/") ? dir : dir + path.sep

  const run = async (
    what: ShellRunMethod,
    command: string,
    cwd: string,
    console: boolean,
    env: Record<string, string>,
    tool?: UserCommand,
  ): Promise<void> => {
    const start = invocation(deps.platform, command, {
      cwd,
      console,
      env,
      processEnv: deps.processEnv,
    })
    deps.log(what, {
      command: command.slice(0, LOGGED_CHARS),
      cwd,
      console,
      ...(tool && { tool: tool.id, title: tool.title }),
    })
    await deps.start(start)
  }

  return {
    "shell.run": async (event, { command, dirId, console }) => {
      guard(event)
      const text = command.trim()
      // An empty line with the console flag opens a console in the folder.
      if (text === "" && console !== true) throw invalid("empty", "there is no command to run")
      const cwd = workingFolder(await folder(dirId))
      await run("shell.run", text, cwd, console === true, {})
      return { ok: true }
    },

    "shell.runTool": async (event, { toolId, dirId, otherDirId, cursorId, selection }) => {
      guard(event)
      // The program and its parameters come from library.db, never from the call.
      const { settings } = await deps.call("library.get", {})
      const tool = readUserCommands(settings[COMMANDER_TOOLS_KEY]).find((c) => c.id === toolId)
      if (!tool) throw new RpcError("NOT_FOUND", "this command no longer exists", false)

      const parts = parseTemplate(tool.params ? `${tool.command} ${tool.params}` : tool.command)
      const needs = templateNeeds(parts)
      const panel = await folder(dirId)
      const values: ToolValues = { P: withSeparator(panel), T: null, N: null, L: null, names: null }
      if (needs.other) {
        if (otherDirId === undefined) throw invalid("noOther", "the other panel has no folder")
        values.T = withSeparator(await folder(otherDirId))
      }
      if (needs.cursor) {
        if (cursorId === undefined) throw invalid("noEntry", "there is no entry under the cursor")
        values.N = path.basename((await deps.call("entry.path", { entryId: cursorId })).path)
      }
      if (needs.names || needs.listFile) {
        if (!selection) throw invalid("noEntry", "there is no entry to run the command on")
        const { paths, truncated } = await deps.call("selection.paths", { selection, limit: 0 })
        if (truncated) throw invalid("tooMany", "too many entries are marked for this command")
        if (paths.length === 0) throw invalid("noEntry", "there is no entry to run the command on")
        if (needs.names) values.names = paths.map((p) => path.basename(p))
        if (needs.listFile) values.L = await deps.writeList(paths)
      }

      let cwd = panel
      if (tool.dir !== "") {
        if (!path.isAbsolute(tool.dir) || !(await deps.isDir(tool.dir))) {
          throw refused("dir", `the working folder was not found: ${tool.dir}`)
        }
        cwd = tool.dir
      }
      workingFolder(cwd)

      const env: Record<string, string> = {}
      const command = expandTemplate(shell, parts, values, env)
      if (shell === "cmd") {
        const shadow = await shadowedProgram(command, cwd, deps.processEnv, deps.exists)
        if (shadow) {
          throw refused(
            "shadowed",
            `this folder has a file named ${shadow}, which would run instead; give the command its full path`,
          )
        }
      }
      await run("shell.runTool", command, cwd, tool.console, env, tool)
      return { ok: true }
    },
  }
}
