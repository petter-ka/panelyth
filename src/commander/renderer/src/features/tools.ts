import {
  COMMANDER_TOOLS_KEY,
  MAX_USER_COMMANDS,
  newToolId,
  readUserCommands,
  type UserCommand,
} from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { notice, operand, refusedOnConnection } from "./files"
import { ACTIONS, isToolAction, setToolActions, toolAction, type ActionId } from "./keymap"
import { cursorEntryId, useListingStore } from "./listing"
import { otherSide, type Side } from "./panels"

// User commands and the toolbar (Stage C10, CFR-25). A user command is a
// program with parameters, stored in library.db (commander.tools). It runs
// from a toolbar button, a key or the entry menu; main reads it from
// library.db by its id and fills the placeholders from entry ids (ADR-0027),
// so this module never builds a command line.

export const TOOLBAR_KEY = "commander.toolbar"
export const MAX_TOOLBAR_ITEMS = 40
export const SEPARATOR = "|"

/** A built-in action's id, "tool:" and a user command's id, or "|" for a divider. */
export type ToolbarItem = string

export const DEFAULT_TOOLBAR: readonly ToolbarItem[] = [
  "find.open",
  "view.filter",
  "view.branch",
  SEPARATOR,
  "compare.dirs",
  "compare.sync",
  "compare.content",
  SEPARATOR,
  "view.quick",
  "view.refresh",
  "hotlist.open",
  "files.rename",
]

/** The actions a toolbar button can run: everything outside the lister. */
export const TOOLBAR_ACTIONS: readonly ActionId[] = ACTIONS.filter((a) => a.scope !== "lister").map(
  (a) => a.id,
)
const builtIn: ReadonlySet<string> = new Set(TOOLBAR_ACTIONS)

/** What can still go on the toolbar: built-in actions, then the user's commands, none twice. */
export function toolbarCandidates(
  items: readonly ToolbarItem[],
  commands: readonly UserCommand[],
): string[] {
  return [
    ...TOOLBAR_ACTIONS.filter((a) => !items.includes(a)),
    ...commands.map((c) => toolAction(c.id) as string).filter((a) => !items.includes(a)),
  ]
}

/** The toolbar in edit mode: an item dragged (or moved from its menu) to another place. */
export function moveToolbarItem(from: number, to: number): void {
  const items = [...get().toolbar]
  if (from < 0 || from >= items.length || to < 0 || to > items.length) return
  const [item] = items.splice(from, 1)
  items.splice(to > from ? to - 1 : to, 0, item!)
  setToolbar(items)
}

/** The toolbar in edit mode: an item removed (its menu). */
export function removeToolbarItem(index: number): void {
  setToolbar(get().toolbar.filter((_, i) => i !== index))
}

/** Adds one item at the end (a divider, an action, a command); false when the toolbar is full. */
export function addToToolbar(item: ToolbarItem): boolean {
  const items = get().toolbar
  if (items.length >= MAX_TOOLBAR_ITEMS) return false
  setToolbar([...items, item])
  return true
}

interface ToolsState {
  commands: UserCommand[]
  toolbar: ToolbarItem[]
}

export const useToolsStore = create<ToolsState>(() => ({
  commands: [],
  toolbar: [...DEFAULT_TOOLBAR],
}))

const get = useToolsStore.getState
const set = useToolsStore.setState

/**
 * Validated commander.toolbar: known actions, existing commands, no doubled
 * or leading dividers. A divider may end it: the "+" adds there, so the next
 * button lands after it.
 */
export function readToolbar(value: unknown, commands: readonly UserCommand[]): ToolbarItem[] {
  const v = value as { v?: unknown; items?: unknown } | null | undefined
  if (v?.v !== 1 || !Array.isArray(v.items)) return [...DEFAULT_TOOLBAR]
  const ids = new Set(commands.map((c) => toolAction(c.id) as string))
  const out: ToolbarItem[] = []
  for (const item of v.items as unknown[]) {
    if (typeof item !== "string") continue
    if (item === SEPARATOR) {
      if (out.length > 0 && out.at(-1) !== SEPARATOR) out.push(item)
    } else if ((builtIn.has(item) || ids.has(item)) && !out.includes(item)) out.push(item)
    if (out.length === MAX_TOOLBAR_ITEMS) break
  }
  return out
}

function persist(key: string, value: unknown): void {
  if (isBridgeAvailable()) void bridge.setSetting(key, value).catch(() => undefined)
}

const saveCommands = (commands: UserCommand[]): void => {
  set({ commands })
  setToolActions(commands)
  persist(COMMANDER_TOOLS_KEY, { v: 1, commands })
}

export function setToolbar(items: readonly ToolbarItem[]): void {
  const toolbar = readToolbar({ v: 1, items }, get().commands)
  set({ toolbar })
  persist(TOOLBAR_KEY, { v: 1, items: toolbar })
}

export const resetToolbar = (): void => setToolbar(DEFAULT_TOOLBAR)

/** A value the settings window stored (ADR-0039): the commands or the toolbar, taken as they are. */
export function applyToolsSetting(key: string, value: unknown): void {
  if (key === COMMANDER_TOOLS_KEY) {
    const commands = readUserCommands(value)
    set({ commands })
    setToolActions(commands)
  } else if (key === TOOLBAR_KEY) set({ toolbar: readToolbar(value, get().commands) })
}

/** A new command as the editor starts with it. */
export function newCommand(): UserCommand {
  return {
    id: newToolId(get().commands.map((c) => c.id)),
    title: "",
    command: "",
    params: "",
    dir: "",
    icon: "tool",
    menu: true,
    console: false,
  }
}

/** Adds the command or replaces the one with its id; false when it is not a valid command. */
export function saveCommand(command: UserCommand, onToolbar: boolean): boolean {
  const others = get().commands.filter((c) => c.id !== command.id)
  if (others.length >= MAX_USER_COMMANDS) return false
  const known = get().commands.some((c) => c.id === command.id)
  const next = known
    ? get().commands.map((c) => (c.id === command.id ? command : c))
    : [...get().commands, command]
  // What main will read back is what is kept (the same validation).
  const valid = readUserCommands({ v: 1, commands: next })
  if (valid.length !== next.length) return false
  saveCommands(valid)
  const item = toolAction(command.id)
  const shown = get().toolbar.includes(item)
  if (onToolbar && !shown) setToolbar([...get().toolbar, item])
  else if (!onToolbar && shown) setToolbar(get().toolbar.filter((i) => i !== item))
  return true
}

export function removeCommand(id: string): void {
  saveCommands(get().commands.filter((c) => c.id !== id))
  const item = toolAction(id)
  if (get().toolbar.includes(item)) setToolbar(get().toolbar.filter((i) => i !== item))
}

export async function loadTools(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  const commands = readUserCommands(settings[COMMANDER_TOOLS_KEY])
  set({ commands, toolbar: readToolbar(settings[TOOLBAR_KEY], commands) })
  setToolActions(commands)
}

/** The user command a toolbar item or a key stands for. */
export function commandOf(item: string): UserCommand | undefined {
  return isToolAction(item) ? get().commands.find((c) => toolAction(c.id) === item) : undefined
}

function refusal(error: unknown, title: string): string {
  if (!(error instanceof PanelythError)) return String(error)
  const reason = (error.details as { reason?: string } | undefined)?.reason
  switch (reason) {
    case "noEntry":
      return t("{command} needs a file: put the cursor on one or mark some.", { command: title })
    case "noOther":
      return t("{command} needs a folder in the other panel.", { command: title })
    case "tooMany":
      return t("Too many entries are marked for {command}.", { command: title })
    case "tooLong":
      return t("The command line of {command} gets too long. Use %L for marked files.", {
        command: title,
      })
    case "dir":
      return t("The working folder of {command} was not found.", { command: title })
    case "shadowed":
      return t(
        "This folder has a file with the name of {command}'s program. Give the command its full path.",
        { command: title },
      )
    case "unc":
      return t("cmd.exe can't run in a network folder. Map the share to a drive letter first.")
    case "name":
      return t("A file name has characters {command} can't be given.", { command: title })
  }
  if (error.code === "NOT_FOUND") return t("This command no longer exists.")
  return error.message
}

/**
 * Runs a user command on a panel: its folder, the other panel's folder, the
 * cursor entry and the marks (or the cursor entry) go to main as ids. Called
 * from a toolbar button, the entry menu or the command's key only.
 */
export async function runTool(side: Side, id: string): Promise<void> {
  const tool = get().commands.find((c) => c.id === id)
  const p = useListingStore.getState()[side]
  if (!tool || p.dirId === null) return
  // A program gets folders and files of this computer only (ADR-0037).
  if (refusedOnConnection(side)) return
  const other = useListingStore.getState()[otherSide(side)]
  // Entries inside an archive have no path a program could open.
  const cursorId = p.archive ? null : cursorEntryId(side)
  const selection = p.archive ? null : operand(side)
  try {
    await bridge.shellRunTool({
      toolId: id,
      dirId: p.dirId,
      ...(other.dirId !== null && !other.remote && { otherDirId: other.dirId }),
      ...(cursorId !== null && { cursorId }),
      ...(selection && { selection }),
    })
  } catch (error) {
    notice(refusal(error, tool.title))
  }
}

/** Tests. */
export function resetTools(): void {
  set({ commands: [], toolbar: [...DEFAULT_TOOLBAR] })
}
