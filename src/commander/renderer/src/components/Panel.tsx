import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { Tooltip } from "@panelyth/ui"
import { useUiStore } from "../features/commands"
import { useQuickSearch } from "../features/quicksearch"
import {
  dismissError,
  leaveDisconnected,
  openHome,
  remoteUrl,
  retry,
  stopRemoteListing,
  useListingStore,
  type PanelErrorKind,
} from "../features/listing"
import { reconnect } from "../features/remote"
import type { Side } from "../features/panels"
import { BriefView } from "./BriefView"
import { DriveBar, DriveMenu } from "./DriveBar"
import { FullView, type FullViewHandle } from "./FullView"
import { ThumbsView } from "./ThumbsView"
import { HistoryMenu, HotlistMenu } from "./HotlistMenus"
import { HoldRing } from "./HoldRing"
import { PathBar, type PathBarHandle } from "./PathBar"
import { RowMenu } from "./RowMenu"
import { StatusLine } from "./StatusLine"
import { GitBar } from "./Git"
import { TabBar } from "./TabBar"
import { msg, t } from "@panelyth/i18n"

/** The quick-search box at the bottom of the panel (focus stays in the list). */
function QuickSearchBox({ side }: { side: Side }) {
  const open = useQuickSearch((s) => s.side === side)
  const text = useQuickSearch((s) => s.text)
  const missed = useQuickSearch((s) => s.missed)
  if (!open) return null
  return (
    <div
      role="search"
      aria-label={t("Quick search")}
      data-testid={`quicksearch-${side}`}
      data-missed={missed}
      className="glass-chip absolute bottom-2 left-2 z-10 flex items-center gap-2 rounded border border-accent bg-raised px-2 py-1 text-xs shadow-lg"
    >
      <span className="text-muted">{t("Search:")}</span>
      <span className={missed ? "text-danger" : "text-text"} aria-live="polite">
        {text}
      </span>
      <span className="text-2xs text-muted">{t("↑↓ next · Esc")}</span>
    </div>
  )
}

export interface PanelHandle {
  focus(): void
}

/** How long a server may take before the panel says it is waiting for it. */
const REMOTE_WAIT_MS = 400

/**
 * "Waiting for the server…" with Stop (Stage C10.5), mounted while a panel
 * waits for a listing. It shows only once the server takes a moment, so a
 * quick listing does not flash it.
 */
function RemoteWaiting({ side }: { side: Side }) {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setShown(true), REMOTE_WAIT_MS)
    return () => clearTimeout(timer)
  }, [])
  if (!shown) return null
  return (
    <div
      role="status"
      data-testid={`remote-busy-${side}`}
      className="glass-chip absolute right-2 bottom-2 z-10 flex items-center gap-2 rounded border border-border bg-raised px-2 py-1 text-xs shadow-lg"
    >
      <span className="text-muted">{t("Waiting for the server…")}</span>
      <Tooltip content="Esc">
        <button
          type="button"
          tabIndex={-1}
          onClick={() => stopRemoteListing(side)}
          className="rounded px-1 text-text hover:bg-canvas"
        >
          {t("Stop")}
        </button>
      </Tooltip>
    </div>
  )
}

interface PanelProps {
  side: Side
  active: boolean
  onActivate(): void
}

const TITLES: Record<PanelErrorKind, string> = {
  notFound: msg("Folder not found"),
  denied: msg("Permission denied"),
  notReady: msg("Drive not ready"),
  network: msg("Network location unavailable"),
  remote: msg("The server can't be reached"),
  other: msg("This folder can't be opened"),
}

/**
 * One file panel (ADR-0028): path bar, the Full, Brief or Thumbnails view, the status line, and
 * the listing states (CFR-28): loading, empty, permission denied, not found,
 * drive not ready, network unavailable.
 */
export const Panel = forwardRef<PanelHandle, PanelProps>(function Panel(
  { side, active, onActivate },
  ref,
) {
  const label = side === "left" ? t("Left panel") : t("Right panel")
  const list = useRef<FullViewHandle>(null)
  const pathBar = useRef<PathBarHandle>(null)
  useImperativeHandle(ref, () => ({ focus: () => list.current?.focus() }), [])

  const dirId = useListingStore((s) => s[side].dirId)
  const error = useListingStore((s) => s[side].error)
  const total = useListingStore((s) => s[side].query?.total ?? 0)
  const listing = useListingStore((s) => s[side].progress?.state === "running")
  const find = useListingStore((s) => s[side].find)
  const branch = useListingStore((s) => s[side].branch)
  const filter = useListingStore((s) => s[side].filter)
  const loading = useListingStore((s) => s[side].loading)
  const disconnected = useListingStore((s) => s[side].disconnected)
  const remoteBusy = useListingStore((s) => s[side].remoteBusy)
  const view = useListingStore((s) => s[side].view)
  // Ctrl+F1 / Ctrl+F2 / Ctrl+Shift+F1 replace the focused view: the new one takes the keys.
  const viewSeen = useRef(view)
  useEffect(() => {
    if (viewSeen.current === view) return
    viewSeen.current = view
    if (active) list.current?.focus()
  }, [view, active])

  // Alt+D (path.edit) from the keymap.
  const editToken = useUiStore((s) => s.editPath[side])
  const seenToken = useRef(editToken)
  useEffect(() => {
    // Only requests made after this panel mounted.
    if (editToken !== seenToken.current) pathBar.current?.edit()
    seenToken.current = editToken
  }, [editToken])

  // Ctrl+F or Ctrl+S (view.filter, Stage C06).
  const filterToken = useUiStore((s) => s.editFilter[side])
  const seenFilter = useRef(filterToken)
  useEffect(() => {
    if (filterToken !== seenFilter.current) pathBar.current?.editFilter()
    seenFilter.current = filterToken
  }, [filterToken])

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && error) {
      e.preventDefault()
      dismissError(side)
    } else if (e.key === "Escape" && remoteBusy && stopRemoteListing(side)) {
      // Esc stops waiting for a server; the panel keeps what it showed.
      e.preventDefault()
    }
  }

  let message: { title: string; detail?: string } | null = null
  if (dirId === null && !error) message = { title: loading ? t("Opening…") : t("No folder open") }
  else if (dirId !== null && total === 0 && !error && !loading) {
    message = listing
      ? { title: t("Listing…") }
      : { title: emptyTitle(find !== null, branch, filter !== "") }
  }

  return (
    <section
      aria-label={label}
      data-testid={`panel-${side}`}
      data-active={active}
      onMouseDown={onActivate}
      onKeyDown={onKeyDown}
      className={`glass-region relative flex h-full min-w-0 flex-col ${active ? "shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--accent)_22%,transparent)]" : ""}`}
    >
      {active && (
        // The active panel: a light line along the top that fades out at both
        // ends, a soft glow falling from it and a hairline frame. Overlays
        // only, so switching panels moves nothing.
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 z-20">
          <span className="block h-0.5 bg-linear-to-r from-transparent via-accent to-transparent" />
          <span className="block h-8 bg-linear-to-b from-[color-mix(in_srgb,var(--accent)_13%,transparent)] to-transparent" />
        </span>
      )}
      <DriveBar side={side} />
      <TabBar side={side} />
      <PathBar ref={pathBar} side={side} active={active} onDone={() => list.current?.focus()} />
      <div data-menu-area className="relative flex min-h-0 flex-1 flex-col">
        {view === "brief" ? (
          <BriefView
            ref={list}
            side={side}
            active={active}
            label={t("{panel} contents", { panel: label })}
          />
        ) : view === "thumbs" ? (
          <ThumbsView
            ref={list}
            side={side}
            active={active}
            label={t("{panel} contents", { panel: label })}
          />
        ) : (
          <FullView
            ref={list}
            side={side}
            active={active}
            label={t("{panel} contents", { panel: label })}
          />
        )}
        <QuickSearchBox side={side} />
        <DriveMenu side={side} />
        <HotlistMenu side={side} />
        <HistoryMenu side={side} />
        <RowMenu side={side} />
        <HoldRing side={side} />
        {message && (
          <div className="pointer-events-none absolute inset-x-0 top-14 text-center text-xs text-muted">
            {message.title}
          </div>
        )}
        {remoteBusy && <RemoteWaiting side={side} />}
        {disconnected && !error && (
          // A tab of a connection that is not open (after a restart, or once
          // it closed). Nothing connects until Connect is pressed (ADR-0037).
          <div
            role="status"
            data-testid={`disconnected-${side}`}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas-solid px-6 text-center"
          >
            <div>
              <p className="text-sm text-text">{t("Not connected")}</p>
              <p className="mt-1 font-mono text-xs break-all text-muted">
                {remoteUrl(disconnected)}
              </p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                disabled={loading}
                onClick={() => void reconnect(side)}
                className="rounded border border-accent px-2.5 py-1 text-text hover:bg-raised disabled:opacity-50"
              >
                {t("Connect")}
              </button>
              <button
                type="button"
                onClick={() => void leaveDisconnected(side)}
                className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
              >
                {t("Show the folder of this computer")}
              </button>
            </div>
          </div>
        )}
        {error && (
          <div
            role="alert"
            data-testid={`error-${side}`}
            data-kind={error.kind}
            className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-canvas-solid px-6 text-center"
          >
            <div>
              <p className="text-sm text-text">{t(TITLES[error.kind])}</p>
              <p className="mt-1 text-xs text-muted">{error.message}</p>
            </div>
            <div className="flex gap-2 text-xs">
              <button
                type="button"
                onClick={() => void retry(side)}
                className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
              >
                {t("Retry")}
              </button>
              {dirId !== null && (
                <Tooltip content="Esc">
                  <button
                    type="button"
                    onClick={() => dismissError(side)}
                    className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
                  >
                    {t("Back")}
                  </button>
                </Tooltip>
              )}
              <button
                type="button"
                onClick={() => void openHome(side)}
                className="rounded border border-border px-2.5 py-1 text-text hover:bg-raised"
              >
                {t("Home folder")}
              </button>
            </div>
          </div>
        )}
      </div>
      <GitBar side={side} />
      <StatusLine side={side} />
    </section>
  )
})

function emptyTitle(find: boolean, branch: boolean, filtered: boolean): string {
  if (filtered) return t("No files match the quick filter")
  if (find) return t("No files found")
  return branch ? t("No files below this folder") : t("This folder is empty")
}
