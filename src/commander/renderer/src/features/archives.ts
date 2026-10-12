import type {
  ArchiveCreateFormat,
  ArchiveWarning,
  ConflictPolicy,
  JobSnapshot,
  SelectionDescriptor,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, PanelythError, isBridgeAvailable } from "../bridge"
import {
  inArchive,
  notice,
  operand,
  otherPanelTarget,
  READ_ONLY,
  refusedOnConnection,
} from "./files"
import { pageStoreOf, parentRows, useListingStore } from "./listing"
import { marksDescriptor, markNone } from "./marks"
import { otherSide, type Side } from "./panels"
import { msg, t } from "@panelyth/i18n"

// Pack (Alt+F5), unpack (Alt+F9) and test (Alt+Shift+F9), Stage C07
// (ADR-0030). All three are jobs on the engine v2 queue; destinations are
// folder ids resolved in Go. Entering archives and copying out of them live
// in listing.ts and files.ts.

/** The file extension each created format gets. */
export const FORMAT_EXT: Record<ArchiveCreateFormat, string> = {
  zip: ".zip",
  tgz: ".tar.gz",
  "7z": ".7z",
}

export const FORMATS: readonly { value: ArchiveCreateFormat; label: string }[] = [
  { value: "zip", label: "ZIP" },
  { value: "tgz", label: "TAR.GZ" },
  { value: "7z", label: "7Z (7-Zip)" },
]

/** Compression levels offered (0 stores, 9 is slowest). */
export const LEVELS: readonly { value: number; label: string }[] = [
  { value: 0, label: msg("Store (no compression)") },
  { value: 1, label: msg("Fastest") },
  { value: 6, label: msg("Normal") },
  { value: 9, label: msg("Maximum") },
]

interface Target {
  destination: string
  /** The folder's id while the destination is not edited. */
  destinationDirId: number | null
}

export interface PackDialogState extends Target {
  side: Side
  source: SelectionDescriptor
  what: string
  name: string
  format: ArchiveCreateFormat
  level: number
  deleteOriginals: boolean
  conflict: ConflictPolicy
  error: string | null
}

export interface UnpackDialogState extends Target {
  side: Side
  source: SelectionDescriptor
  what: string
  subfolders: boolean
  links: boolean
  conflict: ConflictPolicy
  /** archive.check: what the archives expand to, and its warnings. */
  files: number | null
  bytes: number | null
  warnings: ArchiveWarning[]
  error: string | null
}

interface ArchivesState {
  pack: PackDialogState | null
  unpack: UnpackDialogState | null
  /** Whether 7-Zip was found (null until asked). */
  sevenZip: boolean | null
}

export const useArchivesStore = create<ArchivesState>(() => ({
  pack: null,
  unpack: null,
  sevenZip: null,
}))

const set = useArchivesStore.setState
const get = useArchivesStore.getState

const errorText = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

const countOf = (d: SelectionDescriptor): number =>
  d.ranges.reduce((n, [a, b]) => n + b - a, 0) + d.include.length

/** The cursor entry when nothing is marked. */
function single(side: Side) {
  if (marksDescriptor(side)) return null
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index) ?? null) : null
}

function describe(side: Side, d: SelectionDescriptor): string {
  const item = single(side)
  if (item) return item.name
  const n = countOf(d)
  return t("{count, plural, one {# item} other {# items}}", { count: n })
}

/** The other panel's folder, unless it shows an archive (nothing is written into one). */
function target(side: Side): Target | null {
  // Nothing is packed or unpacked straight onto a server (ADR-0037).
  if (refusedOnConnection(otherSide(side))) return null
  if (inArchive(otherSide(side))) {
    notice(t("Archives are read-only. Choose a folder in the other panel."))
    return null
  }
  const dest = otherPanelTarget(side)
  return dest ? { destination: dest.path, destinationDirId: dest.dirId } : null
}

/** "photo.jpg" → "photo", "photos" (a folder) → "photos". */
function stem(name: string, isDir: boolean): string {
  if (isDir) return name
  const dot = name.lastIndexOf(".")
  return dot > 0 ? name.slice(0, dot) : name
}

/** Replaces a known archive extension (or adds one) when the format changes. */
export function withFormat(name: string, format: ArchiveCreateFormat): string {
  const lower = name.toLowerCase()
  for (const ext of Object.values(FORMAT_EXT)) {
    if (lower.endsWith(ext)) return name.slice(0, name.length - ext.length) + FORMAT_EXT[format]
  }
  return name + FORMAT_EXT[format]
}

async function knowSevenZip(): Promise<void> {
  if (get().sevenZip !== null || !isBridgeAvailable()) return
  const found = await bridge.sevenZip().catch(() => false)
  set({ sevenZip: found })
}

/** Resolves an edited destination to its folder id (dir.open of the typed path). */
async function resolveDir(dest: Target): Promise<number> {
  if (dest.destinationDirId !== null) return dest.destinationDirId
  const typed = dest.destination.trim()
  if (typed === "") throw new Error(t("Enter a destination folder."))
  try {
    return (await bridge.openDir(typed)).dirId
  } catch (error) {
    if (
      error instanceof PanelythError &&
      (error.code === "NOT_FOUND" || error.code === "INVALID_PATH")
    )
      throw new Error(t("This folder doesn't exist. Check the destination."), { cause: error })
    throw error
  }
}

// Pack -------------------------------------------------------------------------------

/** Alt+F5: the marks (or the cursor entry) into a new archive in the other panel's folder. */
export function openPack(side: Side): void {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t(READ_ONLY))
    return
  }
  const source = operand(side)
  const dest = source && target(side)
  if (!source || !dest) return
  const item = single(side)
  const base = item
    ? stem(item.name, item.kind === "dir")
    : useListingStore.getState()[side].name || "archive"
  set({
    pack: {
      side,
      source,
      what: describe(side, source),
      ...dest,
      name: base + FORMAT_EXT.zip,
      format: "zip",
      level: 6,
      deleteOriginals: false,
      conflict: "ask",
      error: null,
    },
  })
  void knowSevenZip()
}

export function updatePack(change: Partial<PackDialogState>): void {
  const p = get().pack
  if (!p) return
  const edited = change.destination !== undefined && change.destination !== p.destination
  const name =
    change.format !== undefined && change.format !== p.format && change.name === undefined
      ? withFormat(p.name, change.format)
      : (change.name ?? p.name)
  set({ pack: { ...p, ...change, name, ...(edited && { destinationDirId: null }), error: null } })
}

export const closePack = (): void => set({ pack: null })

export async function startPack(): Promise<boolean> {
  const p = get().pack
  if (!p) return false
  try {
    const name = p.name.trim()
    if (name === "") throw new Error(t("Enter a name for the archive."))
    const destinationDirId = await resolveDir(p)
    await bridge.startJob({
      kind: "pack",
      source: { selection: p.source },
      destinationDirId,
      conflict: p.conflict,
      name,
      format: p.format,
      level: p.level,
      ...(p.deleteOriginals && { deleteOriginals: true }),
    })
  } catch (error) {
    if (get().pack) set({ pack: { ...get().pack!, error: errorText(error) } })
    return false
  }
  set({ pack: null })
  if (marksDescriptor(p.side)) markNone(p.side)
  return true
}

// Unpack ------------------------------------------------------------------------------

/** Alt+F9: whole archives into the other panel's folder. */
export async function openUnpack(side: Side): Promise<void> {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t("Inside an archive, copy entries out with F5."))
    return
  }
  const source = operand(side)
  const dest = source && target(side)
  if (!source || !dest) return
  set({
    unpack: {
      side,
      source,
      what: describe(side, source),
      ...dest,
      subfolders: false,
      links: true,
      conflict: "ask",
      files: null,
      bytes: null,
      warnings: [],
      error: null,
    },
  })
  if (dest.destinationDirId === null) return
  const check = await bridge.checkArchive(source, dest.destinationDirId).catch(() => null)
  const now = get().unpack
  if (check && now?.source === source) {
    set({ unpack: { ...now, files: check.files, bytes: check.bytes, warnings: check.warnings } })
  }
}

export function updateUnpack(change: Partial<UnpackDialogState>): void {
  const u = get().unpack
  if (!u) return
  const edited = change.destination !== undefined && change.destination !== u.destination
  set({ unpack: { ...u, ...change, ...(edited && { destinationDirId: null }), error: null } })
}

export const closeUnpack = (): void => set({ unpack: null })

export async function startUnpack(): Promise<boolean> {
  const u = get().unpack
  if (!u) return false
  try {
    const destinationDirId = await resolveDir(u)
    await bridge.startJob({
      kind: "extract",
      source: { selection: u.source },
      destinationDirId,
      conflict: u.conflict,
      links: u.links,
      ...(u.subfolders && { subfolders: true }),
    })
  } catch (error) {
    if (get().unpack) set({ unpack: { ...get().unpack!, error: errorText(error) } })
    return false
  }
  set({ unpack: null })
  if (marksDescriptor(u.side)) markNone(u.side)
  return true
}

// Test -------------------------------------------------------------------------------------

/** Test jobs whose result is announced when they finish. */
const testing = new Set<number>()

/** Alt+Shift+F9: reads the archives through; the result is announced. */
export async function testArchives(side: Side): Promise<void> {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t("Test the archive itself: leave it with Backspace first."))
    return
  }
  const source = operand(side)
  if (!source) return
  try {
    const job = await bridge.startJob({ kind: "testArchive", source: { selection: source } })
    testing.add(job.jobId)
    notice(t("Testing {what}…", { what: describe(side, source) }))
  } catch (error) {
    notice(errorText(error))
  }
}

export function testResult(job: JobSnapshot): string {
  if (job.state === "cancelled") return t("The archive test was cancelled.")
  if (job.failed === 0) {
    return t("{count, plural, one {# archive} other {# archives}} tested: no errors.", {
      count: job.done,
    })
  }
  return t(
    "{failed, plural, one {# archive} other {# archives}} of {total, plural, one {# archive} other {# archives}} damaged or unreadable; details in the queue (Ctrl+J).",
    { failed: job.failed, total: job.total },
  )
}

/** Announces finished tests; started once by the app. */
export function startArchives(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  return bridge.on("job.progress", (job) => {
    if (!testing.has(job.jobId) || job.state === "running" || job.state === "queued") return
    if (job.state === "paused" || job.state === "asking") return
    testing.delete(job.jobId)
    notice(testResult(job))
  })
}

/** Tests. */
export function resetArchives(): void {
  testing.clear()
  set({ pack: null, unpack: null, sevenZip: null })
}
