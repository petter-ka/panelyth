import { isCommandText, MAX_COMMAND_CHARS } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { create } from "zustand"
import { bridge, isBridgeAvailable, PanelythError } from "../bridge"
import { goUp, openPath, pageStoreOf, parentRows, toPanelError, useListingStore } from "./listing"
import { usePanelsStore, type Side } from "./panels"
import { updateSettings, useSettingsStore } from "./settings"
import { focusPanel } from "./viewers"

// The command line (Stage C10, CFR-24): a line under the panels that runs in
// the active panel's folder through the OS shell. Main runs it (shell.run,
// ADR-0027); this module only ever calls it from runCommandLine, which the
// Enter key of the command line's own field calls. "cd" changes the panel's
// folder and never reaches the shell.

export const HISTORY_KEY = "commander.commandHistory"
export const MAX_HISTORY = 50

interface CommandLineState {
  text: string
  /** Newest first. */
  history: string[]
  historyOpen: boolean
  /** Increments to ask the field to take the focus (Ctrl+K, a typed letter). */
  focusToken: number
  /** The request is still open: the field answers it once, also right after it appears. */
  wantsFocus: boolean
  /** Why the last command did not run, until the text changes. */
  message: string | null
}

export const useCommandLine = create<CommandLineState>(() => ({
  text: "",
  history: [],
  historyOpen: false,
  focusToken: 0,
  wantsFocus: false,
  message: null,
}))

const get = useCommandLine.getState
const set = useCommandLine.setState

/** One line: control characters (a pasted line break) become spaces. */
export const oneLine = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_COMMAND_CHARS)

export function setCommandText(text: string): void {
  set({ text: oneLine(text), message: null })
}

/** Ctrl+K: the keys go to the command line (it is shown when it was hidden). */
export function focusCommandLine(): void {
  if (!useSettingsStore.getState().settings.showCommandLine) {
    updateSettings({ showCommandLine: true })
  }
  set((s) => ({ focusToken: s.focusToken + 1, wantsFocus: true }))
}

/** The field took the focus it was asked to take. */
export const focusTaken = (): void => set({ wantsFocus: false })

/** A letter typed in a panel while letters go to the command line. */
export function typeInCommandLine(char: string): void {
  setCommandText(get().text + char)
  focusCommandLine()
}

/** Esc: an empty line again. */
export function clearCommandLine(): void {
  set({ text: "", message: null, historyOpen: false })
}

// Names and paths ---------------------------------------------------------------

const isWindowsPath = (path: string): boolean => !path.startsWith("/")

/**
 * A name as the shell reads one word. The user sees and can edit it before
 * Enter; names without anything special stay as they are.
 */
export function shellWord(text: string, windows: boolean): string {
  if (windows) return /[\s&()^;,=%!]/.test(text) || text === "" ? `"${text}"` : text
  return /^[A-Za-z0-9_./:@%+=,-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`
}

function joinPath(folder: string, name: string): string {
  const sep = isWindowsPath(folder) ? "\\" : "/"
  return folder.endsWith(sep) || folder.endsWith("/") ? folder + name : folder + sep + name
}

/** The cursor entry's name, or with `full` its path; on ".." the panel's folder. */
export function cursorText(side: Side, full: boolean): string | null {
  const p = useListingStore.getState()[side]
  if (p.dirId === null) return null
  const index = p.cursor - parentRows(p)
  const item = index >= 0 ? pageStoreOf(side).getItem(index) : undefined
  if (!item) return full ? p.path : null
  return full ? joinPath(item.dirPath ?? p.path, item.name) : item.name
}

/** Where the command line's field puts inserted text: its caret, when it has the focus. */
let caret: (() => { start: number; end: number } | null) | null = null
export function setCaretSource(source: typeof caret): void {
  caret = source
}

/**
 * Ctrl+Enter / Ctrl+Shift+Enter: the cursor entry's name or full path goes
 * into the line, as one word followed by a space. Returns where the caret
 * belongs afterwards.
 */
export function insertCursorText(side: Side, full: boolean): number | null {
  const value = cursorText(side, full)
  if (value === null) return null
  // The line is shown when it was hidden: nothing is added out of sight.
  if (!useSettingsStore.getState().settings.showCommandLine) {
    updateSettings({ showCommandLine: true })
  }
  const p = useListingStore.getState()[side]
  const word = shellWord(value, isWindowsPath(p.path)) + " "
  const { text } = get()
  const at = caret?.() ?? null
  if (at) {
    const next = oneLine(text.slice(0, at.start) + word + text.slice(at.end))
    set({ text: next, message: null })
    return Math.min(next.length, at.start + word.length)
  }
  const gap = text === "" || text.endsWith(" ") ? "" : " "
  setCommandText(text + gap + word)
  return get().text.length
}

// cd ----------------------------------------------------------------------------

/**
 * "cd <folder>", "cd /d <folder>", "chdir <folder>", "cd..", or a drive
 * alone ("d:"): the folder asked for. "" for a bare "cd"; null when the
 * line is something else. A drive alone counts only where drives exist.
 */
export function cdTarget(line: string, windows = true): string | null {
  const text = line.trim()
  const drive = windows ? /^([A-Za-z]):$/.exec(text) : null
  if (drive) return `${drive[1]!.toUpperCase()}:\\`
  const m = /^(?:cd|chdir)(?:\s+\/d)?(?=$|[\s.\\/])\s*(.*)$/i.exec(text)
  if (!m) return null
  const target = m[1]!.trim()
  const quoted = /^(["'])(.*)\1$/.exec(target)
  return quoted ? quoted[2]! : target
}

/** A folder named relative to `base`, as a full path. */
export function resolveFolder(base: string, target: string): string {
  const windows = isWindowsPath(base)
  const sep = windows ? "\\" : "/"
  const split = (path: string): string[] =>
    path.split(windows ? /[\\/]+/ : /\/+/).filter((part) => part !== "")
  let root: string
  let parts: string[]
  const rootOf = (path: string): { root: string; rest: string } => {
    if (!windows) return { root: "/", rest: path }
    const unc = /^[\\/]{2}[^\\/]+[\\/]+[^\\/]+/.exec(path)
    if (unc) return { root: unc[0].replace(/\//g, "\\") + "\\", rest: path.slice(unc[0].length) }
    const drive = /^[A-Za-z]:/.exec(path)
    return drive
      ? { root: drive[0].toUpperCase() + "\\", rest: path.slice(2) }
      : { root: "", rest: path }
  }
  const absolute = windows ? /^([A-Za-z]:|[\\/]{2})/.test(target) : target.startsWith("/")
  if (absolute) {
    const r = rootOf(target)
    root = r.root
    parts = []
    target = r.rest
  } else {
    const r = rootOf(base)
    root = r.root
    // A leading separator names the root of the same drive.
    parts = /^[\\/]/.test(target) && windows ? [] : split(r.rest)
  }
  for (const part of split(target)) {
    if (part === ".") continue
    if (part === "..") parts.pop()
    else parts.push(part)
  }
  return root + parts.join(sep)
}

async function changeFolder(side: Side, target: string): Promise<void> {
  const p = useListingStore.getState()[side]
  if (target === "") return
  // ".." also leaves an archive, a branch view or search results.
  if (/^\.\.[\\/]?$/.test(target)) return goUp(side)
  if (!/^~($|[\\/])/.test(target)) {
    return openPath(side, resolveFolder(p.path, target), { inline: true })
  }
  const home = await bridge.homePath()
  if (!home) throw new Error(t("The home folder is not known."))
  await openPath(side, target.length > 1 ? joinPath(home, target.slice(2)) : home, {
    inline: true,
  })
}

// Running -----------------------------------------------------------------------

function refusal(error: unknown): string {
  if (!(error instanceof PanelythError))
    return error instanceof Error ? error.message : String(error)
  const reason = (error.details as { reason?: string } | undefined)?.reason
  if (reason === "unc") {
    return t("cmd.exe can't run in a network folder. Map the share to a drive letter first.")
  }
  if (reason === "hidden") return t("Commands run only while Commander is shown.")
  if (error.code === "NOT_FOUND") return t("This folder no longer exists.")
  return error.message
}

let running = false

/**
 * Enter in the command line: "cd" moves the panel; anything else is handed
 * to main to run in the active panel's folder. `console` (Shift+Enter) asks
 * for a console window that stays open; on an empty line it opens that
 * console in the panel's folder and runs nothing.
 */
export async function runCommandLine(console = false): Promise<void> {
  const line = get().text.trim()
  if (running || !isCommandText(line) || (line === "" && !console)) return
  const side = usePanelsStore.getState().active
  const p = useListingStore.getState()[side]
  const folder = cdTarget(line, isWindowsPath(p.path))
  running = true
  try {
    if (folder !== null) {
      await changeFolder(side, folder)
    } else {
      if (p.dirId === null) {
        set({ message: t("Open a folder in the panel first.") })
        return
      }
      // A command runs in a folder of this computer, never "on" a server.
      if (p.remote) {
        set({
          message: t("Commands run in a folder of this computer. Leave the connection first."),
        })
        return
      }
      await bridge.shellRun(line, p.dirId, console)
    }
    if (line !== "") remember(line)
    set({ text: "", message: null })
    focusPanel()
  } catch (error) {
    const moved = folder !== null && error instanceof PanelythError
    set({ message: moved ? toPanelError(error).message : refusal(error) })
  } finally {
    running = false
  }
}

// History -----------------------------------------------------------------------

function remember(line: string): void {
  const history = [line, ...get().history.filter((h) => h !== line)].slice(0, MAX_HISTORY)
  set({ history })
  if (isBridgeAvailable()) {
    void bridge.setSetting(HISTORY_KEY, { v: 1, items: history }).catch(() => undefined)
  }
}

/** Validated commander.commandHistory. */
export function readHistory(value: unknown): string[] {
  const v = value as { v?: unknown; items?: unknown } | null | undefined
  if (v?.v !== 1 || !Array.isArray(v.items)) return []
  return (v.items as unknown[])
    .filter((item): item is string => isCommandText(item) && item.trim() !== "")
    .slice(0, MAX_HISTORY)
}

export async function loadCommandHistory(): Promise<void> {
  if (!isBridgeAvailable()) return
  const { settings } = await bridge.library()
  set({ history: readHistory(settings[HISTORY_KEY]) })
}

/** Alt+F8: the list of earlier commands (it opens above the line). */
export function openCommandHistory(): void {
  // The list takes the keys itself; a picked line then goes to the field.
  if (!useSettingsStore.getState().settings.showCommandLine) {
    updateSettings({ showCommandLine: true })
  }
  set({ historyOpen: get().history.length > 0 })
}

export const closeCommandHistory = (): void => set({ historyOpen: false })

/** A line from the history goes into the field; Enter runs it. */
export function pickHistory(index: number): void {
  const line = get().history[index]
  if (line === undefined) return
  set((s) => ({
    text: line,
    message: null,
    historyOpen: false,
    focusToken: s.focusToken + 1,
    wantsFocus: true,
  }))
}

/** Tests. */
export function resetCommandLine(): void {
  running = false
  caret = null
  set({
    text: "",
    history: [],
    historyOpen: false,
    focusToken: 0,
    wantsFocus: false,
    message: null,
  })
}
