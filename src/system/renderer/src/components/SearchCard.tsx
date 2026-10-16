import type { ContentItem } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import { Button, fieldLook, SearchIcon, Spinner, TypeGlyph, type GlyphName } from "@panelyth/ui"
import { useVirtualizer } from "@tanstack/react-virtual"
import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { formatBytes, formatCount } from "../features/format"
import {
  chooseRootsOnce,
  loadPage,
  PAGE,
  setSearchText,
  showInCommander,
  startSearch,
  stopSearch,
  toggleRoot,
  useSearchStore,
} from "../features/search"
import { useSystemStore } from "../features/system"
import { Card, measured } from "./Dashboard"

/** Results rows are this high: the name over its folder. */
export const ROW = 40

const ARCHIVES = new Set(["zip", "7z", "rar", "tar", "gz", "tgz", "bz2", "xz", "zst"])
const AUDIO = new Set(["mp3", "wav", "flac", "aac", "m4a", "ogg", "opus", "wma"])
const TEXTS = new Set(["txt", "md", "log", "csv", "json", "xml", "yaml", "yml", "ini", "toml"])
const PROGRAMS = new Set(["exe", "msi", "bat", "cmd", "ps1", "com", "sh", "app"])

/** The row's type icon, by kind and extension. */
export function glyphOf(item: ContentItem): GlyphName {
  if (item.kind === "dir") return "folder"
  if (item.kind === "image") return "image"
  if (item.kind === "video") return "video"
  if (item.kind === "link") return "link"
  if (item.ext === "pdf") return "pdf"
  if (ARCHIVES.has(item.ext)) return "archive"
  if (AUDIO.has(item.ext)) return "audio"
  if (TEXTS.has(item.ext)) return "text"
  if (PROGRAMS.has(item.ext)) return "program"
  return "other"
}

const open = (item: ContentItem): void => void showInCommander(item).catch(() => undefined)

/** The volumes to search, as chips that toggle; every one that answers is ticked at first. */
function VolumeChips() {
  const volumes = useSystemStore((s) => s.volumes)
  const roots = useSearchStore((s) => s.roots)
  const running = useSearchStore((s) => s.status === "running")
  const ready = (volumes ?? []).filter((v) => !v.notReady)
  useEffect(() => {
    if (volumes) chooseRootsOnce(volumes.filter(measured).map((v) => v.path))
  }, [volumes])
  return (
    <div role="group" aria-label={t("Volumes to search")} className="flex flex-wrap gap-1.5">
      {ready.map((v) => {
        const on = roots.includes(v.path)
        return (
          <button
            key={v.path}
            type="button"
            aria-pressed={on}
            disabled={running}
            onClick={() => toggleRoot(v.path)}
            className={`glass-pill flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs disabled:opacity-60 ${
              on
                ? "border-accent text-accent"
                : "border-border text-muted enabled:hover:border-muted enabled:hover:text-text"
            }`}
            style={
              on ? { background: "color-mix(in srgb, var(--accent) 12%, transparent)" } : undefined
            }
          >
            <TypeGlyph glyph="drive" size={14} muted={!on} />
            <span className="font-mono font-semibold">{v.path}</span>
            {v.label && <span className="max-w-32 truncate">{v.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

/** Where the search is: searching (and where), found, stopped or failed. */
function SearchStatusLine() {
  const status = useSearchStore((s) => s.status)
  const progress = useSearchStore((s) => s.progress)
  const total = useSearchStore((s) => s.total)
  const error = useSearchStore((s) => s.error)
  if (status === "idle") {
    return <p className="text-2xs text-muted">{t("Type part of a name. No wildcards needed.")}</p>
  }
  const found = t("Found: {count}", { count: formatCount(total) })
  const looked = progress
    ? t("Folders searched: {count}", { count: formatCount(progress.dirs) })
    : ""
  return (
    <p
      className="flex min-w-0 items-center gap-2 text-2xs text-muted prose-nums"
      role="status"
      data-testid="search-status"
    >
      {status === "running" && <Spinner size={12} />}
      <span className={`shrink-0 font-medium ${status === "failed" ? "text-danger" : "text-text"}`}>
        {status === "failed" ? (error ?? t("The search failed.")) : found}
      </span>
      {status !== "failed" && looked && <span className="shrink-0">{looked}</span>}
      {status === "running" && progress?.current && (
        <span className="min-w-0 truncate" title={progress.current}>
          {progress.current}
        </span>
      )}
      {status === "stopped" && <span className="shrink-0">{t("Stopped")}</span>}
      {progress?.truncated && (
        <span className="shrink-0">{t("Showing the first results only.")}</span>
      )}
    </p>
  )
}

/** The results, virtualized: only the rows on screen exist, read a page at a time. */
function Results() {
  const total = useSearchStore((s) => s.total)
  const pages = useSearchStore((s) => s.pages)
  const version = useSearchStore((s) => s.version)
  const queryId = useSearchStore((s) => s.queryId)
  const [cursor, setCursor] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: total,
    getScrollElement: () => box.current,
    estimateSize: () => ROW,
    overscan: 8,
  })
  const rows = virtualizer.getVirtualItems()
  const first = rows[0]?.index ?? 0
  const last = rows.at(-1)?.index ?? -1

  // The pages of the rows on screen; a new version reads them again.
  useEffect(() => {
    if (queryId === null || last < 0) return
    for (let page = Math.floor(first / PAGE); page <= Math.floor(last / PAGE); page++) {
      void loadPage(page)
    }
  }, [queryId, version, first, last, pages])

  useEffect(() => setCursor(0), [queryId])

  const itemAt = (index: number): ContentItem | undefined =>
    pages.get(Math.floor(index / PAGE))?.[index % PAGE]

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (total === 0) return
    const page = Math.max(1, Math.floor((box.current?.clientHeight ?? ROW) / ROW) - 1)
    const moves: Record<string, number> = {
      ArrowDown: cursor + 1,
      ArrowUp: cursor - 1,
      PageDown: cursor + page,
      PageUp: cursor - page,
      Home: 0,
      End: total - 1,
    }
    if (e.key in moves) {
      e.preventDefault()
      const next = Math.min(total - 1, Math.max(0, moves[e.key]!))
      setCursor(next)
      virtualizer.scrollToIndex(next, { align: "auto" })
    } else if (e.key === "Enter") {
      const item = itemAt(cursor)
      if (item) {
        e.preventDefault()
        open(item)
      }
    }
  }

  if (total === 0) return null
  return (
    <div
      ref={box}
      tabIndex={0}
      role="listbox"
      aria-label={t("Search results")}
      aria-activedescendant={`result-${cursor}`}
      onKeyDown={onKeyDown}
      data-testid="search-results"
      className="min-h-40 flex-1 overflow-y-auto rounded-lg border border-border bg-canvas outline-none focus-visible:ring-1 focus-visible:ring-accent"
    >
      <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
        {rows.map((row) => {
          const item = itemAt(row.index)
          const current = row.index === cursor
          return (
            <div
              key={row.key}
              id={`result-${row.index}`}
              role="option"
              aria-selected={current}
              data-row={row.index}
              onClick={() => setCursor(row.index)}
              onDoubleClick={() => item && open(item)}
              className={`group absolute inset-x-0 flex items-center gap-2.5 px-3 ${
                current ? "" : "hover:bg-raised"
              }`}
              style={{
                top: row.start,
                height: ROW,
                background: current
                  ? "color-mix(in srgb, var(--accent) 16%, transparent)"
                  : undefined,
              }}
            >
              {item ? (
                <>
                  <TypeGlyph glyph={glyphOf(item)} size={18} />
                  <div className="min-w-0 flex-1 leading-tight">
                    <div className="truncate text-xs font-medium">{item.name}</div>
                    <div className="truncate text-3xs text-muted">{item.dirPath}</div>
                  </div>
                  {item.kind !== "dir" && (
                    <span className="shrink-0 text-2xs text-muted prose-nums">
                      {formatBytes(item.sizeBytes)}
                    </span>
                  )}
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation()
                      open(item)
                    }}
                    className={`glass-pill shrink-0 rounded-md border border-border bg-raised px-2 py-0.5 text-2xs hover:border-muted ${
                      current ? "" : "invisible group-hover:visible"
                    }`}
                  >
                    {t("Show in Commander")}
                  </button>
                </>
              ) : (
                <div className="h-3 w-1/3 rounded bg-skeleton" aria-hidden="true" />
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/**
 * Searching the volumes ticked, by name (ADR-0042). Enter searches; a result
 * opens in the commander on its folder, with the cursor on it.
 */
export function SearchCard() {
  const text = useSearchStore((s) => s.text)
  const status = useSearchStore((s) => s.status)
  const roots = useSearchStore((s) => s.roots)
  const running = status === "running"
  const canSearch = text.trim() !== "" && roots.length > 0
  return (
    <Card
      title={t("Search the volumes")}
      icon={<SearchIcon size={16} />}
      className="min-h-[24rem] md:col-span-2 xl:col-span-3"
      testId="search-card"
    >
      <form
        role="search"
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          if (running) stopSearch()
          else if (canSearch) void startSearch()
        }}
      >
        <label className="relative min-w-48 flex-1">
          <span className="sr-only">{t("Name to search for")}</span>
          <SearchIcon
            size={14}
            className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-muted"
          />
          <input
            type="search"
            value={text}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && running && stopSearch()}
            placeholder={t("Name to search for")}
            spellCheck={false}
            className={`h-9 w-full pr-3 pl-8 text-sm ${fieldLook}`}
            data-testid="search-text"
          />
        </label>
        {running ? (
          <Button type="submit" variant="secondary" className="h-9 px-4">
            {t("Stop")}
          </Button>
        ) : (
          <Button type="submit" variant="primary" className="h-9 px-4" disabled={!canSearch}>
            {t("Search")}
          </Button>
        )}
      </form>
      <VolumeChips />
      <SearchStatusLine />
      <Results />
    </Card>
  )
}
