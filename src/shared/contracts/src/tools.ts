// The commander's command line and user commands (Stage C10, ADR-0027).
// User commands live in library.db under commander.tools. Main reads them
// from there when one runs, so a call names a command by id and never
// carries its program or parameters.

export const COMMANDER_TOOLS_KEY = "commander.tools"

export const MAX_USER_COMMANDS = 50
/** A typed command line, and each text field of a user command. */
export const MAX_COMMAND_CHARS = 2048
export const MAX_TOOL_TITLE_CHARS = 64

/** The icons a user command can show on the toolbar. */
export const TOOL_ICONS = [
  "tool",
  "terminal",
  "play",
  "edit",
  "view",
  "copy",
  "move",
  "search",
  "star",
  "compare",
  "sync",
  "refresh",
] as const
export type ToolIcon = (typeof TOOL_ICONS)[number]

export interface UserCommand {
  /** Stable across edits: toolbar buttons and key bindings refer to it. */
  id: string
  title: string
  /** The program or command, as it would be typed in the command line. */
  command: string
  /**
   * Its parameters. %P the active panel's folder, %T the other panel's
   * folder (both end with a separator), %N the cursor entry's name, %S the
   * marked names, %L a file listing the marked entries' full paths, %% a
   * percent sign.
   */
  params: string
  /** The working folder: "" for the active panel's folder, or an absolute path. */
  dir: string
  icon: ToolIcon
  /** Listed in the entry context menu. */
  menu: boolean
  /** Runs in a console window that stays open. */
  console: boolean
}

export interface StoredUserCommands {
  v: 1
  commands: UserCommand[]
}

const ID = /^[a-z0-9]{1,16}$/
const icons: ReadonlySet<unknown> = new Set(TOOL_ICONS)

/** One line of text without control characters, at most `max` long. */
export function isCommandText(value: unknown, max = MAX_COMMAND_CHARS): value is string {
  if (typeof value !== "string" || value.length > max) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** Validated commander.tools; anything malformed is left out. */
export function readUserCommands(value: unknown): UserCommand[] {
  const v = value as Partial<StoredUserCommands> | null | undefined
  if (v?.v !== 1 || !Array.isArray(v.commands)) return []
  const out: UserCommand[] = []
  const seen = new Set<string>()
  for (const raw of v.commands as unknown[]) {
    const c = (raw ?? {}) as Partial<Record<keyof UserCommand, unknown>>
    if (typeof c.id !== "string" || !ID.test(c.id) || seen.has(c.id)) continue
    if (!isCommandText(c.command) || c.command.trim() === "") continue
    if (!isCommandText(c.title, MAX_TOOL_TITLE_CHARS)) continue
    seen.add(c.id)
    out.push({
      id: c.id,
      title: c.title.trim() || c.command.trim().slice(0, MAX_TOOL_TITLE_CHARS),
      command: c.command.trim(),
      params: isCommandText(c.params) ? c.params.trim() : "",
      dir: isCommandText(c.dir) ? c.dir.trim() : "",
      icon: icons.has(c.icon) ? (c.icon as ToolIcon) : "tool",
      menu: c.menu === true,
      console: c.console === true,
    })
    if (out.length === MAX_USER_COMMANDS) break
  }
  return out
}

/** A new command id that none of `taken` has. */
export function newToolId(taken: readonly string[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10)
    if (ID.test(id) && !taken.includes(id)) return id
  }
}
