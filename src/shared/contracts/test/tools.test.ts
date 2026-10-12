import { describe, expect, it } from "vitest"
import {
  isCommandText,
  MAX_COMMAND_CHARS,
  MAX_USER_COMMANDS,
  newToolId,
  readUserCommands,
} from "../src/tools"

// commander.tools is read by Electron main before it runs a user command
// (Stage C10, ADR-0027): whatever is stored, only well-formed commands come out.

const command = (over: object = {}) => ({
  id: "ab12",
  title: "Editor",
  command: "code",
  params: "%P%N",
  dir: "",
  icon: "edit",
  menu: true,
  console: false,
  ...over,
})

describe("user commands", () => {
  it("reads stored commands as they were saved", () => {
    expect(readUserCommands({ v: 1, commands: [command()] })).toEqual([command()])
  })

  it("falls back for what is missing and trims what was typed", () => {
    expect(
      readUserCommands({
        v: 1,
        commands: [{ id: "x1", title: "  ", command: "  notepad  ", params: 7, icon: "rocket" }],
      }),
    ).toEqual([
      {
        id: "x1",
        title: "notepad",
        command: "notepad",
        params: "",
        dir: "",
        icon: "tool",
        menu: false,
        console: false,
      },
    ])
  })

  it("leaves out anything that is not one command", () => {
    const bad = [
      null,
      "calc",
      command({ id: "" }),
      command({ id: "../x" }),
      command({ id: "UPPER" }),
      command({ id: "a".repeat(17) }),
      command({ command: "" }),
      command({ command: "   " }),
      command({ command: 5 }),
      command({ command: "a\nb" }),
      command({ command: "a\u0000b" }),
      command({ command: "x".repeat(MAX_COMMAND_CHARS + 1) }),
      command({ title: "a\tb" }),
      command({ title: "x".repeat(65) }),
    ]
    expect(readUserCommands({ v: 1, commands: bad })).toEqual([])
    // Parameters and the working folder with a line break are dropped, not the command.
    expect(
      readUserCommands({ v: 1, commands: [command({ params: "a\nb", dir: "C:\\\r\n" })] }),
    ).toEqual([command({ params: "", dir: "" })])
  })

  it("keeps the first of two commands with one id, and at most fifty", () => {
    expect(readUserCommands({ v: 1, commands: [command(), command({ title: "Second" })] })).toEqual(
      [command()],
    )
    const many = Array.from({ length: 80 }, (_, i) => command({ id: `c${i}` }))
    expect(readUserCommands({ v: 1, commands: many })).toHaveLength(MAX_USER_COMMANDS)
  })

  it("reads nothing from other shapes", () => {
    for (const value of [undefined, null, "x", 5, [], {}, { v: 2, commands: [command()] }]) {
      expect(readUserCommands(value)).toEqual([])
    }
    expect(readUserCommands({ v: 1, commands: "calc" })).toEqual([])
  })

  it("knows one line of text", () => {
    expect(isCommandText('git commit -m "a & b" > %TEMP%\\x')).toBe(true)
    expect(isCommandText("")).toBe(true)
    for (const bad of ["a\nb", "a\rb", "a\tb", "a\u0000b", "a\u007fb", 5, null]) {
      expect(isCommandText(bad), JSON.stringify(bad)).toBe(false)
    }
    expect(isCommandText("abc", 2)).toBe(false)
  })

  it("makes ids that main accepts and that are not taken", () => {
    const taken: string[] = []
    for (let i = 0; i < 50; i++) {
      const id = newToolId(taken)
      expect(id).toMatch(/^[a-z0-9]{1,16}$/)
      expect(taken).not.toContain(id)
      taken.push(id)
    }
  })
})
