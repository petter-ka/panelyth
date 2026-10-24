import type { Parser, Tree } from "@lezer/common"

// A whole-document parse that never holds the main thread for long: the
// parser advances a few milliseconds at a time and yields in between
// (Preview and the PDF export; the editor's own tree covers the viewport only).

export interface SliceOptions {
  /** How long one slice may run (ms). */
  sliceMs?: number
  /** Gives the next slice its turn: an idle callback in the window, a microtask in tests. */
  yieldTo?: (next: () => void) => void
  now?: () => number
  /** Stops the work (a newer render, a cancelled export). */
  cancelled?: () => boolean
}

export function idle(next: () => void): void {
  const ric = (
    globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }
  ).requestIdleCallback
  if (ric) ric(next, { timeout: 100 })
  else setTimeout(next, 0)
}

export interface Slicer {
  /** Time is up for this slice. */
  due(): boolean
  /** Waits for the next slice; false when cancelled meanwhile. */
  pause(): Promise<boolean>
}

export function slicer(options: SliceOptions = {}): Slicer {
  const sliceMs = options.sliceMs ?? 8
  const yieldTo = options.yieldTo ?? idle
  const now = options.now ?? (() => performance.now())
  const cancelled = options.cancelled ?? (() => false)
  let deadline = now() + sliceMs
  return {
    due: () => now() >= deadline,
    pause: () =>
      new Promise((resolve) =>
        yieldTo(() => {
          deadline = now() + sliceMs
          resolve(!cancelled())
        }),
      ),
  }
}

/** The tree of the whole text; null when cancelled. */
export async function parseInSlices(
  text: string,
  parser: Parser,
  options: SliceOptions = {},
): Promise<Tree | null> {
  const slices = slicer(options)
  const partial = parser.startParse(text)
  for (;;) {
    while (!slices.due()) {
      const tree = partial.advance()
      if (tree) return tree
    }
    if (!(await slices.pause())) return null
  }
}
