import type { EditorState, Text } from "@codemirror/state"
import { createStore, type Store } from "../store"
import { countDocument, type CountOptions, type CountRange, type TextCounts } from "./wordCount"

// What the status bar shows of the editor, off the keystroke path: the cursor
// once per frame at most, the counts after a pause in typing, in slices.

export interface CursorState {
  line: number
  column: number
  /** Characters selected over all ranges. */
  selected: number
  /** Cursors and selections (more than 1 with multiple cursors). */
  ranges: number
}

export interface CountState {
  counts: TextCounts | null
  /** The counts are of the selection, not of the whole document. */
  ofSelection: boolean
}

export interface StatusModel {
  readonly cursor: Store<CursorState>
  readonly count: Store<CountState>
  /** The editor's state changed (from its update listener). */
  update(state: EditorState, docChanged: boolean, selectionSet: boolean): void
  destroy(): void
}

export interface StatusModelOptions extends Pick<
  CountOptions,
  "segmenter" | "yieldTo" | "sliceMs"
> {
  /** The pause after the last edit before counting (ms). */
  countDelayMs?: number
  /** Schedules the cursor's push; requestAnimationFrame in the window. */
  frame?: (run: () => void) => void
}

export function cursorOf(state: EditorState): CursorState {
  const main = state.selection.main
  const line = state.doc.lineAt(main.head)
  let selected = 0
  for (const r of state.selection.ranges) selected += r.to - r.from
  return {
    line: line.number,
    column: main.head - line.from + 1,
    selected,
    ranges: state.selection.ranges.length,
  }
}

function rangesOf(state: EditorState): { ranges: CountRange[]; ofSelection: boolean } {
  const ranges = state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => ({ from: r.from, to: r.to }))
  if (ranges.length > 0) return { ranges, ofSelection: true }
  return { ranges: [{ from: 0, to: state.doc.length }], ofSelection: false }
}

const sameRanges = (a: readonly CountRange[], b: readonly CountRange[]): boolean =>
  a.length === b.length && a.every((r, i) => r.from === b[i]!.from && r.to === b[i]!.to)

export function createStatusModel(
  initial: EditorState,
  options: StatusModelOptions = {},
): StatusModel {
  const delay = options.countDelayMs ?? 250
  const frame =
    options.frame ??
    ((run: () => void) =>
      typeof requestAnimationFrame === "function"
        ? requestAnimationFrame(() => run())
        : setTimeout(run, 16))
  const cursor = createStore<CursorState>(cursorOf(initial))
  const count = createStore<CountState>({ counts: null, ofSelection: false })
  let latest = initial
  let framePending = false
  let timer: ReturnType<typeof setTimeout> | null = null
  let run = 0
  // What the shown counts are of: a selection-only change with no selection keeps them.
  let countedDoc: Text | null = null
  let countedRanges: CountRange[] = []

  const startCount = (): void => {
    timer = null
    const state = latest
    const { ranges, ofSelection } = rangesOf(state)
    if (countedDoc === state.doc && sameRanges(ranges, countedRanges)) return
    const mine = ++run
    void countDocument(state.doc, ranges, {
      ...(options.segmenter !== undefined && { segmenter: options.segmenter }),
      ...(options.yieldTo && { yieldTo: options.yieldTo }),
      ...(options.sliceMs !== undefined && { sliceMs: options.sliceMs }),
      cancelled: () => mine !== run,
    }).then((counts) => {
      if (!counts || mine !== run) return
      countedDoc = state.doc
      countedRanges = ranges
      count.set({ counts, ofSelection })
    })
  }

  const scheduleCount = (wait: number): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(startCount, wait)
  }

  // The first count right away: the document is open, nobody is typing yet.
  scheduleCount(0)

  return {
    cursor,
    count,
    update(state, docChanged, selectionSet) {
      latest = state
      if (!docChanged && !selectionSet) return
      if (!framePending) {
        framePending = true
        frame(() => {
          framePending = false
          cursor.set(cursorOf(latest))
        })
      }
      // A newer edit cancels a count still running.
      run++
      scheduleCount(delay)
    },
    destroy() {
      run++
      if (timer !== null) clearTimeout(timer)
    },
  }
}
