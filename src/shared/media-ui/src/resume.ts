import { mediaPort } from "./port"

// Where a long video stopped (Stage-less feature, owner request): a video
// longer than 10 minutes continues from its last position the next time it
// plays. Positions live in library.db under one setting, shared by the viewer
// and the commander, keyed by entry id; the duration guards against a file
// that was replaced.

/** Only videos at least this long are remembered. */
export const RESUME_MIN_DURATION_S = 10 * 60
/** Before this, or within the last RESUME_END_MARGIN_S, a video starts over. */
export const RESUME_MIN_POSITION_S = 5
export const RESUME_END_MARGIN_S = 15
/** A saved duration differing by more than this means another file now. */
const DURATION_TOLERANCE_S = 2
const MAX_ENTRIES = 200
const SAVE_DELAY_MS = 1000

export const RESUME_KEY = "player.resume"

export interface ResumePoint {
  /** Seconds into the video. */
  t: number
  /** The video's duration when saved, in seconds. */
  d: number
  /** Saved at (ms since the epoch); the oldest entries go first. */
  at: number
}

type Stored = Record<string, ResumePoint>

const isPoint = (v: unknown): v is ResumePoint => {
  if (typeof v !== "object" || v === null) return false
  const p = v as Record<string, unknown>
  return (
    typeof p.t === "number" &&
    Number.isFinite(p.t) &&
    p.t >= 0 &&
    typeof p.d === "number" &&
    Number.isFinite(p.d) &&
    p.d > 0 &&
    typeof p.at === "number" &&
    Number.isFinite(p.at)
  )
}

/** Validated; anything malformed is dropped. */
export function parseStored(value: unknown): Stored {
  const out: Stored = {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out
  for (const [key, point] of Object.entries(value)) {
    if (/^\d+$/.test(key) && isPoint(point)) out[key] = { t: point.t, d: point.d, at: point.at }
  }
  return out
}

/** The position to continue from, or null when the video should start over. */
export function usablePoint(point: ResumePoint | undefined, duration: number): number | null {
  if (!point || !Number.isFinite(duration) || duration < RESUME_MIN_DURATION_S) return null
  if (Math.abs(point.d - duration) > DURATION_TOLERANCE_S) return null
  if (point.t < RESUME_MIN_POSITION_S || point.t > duration - RESUME_END_MARGIN_S) return null
  return point.t
}

/** Entries to keep: the newest MAX_ENTRIES. */
export function trim(stored: Stored): Stored {
  const keys = Object.keys(stored)
  if (keys.length <= MAX_ENTRIES) return stored
  keys.sort((a, b) => stored[b]!.at - stored[a]!.at)
  return Object.fromEntries(keys.slice(0, MAX_ENTRIES).map((k) => [k, stored[k]!]))
}

/** Changes made here and not saved yet: a point, or null to forget the entry. */
const dirty = new Map<string, ResumePoint | null>()
let timer: ReturnType<typeof setTimeout> | null = null

/** The saved position of an entry, before any change made in this window. */
export async function readResume(entryId: number): Promise<ResumePoint | undefined> {
  const settings = mediaPort().settings
  const key = String(entryId)
  if (dirty.has(key)) return dirty.get(key) ?? undefined
  if (!settings) return undefined
  try {
    return parseStored(await settings.read(RESUME_KEY))[key]
  } catch {
    return undefined
  }
}

/**
 * Remembers where a video is (seconds), or forgets it when it is short, at
 * its start or near its end. Written after a short pause, merged into what
 * the other app saved meanwhile.
 */
export function recordResume(entryId: number, seconds: number, duration: number): void {
  if (!Number.isFinite(seconds) || !Number.isFinite(duration)) return
  if (duration < RESUME_MIN_DURATION_S) return
  const keep = seconds >= RESUME_MIN_POSITION_S && seconds <= duration - RESUME_END_MARGIN_S
  dirty.set(String(entryId), keep ? { t: seconds, d: duration, at: Date.now() } : null)
  if (!timer) timer = setTimeout(() => void flushResume(), SAVE_DELAY_MS)
}

/** Writes pending changes now (pause, close, page hide). */
export async function flushResume(): Promise<void> {
  if (timer) clearTimeout(timer)
  timer = null
  const settings = mediaPort().settings
  if (!settings || dirty.size === 0) {
    dirty.clear()
    return
  }
  const changes = [...dirty]
  dirty.clear()
  try {
    const stored = parseStored(await settings.read(RESUME_KEY))
    for (const [key, point] of changes) {
      if (point) stored[key] = point
      else delete stored[key]
    }
    await settings.write(RESUME_KEY, trim(stored))
  } catch {
    // A position is a convenience; a failed save is not shown.
  }
}

/** Tests. */
export function resetResume(): void {
  if (timer) clearTimeout(timer)
  timer = null
  dirty.clear()
}
