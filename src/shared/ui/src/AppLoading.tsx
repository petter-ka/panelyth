import type { AppId } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { create } from "zustand"
import { CommanderGlyph, ViewerGlyph } from "./AppSwitchButton"
import { Spinner } from "./Spinner"

/**
 * Loading states (docs/shared/APP-SWITCHING.md, "Loading screen"):
 * - `LoadingIndicator`: a spinner and a label on a small chip, for a picture
 *   or a video that is still loading. Over something already shown (a
 *   thumbnail, a poster) it fades in after a moment (styles.css,
 *   `.pending-fade`), so a load that answers at once never flashes it; over
 *   an empty canvas it shows at once.
 * - `AppLoadingOverlay` with `whileAppLoads`: covers an app's content while
 *   it opens the folder carried over by an app switch, or while it starts.
 */

export function LoadingIndicator({
  label = t("Loading…"),
  compact = false,
  delayed = true,
}: {
  label?: string
  /** Only the ring, for a corner over a picture already shown. */
  compact?: boolean
  /** Fades in after a moment; off where the caller has waited already. */
  delayed?: boolean
}) {
  return (
    <div
      role="status"
      data-testid="loading-indicator"
      className={`glass-chip relative pointer-events-none flex items-center ${delayed ? "pending-fade" : "loading-now"} gap-2 rounded-full border border-border bg-chrome-solid/90 text-xs text-muted shadow-md ${compact ? "p-1.5" : "px-3 py-1.5"}`}
    >
      <Spinner size={compact ? 14 : 16} />
      <span className={compact ? "sr-only" : ""}>{label}</span>
    </div>
  )
}

/** Shown only after this long, so a quick switch never flashes the screen. */
const SHOW_AFTER_MS = 120
/** Once shown, kept at least this long, so it does not blink away. */
const MIN_SHOWN_MS = 200
/** Never longer: the app's own empty, loading and error states take over. */
const MAX_SHOWN_MS = 10_000
/** How long `settled` may keep the screen after the work is done. */
const SETTLE_LIMIT_MS = 1_000

interface AppLoadingState {
  pending: number
  visible: boolean
  label: string
}

export const useAppLoading = create<AppLoadingState>(() => ({
  pending: 0,
  visible: false,
  label: "",
}))

let showTimer: ReturnType<typeof setTimeout> | null = null
let hideTimer: ReturnType<typeof setTimeout> | null = null
let capTimer: ReturnType<typeof setTimeout> | null = null
let shownAt = 0

function clear(timer: ReturnType<typeof setTimeout> | null): null {
  if (timer !== null) clearTimeout(timer)
  return null
}

function show(): void {
  showTimer = clear(showTimer)
  if (useAppLoading.getState().pending === 0) return
  shownAt = performance.now()
  useAppLoading.setState({ visible: true })
  capTimer = clear(capTimer)
  capTimer = setTimeout(hide, MAX_SHOWN_MS)
}

function hide(): void {
  hideTimer = clear(hideTimer)
  capTimer = clear(capTimer)
  useAppLoading.setState({ visible: false })
}

/** Resolves once `settled()` holds (checked each frame), or after a second at most. */
function waitUntil(settled: () => boolean): Promise<void> {
  const start = performance.now()
  return new Promise((resolve) => {
    const check = (): void => {
      if (settled() || performance.now() - start > SETTLE_LIMIT_MS) resolve()
      else requestAnimationFrame(check)
    }
    check()
  })
}

/**
 * Runs `work` behind the app's loading screen: the screen shows when the
 * work takes longer than a moment (at once with `immediate`) and goes when
 * it and every other piece of work behind it are done. `settled` keeps it
 * until what the work started has reached the screen (the first page of a
 * folder). A failure goes through to the caller.
 */
export async function whileAppLoads<T>(
  work: Promise<T>,
  options: { label: string; immediate?: boolean; settled?: () => boolean },
): Promise<T> {
  const { pending, visible } = useAppLoading.getState()
  useAppLoading.setState({ pending: pending + 1, label: options.label })
  hideTimer = clear(hideTimer)
  if (!visible && showTimer === null) {
    if (options.immediate) show()
    else showTimer = setTimeout(show, SHOW_AFTER_MS)
  }
  try {
    const result = await work
    if (options.settled) await waitUntil(options.settled)
    return result
  } finally {
    const left = useAppLoading.getState().pending - 1
    useAppLoading.setState({ pending: left })
    if (left === 0) {
      showTimer = clear(showTimer)
      if (useAppLoading.getState().visible) {
        const wait = Math.max(0, MIN_SHOWN_MS - (performance.now() - shownAt))
        hideTimer = setTimeout(hide, wait)
      }
    }
  }
}

/**
 * The work behind the screen is about to clear what is shown (a new folder
 * replaces the tiles): show the screen now instead of after a moment.
 */
export function showAppLoadingNow(): void {
  const { pending, visible } = useAppLoading.getState()
  if (pending > 0 && !visible) show()
}

/** Tests. */
export function resetAppLoading(): void {
  showTimer = clear(showTimer)
  hideTimer = clear(hideTimer)
  capTimer = clear(capTimer)
  useAppLoading.setState({ pending: 0, visible: false, label: "" })
}

/**
 * The app's loading screen over its content (the rail stays usable): the
 * app's glyph and a loading chip on the chrome, or on the wallpaper in the
 * glass style. Place it in the app's root, which must be positioned; it is
 * absolutely positioned (styles.css, `.app-curtain`), so it takes no part in
 * the root's grid.
 */
export function AppLoadingOverlay({ app, rail = true }: { app: AppId; rail?: boolean }) {
  const visible = useAppLoading((s) => s.visible)
  const label = useAppLoading((s) => s.label)
  if (!visible) return null
  const Glyph = app === "viewer" ? ViewerGlyph : CommanderGlyph
  return (
    <div
      data-testid="app-loading"
      aria-busy="true"
      className="app-curtain motion-fade z-40 flex flex-col items-center justify-center gap-4 bg-chrome text-muted"
      data-state="open"
      data-rail={rail || undefined}
    >
      <Glyph size={32} />
      <LoadingIndicator label={label} delayed={false} />
    </div>
  )
}
