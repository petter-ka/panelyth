import {
  ENTRY_ATTRS,
  MAX_ATTR_TIME_MS,
  MIN_ATTR_TIME_MS,
  type CommanderJobParams,
  type Properties,
  type SelectionDescriptor,
} from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, PanelythError } from "../bridge"
import { describeOperand } from "./compare"
import { inArchive, notice, operand, READ_ONLY, refusedOnConnection } from "./files"
import { IS_WINDOWS } from "./format"
import { pageStoreOf, parentRows, useListingStore } from "./listing"
import { countOf, marksDescriptor, marksOf, markNone } from "./marks"
import type { Side } from "./panels"
import { watch } from "./rename"
import { msg, t } from "@panelyth/i18n"

// Attributes, dates and properties (Stage C09, CFR-23): "Change attributes"
// sets or clears the Windows attributes (elsewhere the permission bits) and
// the dates of the marked entries or the cursor entry, as a setAttributes
// job; Alt+Enter shows the properties of the same entries.

/** What happens to one attribute or permission bit. */
export type Tri = "keep" | "set" | "clear"

/** keep → set → clear → keep: what a click on a three-state box does. */
export const nextTri = (v: Tri): Tri => (v === "keep" ? "set" : v === "set" ? "clear" : "keep")

export const WINDOWS_ATTRS: readonly { bit: number; label: string }[] = [
  { bit: ENTRY_ATTRS.readOnly, label: msg("Read-only") },
  { bit: ENTRY_ATTRS.hidden, label: msg("Hidden") },
  { bit: ENTRY_ATTRS.system, label: msg("System") },
  { bit: ENTRY_ATTRS.archive, label: msg("Archive") },
]

/** Rows of the permissions grid; each has read, write and execute from its first bit down. */
export const PERMISSION_ROWS: readonly { first: number; label: string }[] = [
  { first: 0o400, label: msg("Owner") },
  { first: 0o040, label: msg("Group") },
  { first: 0o004, label: msg("Others") },
]
export const PERMISSION_COLUMNS: readonly string[] = [msg("Read"), msg("Write"), msg("Execute")]

export interface AttributesDialogState {
  side: Side
  source: SelectionDescriptor
  what: string
  /** Windows attributes, or permission bits everywhere else. */
  windows: boolean
  /** The entry as it is now, when the dialog is for one entry. */
  current: Properties | null
  /** Bit → what to do with it; a missing bit is kept. */
  bits: Record<number, Tri>
  /** New dates as `datetime-local` values; "" = unchanged. */
  modified: string
  accessed: string
  recursive: boolean
  busy: boolean
  error: string | null
}

export type PropertiesTarget =
  | { kind: "entry"; id: number }
  | { kind: "selection"; selection: SelectionDescriptor; count: number }

interface AttributesState {
  dialog: AttributesDialogState | null
  properties: { side: Side; target: PropertiesTarget } | null
}

export const useAttributesStore = create<AttributesState>(() => ({
  dialog: null,
  properties: null,
}))

const set = useAttributesStore.setState
const get = useAttributesStore.getState

const errorText = (error: unknown): string =>
  error instanceof PanelythError ? error.message : String(error)

/** The cursor entry's id when nothing is marked (".." has none). */
function cursorId(side: Side): number | null {
  if (marksDescriptor(side)) return null
  const p = useListingStore.getState()[side]
  const index = p.cursor - parentRows(p)
  return index >= 0 ? (pageStoreOf(side).getItem(index)?.id ?? null) : null
}

/** Change attributes: for the marks, or the cursor entry (whose current state is shown). */
export function openAttributes(side: Side): void {
  if (refusedOnConnection(side)) return
  if (inArchive(side)) {
    notice(t(READ_ONLY))
    return
  }
  const source = operand(side)
  if (!source) return
  const dialog: AttributesDialogState = {
    side,
    source,
    what: describeOperand(side, source),
    windows: IS_WINDOWS,
    current: null,
    bits: {},
    modified: "",
    accessed: "",
    recursive: false,
    busy: false,
    error: null,
  }
  set({ dialog })
  const id = cursorId(side)
  if (id === null) return
  void bridge
    .properties(id)
    .then((current) => {
      const d = get().dialog
      if (d?.source !== source) return
      // Go knows the platform: it reports permissions everywhere but on Windows.
      // Boxes clicked for the other kind of bits mean nothing now.
      const windows = current.permissions === null
      set({ dialog: { ...d, current, windows, bits: windows === d.windows ? d.bits : {} } })
    })
    .catch(() => undefined)
}

export function updateAttributes(change: Partial<AttributesDialogState>): void {
  const d = get().dialog
  if (d) set({ dialog: { ...d, ...change, error: null } })
}

export function cycleBit(bit: number): void {
  const d = get().dialog
  if (d) updateAttributes({ bits: { ...d.bits, [bit]: nextTri(d.bits[bit] ?? "keep") } })
}

export const closeAttributes = (): void => set({ dialog: null })

const pad = (n: number, width = 2): string => String(n).padStart(width, "0")

/** A time as a `datetime-local` value with seconds (local time). */
export function toDateInput(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A `datetime-local` value as a time: undefined for "", NaN when it cannot be read. */
function fromDateInput(value: string): number | undefined {
  return value.trim() === "" ? undefined : new Date(value).getTime()
}

/** The job a dialog asks for, or the reason it cannot start. */
export function attributesJob(d: AttributesDialogState): CommanderJobParams | string {
  let setBits = 0
  let clearBits = 0
  for (const [bit, tri] of Object.entries(d.bits)) {
    if (tri === "set") setBits |= Number(bit)
    else if (tri === "clear") clearBits |= Number(bit)
  }
  const modifiedMs = fromDateInput(d.modified)
  const accessedMs = fromDateInput(d.accessed)
  for (const ms of [modifiedMs, accessedMs]) {
    if (ms !== undefined && !(ms >= MIN_ATTR_TIME_MS && ms <= MAX_ATTR_TIME_MS))
      return t("Enter a date between 1980 and 9999.")
  }
  if (setBits === 0 && clearBits === 0 && modifiedMs === undefined && accessedMs === undefined)
    return t("Choose an attribute or a date to change.")
  return {
    kind: "setAttributes",
    source: { selection: d.source },
    ...(d.windows
      ? { ...(setBits && { setAttrs: setBits }), ...(clearBits && { clearAttrs: clearBits }) }
      : { ...(setBits && { setMode: setBits }), ...(clearBits && { clearMode: clearBits }) }),
    ...(modifiedMs !== undefined && { modifiedMs }),
    ...(accessedMs !== undefined && { accessedMs }),
    ...(d.recursive && { recursive: true }),
  }
}

export async function startAttributes(): Promise<boolean> {
  const d = get().dialog
  if (!d || d.busy) return false
  const job = attributesJob(d)
  if (typeof job === "string") {
    set({ dialog: { ...d, error: job } })
    return false
  }
  set({ dialog: { ...d, busy: true, error: null } })
  try {
    const snap = await bridge.startJob(job)
    watch(snap.jobId, "setAttributes")
  } catch (error) {
    if (get().dialog) set({ dialog: { ...get().dialog!, busy: false, error: errorText(error) } })
    return false
  }
  set({ dialog: null })
  if (marksDescriptor(d.side)) markNone(d.side)
  return true
}

// Properties ---------------------------------------------------------------------

/** Alt+Enter: properties of the cursor entry, or what the marks add up to. */
export function openProperties(side: Side): void {
  const id = cursorId(side)
  if (id !== null) {
    set({ properties: { side, target: { kind: "entry", id } } })
    return
  }
  const selection = marksDescriptor(side)
  if (!selection) return
  set({
    properties: {
      side,
      target: { kind: "selection", selection, count: countOf(marksOf(side)) },
    },
  })
}

export const closeProperties = (): void => set({ properties: null })

/** Tests. */
export function resetAttributes(): void {
  set({ dialog: null, properties: null })
}
