import { forwardRef, useImperativeHandle, useRef, useState } from "react"
import { Tooltip } from "@panelyth/ui"
import {
  archivePath,
  canGoRoot,
  canGoUp,
  goRoot,
  goUp,
  openPath,
  openRemoteDir,
  remoteUrl,
  setFilter,
  toPanelError,
  useListingStore,
} from "../features/listing"
import type { Side } from "../features/panels"
import { t } from "@panelyth/i18n"

export interface PathBarHandle {
  edit(): void
  /** Ctrl+S: edit the quick filter (Stage C06). */
  editFilter(): void
}

/** Typing filters live after this pause; Enter applies at once. */
const FILTER_DELAY_MS = 150

/** ".." and "/": muted, and dimmed with no hover while there is nowhere to go. */
const pathButton =
  "ml-1 h-6 w-7 shrink-0 rounded font-mono font-normal text-muted enabled:hover:bg-raised enabled:hover:text-text disabled:opacity-35"

interface PathBarProps {
  side: Side
  active: boolean
  /** Called after editing ends, so focus returns to the list. */
  onDone(): void
}

/** The current path; a click or Alt+D edits it, Enter navigates, Esc cancels (UX-DESIGN "Path bar"). */
export const PathBar = forwardRef<PathBarHandle, PathBarProps>(function PathBar(
  { side, active, onDone },
  ref,
) {
  const path = useListingStore((s) => s[side].path)
  const loading = useListingStore((s) => s[side].loading)
  const branch = useListingStore((s) => s[side].branch)
  const find = useListingStore((s) => s[side].find)
  const archive = useListingStore((s) => s[side].archive)
  const remote = useListingStore((s) => s[side].remote)
  const filter = useListingStore((s) => s[side].filter)
  // At the root ".." and "/" have nowhere to go (Backspace and Ctrl+\ do nothing there either).
  const upAllowed = useListingStore((s) => canGoUp(s[side]))
  const rootAllowed = useListingStore((s) => canGoRoot(s[side]))
  const [editing, setEditing] = useState(false)
  const [filtering, setFiltering] = useState(false)
  const [filterValue, setFilterValue] = useState("")
  const filterTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Enter or Esc ended the edit; the blur that follows must not apply the old text. */
  const filterEnded = useRef(false)
  const [value, setValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const edit = (): void => {
    // On a connection the field holds the folder on the server.
    setValue(remote ? remote.path : path)
    setError(null)
    setEditing(true)
    queueMicrotask(() => input.current?.select())
  }
  const editFilter = (): void => {
    setFilterValue(filter)
    filterEnded.current = false
    setFiltering(true)
  }
  useImperativeHandle(ref, () => ({ edit, editFilter }))

  const applyFilter = (value: string, delay: number): void => {
    if (filterTimer.current) clearTimeout(filterTimer.current)
    filterTimer.current = null
    if (delay === 0) setFilter(side, value)
    else filterTimer.current = setTimeout(() => setFilter(side, value), delay)
  }
  const stopFilter = (value: string): void => {
    filterEnded.current = true
    applyFilter(value, 0)
    setFiltering(false)
    onDone()
  }

  const stop = (): void => {
    setEditing(false)
    setError(null)
    onDone()
  }

  const submit = async (): Promise<void> => {
    const target = value.trim()
    if (target === "" || target === (remote ? remote.path : path)) return stop()
    try {
      // On a connection: "/pub/photos" is a folder on the server, also when
      // pasted as the address the bar shows. Anything else is a folder of
      // this computer, and leaves the connection.
      const url = remote ? remoteUrl({ ...remote, path: "" }) : null
      const onServer = url !== null && target.startsWith(url) ? target.slice(url.length) : target
      if (remote && onServer.startsWith("/")) {
        await openRemoteDir(side, remote, onServer, { inline: true })
      } else await openPath(side, target, { inline: true })
      stop()
    } catch (e) {
      setError(toPanelError(e).message)
    }
  }

  return (
    <div className="relative flex h-8 shrink-0 items-center border-b border-border bg-chrome px-2 text-xs">
      {editing ? (
        <input
          ref={input}
          aria-label={t("Path")}
          aria-invalid={error !== null}
          aria-describedby={error ? `${side}-path-error` : undefined}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value)
            setError(null)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === "Enter") void submit()
            else if (e.key === "Escape") stop()
          }}
          onBlur={() => {
            if (!error) setEditing(false)
          }}
          className="h-6 w-full rounded border border-accent bg-canvas px-1.5 font-mono font-normal text-text outline-none"
        />
      ) : (
        <>
          {(branch || find) && (
            <Tooltip content={t("Back to the folder (Backspace)")}>
              <button
                type="button"
                tabIndex={-1}
                onClick={() => void goUp(side)}
                data-testid={`location-${side}`}
                className="mr-1 h-6 max-w-[50%] shrink-0 truncate rounded bg-accent/15 px-1.5 text-accent hover:bg-accent/25"
              >
                {find ? t("Search results: {label}", { label: find.label }) : t("Branch view")}
              </button>
            </Tooltip>
          )}
          {remote && (
            <Tooltip
              content={
                remote.encrypted
                  ? t("Encrypted connection (TLS)")
                  : t("Not encrypted: the password and the files can be read on the way.")
              }
            >
              <span
                data-testid={`remote-${side}`}
                data-encrypted={remote.encrypted}
                className={`mr-1 h-6 max-w-[40%] shrink-0 truncate rounded px-1.5 leading-6 ${remote.encrypted ? "bg-accent/15 text-accent" : "bg-danger/15 text-danger"}`}
              >
                {remote.encrypted ? t("FTPS") : t("Not encrypted")}
              </span>
            </Tooltip>
          )}
          {remote !== null && remote.rejected > 0 && (
            <Tooltip
              content={t(
                "Entries whose names can't be used safely on this computer are not listed.",
              )}
            >
              <span
                data-testid={`rejected-${side}`}
                className="mr-1 h-6 shrink-0 rounded bg-raised px-1.5 leading-6 text-muted"
              >
                {t("{count, plural, one {# name left out} other {# names left out}}", {
                  count: remote.rejected,
                })}
              </span>
            </Tooltip>
          )}
          <Tooltip content={t("Edit the path (Alt+D)")}>
            <button
              type="button"
              tabIndex={-1}
              onClick={edit}
              data-testid={`path-${side}`}
              aria-busy={loading}
              className={`h-6 min-w-0 flex-1 truncate rounded px-1.5 text-left font-mono font-normal hover:bg-raised ${active ? "text-text" : "text-muted"}`}
            >
              {remote
                ? remoteUrl(remote)
                : archive
                  ? archivePath(path, archive)
                  : path || t("No folder open")}
            </button>
          </Tooltip>
          {filtering ? (
            <input
              aria-label={t("Quick filter")}
              placeholder="*.jpg;*.png|*_small.*"
              autoFocus
              onFocus={(e) => e.target.select()}
              value={filterValue}
              spellCheck={false}
              onChange={(e) => {
                setFilterValue(e.target.value)
                applyFilter(e.target.value, FILTER_DELAY_MS)
              }}
              onKeyDown={(e) => {
                e.stopPropagation()
                // The field's own value: the state may not have rendered yet.
                if (e.key === "Enter") stopFilter(e.currentTarget.value)
                else if (e.key === "Escape") stopFilter("")
              }}
              onBlur={(e) => {
                if (filterEnded.current) return
                applyFilter(e.currentTarget.value, 0)
                setFiltering(false)
              }}
              className="ml-1 h-6 w-40 shrink-0 rounded border border-accent bg-canvas px-1.5 font-mono text-text outline-none"
            />
          ) : (
            filter !== "" && (
              <Tooltip content={t("Quick filter (Ctrl+S); click to clear")}>
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setFilter(side, "")}
                  data-testid={`filter-${side}`}
                  className="ml-1 h-6 max-w-[40%] shrink-0 truncate rounded bg-accent/15 px-1.5 font-mono text-accent hover:bg-accent/25"
                >
                  {filter} ✕
                </button>
              </Tooltip>
            )
          )}
          <Tooltip content={t("Parent folder")}>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => void goUp(side)}
              disabled={!upAllowed}
              aria-label={t("Parent folder")}
              data-testid={`up-${side}`}
              className={pathButton}
            >
              ..
            </button>
          </Tooltip>
          <Tooltip content={t("Root (Ctrl+\\)")}>
            <button
              type="button"
              tabIndex={-1}
              onClick={() => void goRoot(side)}
              disabled={!rootAllowed}
              aria-label={t("Root (Ctrl+\\)")}
              data-testid={`root-${side}`}
              className={pathButton}
            >
              /
            </button>
          </Tooltip>
        </>
      )}
      {editing && error && (
        <p
          id={`${side}-path-error`}
          role="alert"
          className="glass-chip absolute top-full right-2 left-2 z-10 rounded-b border border-t-0 border-border bg-raised px-2 py-1 text-danger shadow"
        >
          {error}
        </p>
      )}
    </div>
  )
})
