// "Open with" programs (ADR-0044): programs the user picked in Settings, listed
// in both apps' context menus for files, folders or both. The list lives in
// library.db under shared.programs and only Electron main writes it: a program
// path comes from main's native file dialog, never from a renderer, and an
// open names a program by id and an entry by id.

export const SHARED_PROGRAMS_KEY = "shared.programs"

export const MAX_PROGRAMS = 20
export const MAX_PROGRAM_NAME_CHARS = 64
export const MAX_PROGRAM_PATH_CHARS = 4096

/** Which entries a program is offered for. */
export const PROGRAM_TARGETS = ["files", "folders", "both"] as const
export type ProgramTarget = (typeof PROGRAM_TARGETS)[number]

export interface ExternalProgram {
  /** Stable across edits. */
  id: string
  /** As the menu shows it: "Open with <name>". */
  name: string
  /** Absolute; picked in main's dialog. Shown in Settings, never sent back. */
  path: string
  target: ProgramTarget
}

export interface StoredPrograms {
  v: 1
  programs: ExternalProgram[]
}

/** What a renderer may change of a program: its name and target, and the order (programs.update). */
export interface ProgramEdit {
  id: string
  name: string
  target: ProgramTarget
}

/** programs.update: the list in its new order; a program left out is removed. */
export interface ProgramsUpdateParams {
  programs: ProgramEdit[]
}

export interface ProgramsResult {
  programs: ExternalProgram[]
  /** programs.add: the program picked, or null when the dialog was cancelled. */
  added?: string | null
}

/** programs.open: the entry is handed to the program as its only argument. */
export interface ProgramOpenParams {
  programId: string
  entryId: number
}

/**
 * programs.openFolder (viewer): a folder of the folder tree, whose rows are
 * paths rather than indexed entries (as shell.revealPath). Main checks that it
 * is an existing folder.
 */
export interface ProgramOpenFolderParams {
  programId: string
  path: string
}

export const PROGRAM_ID = /^[a-z0-9]{1,16}$/

const targets: ReadonlySet<unknown> = new Set(PROGRAM_TARGETS)

/** One line without control characters, 1 to `max` long. */
export function isProgramText(value: unknown, max: number): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) return false
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return false
  }
  return true
}

/** An absolute path on any of the OSes: C:\…, \\server\…, /… */
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\[^\\]|\/)/

/** Validated shared.programs; anything malformed is left out. */
export function readPrograms(value: unknown): ExternalProgram[] {
  const v = value as Partial<StoredPrograms> | null | undefined
  if (v?.v !== 1 || !Array.isArray(v.programs)) return []
  const out: ExternalProgram[] = []
  const seen = new Set<string>()
  for (const raw of v.programs as unknown[]) {
    const p = (raw ?? {}) as Partial<Record<keyof ExternalProgram, unknown>>
    if (typeof p.id !== "string" || !PROGRAM_ID.test(p.id) || seen.has(p.id)) continue
    if (!isProgramText(p.path, MAX_PROGRAM_PATH_CHARS) || !ABSOLUTE.test(p.path)) continue
    if (!isProgramText(p.name, MAX_PROGRAM_NAME_CHARS) || p.name.trim() === "") continue
    seen.add(p.id)
    out.push({
      id: p.id,
      name: p.name.trim(),
      path: p.path,
      target: targets.has(p.target) ? (p.target as ProgramTarget) : "both",
    })
    if (out.length === MAX_PROGRAMS) break
  }
  return out
}

/** The programs offered for an entry: a folder, or a file of any kind. */
export function programsFor(
  programs: readonly ExternalProgram[],
  folder: boolean,
): ExternalProgram[] {
  return programs.filter((p) => p.target === "both" || p.target === (folder ? "folders" : "files"))
}

/** A new program id that none of `taken` has. */
export function newProgramId(taken: readonly string[]): string {
  for (;;) {
    const id = Math.random().toString(36).slice(2, 10)
    if (PROGRAM_ID.test(id) && !taken.includes(id)) return id
  }
}
