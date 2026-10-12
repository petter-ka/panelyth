// The editor's render scheduler (Stage 12, ADR-0035). While a control is
// dragged, requests arrive much faster than frames can be made. One render
// is in flight at a time; a newer request waits as the single queued one and
// replaces any older queued request. Every request carries a revision, so a
// frame that arrives after a newer one was shown is dropped.
import type { EditList, EditQuality, EditRenderResult } from "@panelyth/contracts"

export interface RenderRequest {
  editList: EditList
  quality: EditQuality
  maxEdge: number
  histogram: boolean
  /** Also ask for the histogram of the picture a tool is given (levels, curves). */
  histogramAt?: number
}

export interface SchedulerPort {
  render(rev: number, request: RenderRequest): Promise<EditRenderResult>
  /** A frame newer than every frame shown before. */
  onFrame(result: EditRenderResult, request: RenderRequest): void
  onError(error: unknown, request: RenderRequest): void
  /** True while a render is in flight or queued. */
  onBusy(busy: boolean): void
}

export interface Scheduler {
  request(request: RenderRequest): void
  /** Drops the queued request and ignores whatever is still in flight. */
  stop(): void
}

export function createScheduler(port: SchedulerPort, firstRev = 1): Scheduler {
  let rev = firstRev - 1
  let shown = 0
  let inFlight = false
  let queued: RenderRequest | null = null
  let stopped = false

  const pump = (): void => {
    if (inFlight || !queued || stopped) return
    const request = queued
    queued = null
    inFlight = true
    const mine = ++rev
    port.render(mine, request).then(
      (result) => {
        inFlight = false
        if (stopped) return
        // A superseded revision has no frame; an older one than what is
        // shown would move the picture backwards.
        if (!result.superseded && result.frame && mine > shown) {
          shown = mine
          port.onFrame(result, request)
        }
        if (queued) pump()
        else port.onBusy(false)
      },
      (error: unknown) => {
        inFlight = false
        if (stopped) return
        // A newer request is already waiting: its result is what matters.
        if (!queued) {
          port.onBusy(false)
          port.onError(error, request)
        } else pump()
      },
    )
  }

  return {
    request(request) {
      if (stopped) return
      queued = request
      port.onBusy(true)
      pump()
    },
    stop() {
      stopped = true
      queued = null
    },
  }
}
