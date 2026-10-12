import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { EOL, tmpdir } from "node:os"
import { join } from "node:path"
import type { IpcMainInvokeEvent } from "electron"
import { describe, expect, it, vi } from "vitest"
import {
  cmdPath,
  expandTemplate,
  invocation,
  parseTemplate,
  quoteCmd,
  quoteSh,
  safeName,
  shadowedProgram,
  shellRunHandlers,
  startInvocation,
  templateNeeds,
  writeListFile,
  type Invocation,
  type ShellRunDeps,
  type ToolValues,
} from "../src/main/shellRun"
import { RpcError } from "../src/main/sidecar/RpcClient"

vi.mock("electron", () => ({}))

const ev = {} as IpcMainInvokeEvent
const sel = {
  queryId: 1,
  version: 1,
  ranges: [[0, 2]] as [number, number][],
  include: [],
  exclude: [],
}
const WIN_ENV = { SystemRoot: "C:\\Windows", PATHEXT: ".COM;.EXE;.BAT;.CMD" }
const tools = (commands: object[]) => ({ "commander.tools": { v: 1, commands } })
const tool = (over: object = {}) => ({
  id: "t1",
  title: "Tool",
  command: "tool",
  params: "",
  dir: "",
  icon: "tool",
  menu: false,
  console: false,
  ...over,
})

// Names a file manager meets in a hostile folder.
const HOSTILE_WINDOWS = [
  "a&b.txt",
  "100% sure %PATH% %COMSPEC%.txt",
  "^caret^ !bang! (paren).txt",
  "it's & calc.exe | more > x < y.txt",
  "sp ace;semi,comma=eq.txt",
  "%PANELYTH_ARG0%",
  "&& shutdown -s",
]
const HOSTILE_UNIX = [
  "a'b\"c.txt",
  "$HOME `id` $(id).txt",
  "back\\slash * ? ~ ; | & > <.txt",
  "line\nbreak\ttab.txt",
  "'; rm -rf ~; echo '",
  "!bang! %percent%.txt",
]

describe("quoting", () => {
  it("sh: a name is one word, whatever it holds", () => {
    expect(quoteSh("plain")).toBe("'plain'")
    expect(quoteSh("it's")).toBe(`'it'\\''s'`)
    expect(quoteSh("$(id) `id` $HOME")).toBe("'$(id) `id` $HOME'")
    expect(quoteSh("")).toBe("''")
    expect(() => quoteSh("a\0b")).toThrow(RpcError)
  })

  it("cmd: a name never becomes command text", () => {
    const env: Record<string, string> = {}
    for (const name of HOSTILE_WINDOWS) {
      const text = quoteCmd(name, env)
      // The text names a variable; nothing of the name is in it.
      expect(text).toMatch(/^"%PANELYTH_ARG\d+%"$/)
    }
    expect(Object.values(env)).toEqual(HOSTILE_WINDOWS)
    // A folder's last backslash would escape the closing quote for the program.
    expect(quoteCmd("C:\\", env)).toBe(`"%PANELYTH_ARG${HOSTILE_WINDOWS.length}%"`)
    expect(env[`PANELYTH_ARG${HOSTILE_WINDOWS.length}`]).toBe("C:\\\\")
    expect(quoteCmd("", {})).toBe('""')
    for (const bad of ['a"b', "a\nb", "a\rb", "a\0b"]) {
      expect(() => quoteCmd(bad, {}), JSON.stringify(bad)).toThrow(RpcError)
    }
  })

  it("passes a name that looks like an option as a path", () => {
    expect(safeName("sh", "-rf")).toBe("./-rf")
    expect(safeName("cmd", "--help")).toBe(".\\--help")
    expect(safeName("sh", "a-b")).toBe("a-b")
  })
})

describe("placeholders", () => {
  it("finds the placeholders and joins neighbours into one argument", () => {
    expect(parseTemplate("prog %P%N -o %T %S %L")).toEqual([
      { kind: "text", text: "prog " },
      { kind: "value", keys: ["P", "N"] },
      { kind: "text", text: " -o " },
      { kind: "value", keys: ["T"] },
      { kind: "text", text: " " },
      { kind: "names" },
      { kind: "text", text: " " },
      { kind: "value", keys: ["L"] },
    ])
    // Text between two placeholders keeps them apart.
    expect(parseTemplate("%P %N")).toEqual([
      { kind: "value", keys: ["P"] },
      { kind: "text", text: " " },
      { kind: "value", keys: ["N"] },
    ])
  })

  it("leaves the shell's variables, %% and unknown letters alone", () => {
    expect(parseTemplate("echo %PATH% %TEMP%\\x %USERPROFILE%")).toEqual([
      { kind: "text", text: "echo %PATH% %TEMP%\\x %USERPROFILE%" },
    ])
    expect(parseTemplate("100%% of %X and %")).toEqual([{ kind: "text", text: "100% of %X and %" }])
    // A one-letter name between percent signs is ours: %P%N.
    expect(templateNeeds(parseTemplate("%N%T"))).toMatchObject({ cursor: true, other: true })
  })

  it("drops quotes written around a placeholder", () => {
    expect(parseTemplate('open "%P%N" now')).toEqual([
      { kind: "text", text: "open " },
      { kind: "value", keys: ["P", "N"] },
      { kind: "text", text: " now" },
    ])
    expect(parseTemplate("'%N'")).toEqual([{ kind: "value", keys: ["N"] }])
    // Quotes that do not match stay.
    expect(parseTemplate('"%N')).toEqual([
      { kind: "text", text: '"' },
      { kind: "value", keys: ["N"] },
    ])
  })

  it("says what a command needs", () => {
    expect(templateNeeds(parseTemplate("x %P"))).toEqual({
      other: false,
      cursor: false,
      names: false,
      listFile: false,
    })
    expect(templateNeeds(parseTemplate("x %S %L %T %N"))).toEqual({
      other: true,
      cursor: true,
      names: true,
      listFile: true,
    })
  })

  const values: ToolValues = {
    P: "/home/me/My Files/",
    T: "/mnt/other/",
    N: "it's.txt",
    L: "/tmp/list.txt",
    names: ["a b.txt", "-rf", "$(id).txt"],
  }

  it("expands for sh", () => {
    const env = {}
    expect(expandTemplate("sh", parseTemplate("tool %P%N --to=%T %S %L"), values, env)).toBe(
      `tool '/home/me/My Files/it'\\''s.txt' --to='/mnt/other/' 'a b.txt' './-rf' '$(id).txt' '/tmp/list.txt'`,
    )
    expect(env).toEqual({})
    // A name alone is an argument: an option-like name becomes a path.
    expect(expandTemplate("sh", parseTemplate("rm %N"), { ...values, N: "-rf" }, {})).toBe(
      "rm './-rf'",
    )
  })

  it("expands for cmd through environment variables", () => {
    const env: Record<string, string> = {}
    const win: ToolValues = {
      P: "C:\\My Files\\",
      T: "D:\\",
      N: "100% & more.txt",
      L: "C:\\Temp\\list.txt",
      names: ["a&b.txt", "-x"],
    }
    expect(expandTemplate("cmd", parseTemplate("tool %P%N %T %S %L"), win, env)).toBe(
      'tool "%PANELYTH_ARG0%" "%PANELYTH_ARG1%" "%PANELYTH_ARG2%" "%PANELYTH_ARG3%" "%PANELYTH_ARG4%"',
    )
    expect(env).toEqual({
      PANELYTH_ARG0: "C:\\My Files\\100% & more.txt",
      PANELYTH_ARG1: "D:\\\\",
      PANELYTH_ARG2: "a&b.txt",
      PANELYTH_ARG3: ".\\-x",
      PANELYTH_ARG4: "C:\\Temp\\list.txt",
    })
  })

  it("refuses a missing entry and a command that is too long", () => {
    expect(() => expandTemplate("sh", parseTemplate("x %N"), { ...values, N: null }, {})).toThrow(
      /needs an entry/,
    )
    const many = { ...values, names: Array.from({ length: 2000 }, (_, i) => `file-${i}.txt`) }
    expect(() => expandTemplate("cmd", parseTemplate("x %S"), many, {})).toThrow(/too long/)
    expect(() => expandTemplate("sh", parseTemplate("x %S"), many, {})).not.toThrow()
  })
})

describe("invocation", () => {
  it("runs cmd.exe by its full path, with the command as written", () => {
    const start = invocation("win32", 'echo "a & b" > out.txt', {
      cwd: "C:\\work",
      console: false,
      processEnv: WIN_ENV,
    })
    expect(start).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", '"echo "a & b" > out.txt"'],
      cwd: "C:\\work",
      env: {},
      verbatim: true,
      hidden: true,
    })
    // A bare or relative SystemRoot is not trusted.
    expect(cmdPath({ SystemRoot: "evil" })).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(cmdPath({})).toBe("C:\\Windows\\System32\\cmd.exe")
  })

  it("opens a console that stays, without the command in the outer line", () => {
    const start = invocation("win32", 'dir "a & b" & echo !x!', {
      cwd: "C:\\work",
      console: true,
      env: { PANELYTH_ARG0: "v" },
      processEnv: WIN_ENV,
    })
    expect(start.file).toBe("C:\\Windows\\System32\\cmd.exe")
    expect(start.args.slice(0, 4)).toEqual(["/d", "/v:on", "/s", "/c"])
    expect(start.args[4]).toBe(
      '"start "Panelyth Commander" "!PANELYTH_SHELL!" /d /v:off /s /k "!PANELYTH_RUN!""',
    )
    expect(start.env).toEqual({
      PANELYTH_ARG0: "v",
      PANELYTH_SHELL: "C:\\Windows\\System32\\cmd.exe",
      PANELYTH_RUN: 'dir "a & b" & echo !x!',
    })
  })

  it("opens a console in the folder for an empty line, and runs nothing", () => {
    const win = invocation("win32", "", { cwd: "C:\\work", console: true, processEnv: WIN_ENV })
    expect(win).toEqual({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:on", "/s", "/c", '"start "Panelyth Commander" "!PANELYTH_SHELL!""'],
      cwd: "C:\\work",
      env: { PANELYTH_SHELL: "C:\\Windows\\System32\\cmd.exe" },
      verbatim: true,
      hidden: true,
    })
    expect(invocation("linux", "", { cwd: "/data", console: true, processEnv: {} })).toEqual({
      file: "x-terminal-emulator",
      args: [],
      cwd: "/data",
      env: {},
      verbatim: false,
      hidden: false,
    })
    expect(
      invocation("darwin", "", { cwd: "/Users/me/a b", console: true, processEnv: {} }),
    ).toEqual({
      file: "/usr/bin/open",
      args: ["-a", "Terminal", "/Users/me/a b"],
      cwd: "/Users/me/a b",
      env: {},
      verbatim: false,
      hidden: false,
    })
  })

  it("runs /bin/sh elsewhere, and a terminal for the console", () => {
    expect(
      invocation("linux", "ls -la | wc -l", { cwd: "/data", console: false, processEnv: {} }),
    ).toEqual({
      file: "/bin/sh",
      args: ["-c", "ls -la | wc -l"],
      cwd: "/data",
      env: {},
      verbatim: false,
      hidden: false,
    })
    const term = invocation("linux", "make", { cwd: "/data", console: true, processEnv: {} })
    expect(term.file).toBe("x-terminal-emulator")
    expect(term.args).toEqual(["-e", "/bin/sh", "-c", 'make\nexec "${SHELL:-/bin/sh}"'])
    // TERMINAL is used only as a full path.
    expect(
      invocation("linux", "make", {
        cwd: "/data",
        console: true,
        processEnv: { TERMINAL: "/usr/bin/kitty" },
      }).file,
    ).toBe("/usr/bin/kitty")
    expect(
      invocation("linux", "make", { cwd: "/d", console: true, processEnv: { TERMINAL: "kitty" } })
        .file,
    ).toBe("x-terminal-emulator")
    const mac = invocation("darwin", 'echo "hi"', {
      cwd: "/Users/me/it's",
      console: true,
      processEnv: {},
    })
    expect(mac.file).toBe("/usr/bin/osascript")
    expect(mac.args[1]).toBe(
      `tell application "Terminal" to do script "cd '/Users/me/it'\\\\''s' && echo \\"hi\\""`,
    )
  })

  it("finds a program of the working folder that would run instead", async () => {
    const present = new Set(["C:\\dl\\git.BAT", "C:\\dl\\setup.exe", "C:\\dl\\my tool.CMD"])
    const exists = async (p: string): Promise<boolean> => present.has(p)
    const shadow = (command: string) => shadowedProgram(command, "C:\\dl", WIN_ENV, exists)
    expect(await shadow("git status")).toBe("git.BAT")
    expect(await shadow("  setup.exe /S")).toBe("setup.exe")
    expect(await shadow('"my tool" x')).toBe("my tool.CMD")
    expect(await shadow("git&&echo x")).toBe("git.BAT")
    // A path, a drive or a variable names its own place.
    expect(await shadow(".\\git status")).toBeNull()
    expect(await shadow('"C:\\Program Files\\Git\\git.exe" status')).toBeNull()
    expect(await shadow("%ProgramFiles%\\x.exe")).toBeNull()
    expect(await shadow("notepad x.txt")).toBeNull()
  })
})

interface Calls {
  started: Invocation[]
  logged: [string, Record<string, unknown>][]
}

function setup(over: Partial<ShellRunDeps> = {}, settings: Record<string, unknown> = {}) {
  const calls: Calls = { started: [], logged: [] }
  const paths: Record<number, { path: string; kind: string }> = {
    10: { path: "/data/My Files", kind: "dir" },
    11: { path: "/mnt/other", kind: "dir" },
    20: { path: "/data/My Files/it's.txt", kind: "file" },
  }
  const call = vi.fn(async (method: string, params: { entryId?: number }) => {
    if (method === "library.get") return { settings, bookmarks: [], recent: [] }
    if (method === "selection.paths") {
      return { paths: ["/data/My Files/a b.txt", "/data/My Files/-rf"], truncated: false }
    }
    const entry = paths[params.entryId ?? 0]
    if (!entry) throw new RpcError("NOT_FOUND", "not in the index")
    return { ...entry, program: false }
  })
  const deps: ShellRunDeps = {
    call: call as unknown as ShellRunDeps["call"],
    start: async (start) => void calls.started.push(start),
    allowed: () => true,
    log: (message, fields) => void calls.logged.push([message, fields]),
    writeList: vi.fn(async () => "/tmp/list-1.txt"),
    isDir: vi.fn(async (p: string) => p === "/opt/work"),
    exists: vi.fn(async () => false),
    platform: "linux",
    processEnv: {},
    ...over,
  }
  return { deps, calls, call, h: shellRunHandlers(deps) }
}

describe("shell.run", () => {
  it("runs the typed line in the folder the sidecar resolved, and logs it", async () => {
    const { h, calls, call } = setup()
    await expect(
      h["shell.run"](ev, { command: "  ls -la  ", dirId: 10 }, "commander"),
    ).resolves.toEqual({ ok: true })
    expect(call).toHaveBeenCalledWith("entry.path", { entryId: 10 })
    expect(calls.started).toEqual([
      {
        file: "/bin/sh",
        args: ["-c", "ls -la"],
        cwd: "/data/My Files",
        env: {},
        verbatim: false,
        hidden: false,
      },
    ])
    expect(calls.logged).toEqual([
      ["shell.run", { command: "ls -la", cwd: "/data/My Files", console: false }],
    ])
  })

  it("runs nothing from another window or while the commander is hidden", async () => {
    const { h, calls, call } = setup({ allowed: () => false })
    await expect(
      h["shell.run"](ev, { command: "ls", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({
      code: "PERMISSION_DENIED",
      details: { reason: "hidden" },
    })
    await expect(
      h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED" })
    expect(call).not.toHaveBeenCalled()
    expect(calls.started).toEqual([])
    expect(calls.logged).toEqual([])
  })

  it("needs a folder that exists, and a command", async () => {
    const { h, calls } = setup()
    await expect(
      h["shell.run"](ev, { command: "ls", dirId: 20 }, "commander"),
    ).rejects.toMatchObject({
      details: { reason: "folder" },
    })
    await expect(
      h["shell.run"](ev, { command: "ls", dirId: 99 }, "commander"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    })
    await expect(
      h["shell.run"](ev, { command: "   ", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({
      code: "INVALID_ARGUMENT",
    })
    expect(calls.started).toEqual([])
  })

  it("refuses a network folder for cmd.exe", async () => {
    const call = vi.fn(async () => ({ path: "\\\\nas\\share\\x", kind: "dir", program: false }))
    const { h, calls } = setup({
      platform: "win32",
      processEnv: WIN_ENV,
      call: call as unknown as ShellRunDeps["call"],
    })
    await expect(
      h["shell.run"](ev, { command: "dir", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({
      details: { reason: "unc" },
    })
    expect(calls.started).toEqual([])
  })

  it("opens a console when asked", async () => {
    const { h, calls } = setup()
    await h["shell.run"](ev, { command: "top", dirId: 10, console: true }, "commander")
    expect(calls.started[0]!.file).toBe("x-terminal-emulator")
    expect(calls.logged[0]![1]).toMatchObject({ console: true })
  })

  it("an empty line with the console flag opens a console; without it nothing starts", async () => {
    const { h, calls } = setup()
    await expect(
      h["shell.run"](ev, { command: "  ", dirId: 10, console: true }, "commander"),
    ).resolves.toEqual({ ok: true })
    expect(calls.started).toEqual([
      {
        file: "x-terminal-emulator",
        args: [],
        cwd: "/data/My Files",
        env: {},
        verbatim: false,
        hidden: false,
      },
    ])
    expect(calls.logged).toEqual([
      ["shell.run", { command: "", cwd: "/data/My Files", console: true }],
    ])
    await expect(
      h["shell.run"](ev, { command: "", dirId: 10, console: false }, "commander"),
    ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "empty" } })
    expect(calls.started).toHaveLength(1)
  })
})

describe("shell.runTool", () => {
  it("reads the command from library.db and fills it from ids", async () => {
    const { h, calls, deps } = setup(
      {},
      tools([tool({ command: "tool", params: '--in "%P%N" --to %T %S --list %L' })]),
    )
    await h["shell.runTool"](
      ev,
      { toolId: "t1", dirId: 10, otherDirId: 11, cursorId: 20, selection: sel },
      "commander",
    )
    expect(calls.started[0]).toMatchObject({
      file: "/bin/sh",
      args: [
        "-c",
        `tool --in '/data/My Files/it'\\''s.txt' --to '/mnt/other/' 'a b.txt' './-rf' --list '/tmp/list-1.txt'`,
      ],
      cwd: "/data/My Files",
    })
    expect(deps.writeList).toHaveBeenCalledWith(["/data/My Files/a b.txt", "/data/My Files/-rf"])
    expect(calls.logged[0]).toEqual([
      "shell.runTool",
      expect.objectContaining({ tool: "t1", title: "Tool", cwd: "/data/My Files" }),
    ])
  })

  it("asks the sidecar only for what the command uses", async () => {
    const { h, call, deps } = setup({}, tools([tool({ params: "%P" })]))
    await h["shell.runTool"](
      ev,
      { toolId: "t1", dirId: 10, otherDirId: 11, cursorId: 20, selection: sel },
      "commander",
    )
    expect(call.mock.calls.map((c) => c[0])).toEqual(["library.get", "entry.path"])
    expect(deps.writeList).not.toHaveBeenCalled()
  })

  it("knows only the commands stored in library.db", async () => {
    const { h, calls } = setup({}, tools([tool()]))
    await expect(
      h["shell.runTool"](ev, { toolId: "nope", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    // A stored value that is not a command list holds no commands.
    const broken = setup({}, { "commander.tools": { v: 1, commands: [{ id: "t1", command: 5 }] } })
    await expect(
      broken.h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" })
    expect(calls.started).toEqual([])
  })

  it("says what is missing", async () => {
    const need = async (params: string, call: object, reason: string): Promise<void> => {
      const { h, calls } = setup({}, tools([tool({ params })]))
      await expect(
        h["shell.runTool"](ev, { toolId: "t1", dirId: 10, ...call }, "commander"),
        params,
      ).rejects.toMatchObject({ code: "INVALID_ARGUMENT", details: { reason } })
      expect(calls.started).toEqual([])
    }
    await need("%N", {}, "noEntry")
    await need("%S", {}, "noEntry")
    await need("%L", {}, "noEntry")
    await need("%T", {}, "noOther")
    const truncated = setup(
      {
        call: vi.fn(async (method: string) =>
          method === "library.get"
            ? { settings: tools([tool({ params: "%S" })]) }
            : method === "selection.paths"
              ? { paths: ["/a"], truncated: true }
              : { path: "/data", kind: "dir", program: false },
        ) as unknown as ShellRunDeps["call"],
      },
      {},
    )
    await expect(
      truncated.h["shell.runTool"](ev, { toolId: "t1", dirId: 10, selection: sel }, "commander"),
    ).rejects.toMatchObject({ details: { reason: "tooMany" } })
  })

  it("uses the command's working folder when it names one that exists", async () => {
    const ok = setup({}, tools([tool({ dir: "/opt/work", console: true })]))
    await ok.h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander")
    expect(ok.calls.started[0]).toMatchObject({ cwd: "/opt/work", file: "x-terminal-emulator" })
    for (const dir of ["/gone", "relative/dir"]) {
      const bad = setup({}, tools([tool({ dir })]))
      await expect(
        bad.h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander"),
      ).rejects.toMatchObject({ details: { reason: "dir" } })
      expect(bad.calls.started).toEqual([])
    }
  })

  it("does not start a program that lies in the browsed folder under the command's name", async () => {
    const call = vi.fn(async (method: string) =>
      method === "library.get"
        ? { settings: tools([tool({ command: "git", params: "status" })]) }
        : { path: "C:\\Downloads", kind: "dir", program: false },
    )
    const exists = vi.fn(async (p: string) => p === "C:\\Downloads\\git.BAT")
    const { h, calls } = setup({
      platform: "win32",
      processEnv: WIN_ENV,
      call: call as unknown as ShellRunDeps["call"],
      exists,
    })
    await expect(
      h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander"),
    ).rejects.toMatchObject({ code: "PERMISSION_DENIED", details: { reason: "shadowed" } })
    expect(calls.started).toEqual([])
    exists.mockResolvedValue(false)
    await h["shell.runTool"](ev, { toolId: "t1", dirId: 10 }, "commander")
    expect(calls.started[0]).toMatchObject({
      file: "C:\\Windows\\System32\\cmd.exe",
      args: ["/d", "/v:off", "/s", "/c", '"git status"'],
      cwd: "C:\\Downloads",
    })
  })
})

describe("running for real", () => {
  const windows = process.platform === "win32"
  const dir = mkdtempSync(join(tmpdir(), "panelyth-shell-"))
  const script = join(dir, "argv.mjs")
  writeFileSync(
    script,
    `import { writeFileSync } from "node:fs"
writeFileSync(process.argv[2], JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd() }))
`,
  )
  const word = (text: string): string => (windows ? `"${text}"` : quoteSh(text))
  const hostile = windows ? HOSTILE_WINDOWS : HOSTILE_UNIX

  async function run(start: Invocation, out: string): Promise<{ argv: string[]; cwd: string }> {
    const child = await startInvocation(start)
    await new Promise<void>((resolve) => child.once("exit", () => resolve()))
    expect(existsSync(out), "the program ran").toBe(true)
    return JSON.parse(readFileSync(out, "utf8")) as { argv: string[]; cwd: string }
  }

  it("hands hostile names to the program unchanged", async () => {
    const out = join(dir, "tool.json")
    const template = `${word(process.execPath)} ${word(script)} ${word(out)} %P%N %T %S %L`
    const env: Record<string, string> = {}
    const sep = windows ? "\\" : "/"
    const values: ToolValues = {
      P: `${dir}${sep}`,
      T: windows ? "C:\\" : "/",
      N: hostile[0]!,
      L: join(dir, "list.txt"),
      names: [...hostile, "-rf"],
    }
    const command = expandTemplate(windows ? "cmd" : "sh", parseTemplate(template), values, env)
    const result = await run(
      invocation(process.platform, command, {
        cwd: dir,
        console: false,
        env,
        processEnv: process.env,
      }),
      out,
    )
    expect(result.argv).toEqual([
      `${dir}${sep}${hostile[0]}`,
      windows ? "C:\\" : "/",
      ...hostile,
      `.${sep}-rf`,
      join(dir, "list.txt"),
    ])
  })

  it("runs a typed line as the shell reads it, in the folder", async () => {
    const out = join(dir, "typed.json")
    const command = `${word(process.execPath)} ${word(script)} ${word(out)} ${word("a & b")} c`
    const result = await run(
      invocation(process.platform, command, { cwd: dir, console: false, processEnv: process.env }),
      out,
    )
    expect(result.argv).toEqual(["a & b", "c"])
    expect(result.cwd.toLowerCase()).toBe(dir.toLowerCase())
  })
})

// BENCH_STAGE=C10: what starting a command costs on this machine (the shell
// process appearing, and a command that does nothing ending).
describe.runIf(process.env.BENCH_STAGE === "C10")("command-line start cost", () => {
  it("measures the shell start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "panelyth-shell-bench-"))
    const noop = process.platform === "win32" ? "rem" : ":"
    const spawned: number[] = []
    const ended: number[] = []
    for (let i = 0; i < 35; i++) {
      const start = performance.now()
      const child = await startInvocation(
        invocation(process.platform, noop, { cwd: dir, console: false, processEnv: process.env }),
      )
      spawned.push(performance.now() - start)
      await new Promise<void>((resolve) => child.once("exit", () => resolve()))
      ended.push(performance.now() - start)
    }
    const stats = (all: number[]) => {
      const s = all.slice(5).sort((a, b) => a - b)
      const round = (n: number): number => Math.round(n * 100) / 100
      return {
        runs: s.length,
        medianMs: round(s[Math.floor(s.length / 2)]!),
        p95Ms: round(s[Math.floor(s.length * 0.95)]!),
        maxMs: round(s.at(-1)!),
      }
    }
    const result = {
      at: new Date().toISOString(),
      test: "shell-start",
      platform: process.platform,
      shell: process.platform === "win32" ? "cmd.exe" : "/bin/sh",
      processStarted: stats(spawned),
      emptyCommandEnded: stats(ended),
    }
    const out = join(
      __dirname,
      "..",
      "..",
      "bench",
      "results",
      `stage-C10-${result.at.slice(0, 10)}-shell-start.json`,
    )
    writeFileSync(out, JSON.stringify(result, null, 2) + "\n")
    console.log(JSON.stringify(result))
    expect(result.processStarted.runs).toBe(30)
  }, 120_000)
})

describe("the %L file", () => {
  it("lists the paths, one per line, and removes lists older than a day", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "panelyth-lists-")), "lists")
    const first = await writeListFile(dir, ["/a/one.txt", "/a/two words.txt"])
    expect(readFileSync(first, "utf8")).toBe(`/a/one.txt${EOL}/a/two words.txt${EOL}`)
    // Two days later the first list is gone and the new one is there.
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(first, old, old)
    const second = await writeListFile(dir, ["/b"])
    expect(second).not.toBe(first)
    expect(readdirSync(dir)).toHaveLength(1)
    expect(existsSync(second)).toBe(true)
  })
})
