import type { Volume, VolumeKind } from "@panelyth/contracts"
import { Spinner, Tooltip } from "@panelyth/ui"
import { formatChord } from "@panelyth/renderer-core"
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  closeDriveMenu,
  driveName,
  ensureVolumes,
  fitDrives,
  openDrive,
  openDriveMenu,
  openPlace,
  useDrivesStore,
  volumeFor,
} from "../features/drives"
import { formatBytes } from "../features/format"
import { useKeymapStore } from "../features/keymap"
import { useListingStore } from "../features/listing"
import type { Side } from "../features/panels"
import {
  connect,
  disconnect,
  ensureConnections,
  hostLabel,
  openConnections,
  openQuickConnect,
  useRemoteStore,
} from "../features/remote"
import { dropTarget } from "./panelDnd"
import { PopupMenu, type MenuEntry } from "./PopupMenu"
import { msg, t } from "@panelyth/i18n"

const MARKERS: Partial<Record<VolumeKind, string>> = {
  removable: msg("removable"),
  network: msg("network"),
  optical: msg("optical"),
}

export function spaceText(v: Volume): string {
  if (v.notReady) return t("not ready")
  if (v.freeBytes === undefined || !v.totalBytes) return ""
  return t("{free} free of {total}", {
    free: formatBytes(v.freeBytes),
    total: formatBytes(v.totalBytes),
  })
}

const driveTitle = (v: Volume): string =>
  [v.path, v.label, MARKERS[v.kind] && t(MARKERS[v.kind]!), spaceText(v)]
    .filter(Boolean)
    .join(" · ")

/** A drive in a menu: name, label, marker and space (the drive menu and the … dropdown). */
function driveEntry(v: Volume, side: Side, current: Volume | null): MenuEntry {
  const name = driveName(v)
  return {
    id: `drive-${v.path}`,
    label: (
      <span className="flex items-center gap-2">
        <span className="font-medium">{name}</span>
        {v.label && v.label !== name && <span className="text-muted">{v.label}</span>}
        {MARKERS[v.kind] && (
          <span className="rounded border border-border px-1 text-3xs text-muted">
            {t(MARKERS[v.kind]!)}
          </span>
        )}
      </span>
    ),
    detail: spaceText(v),
    current: current?.path === v.path,
    ...(name.length === 1 && { accessKey: name }),
    onSelect: () => void openDrive(side, v.path),
  }
}

const NO_CRUMBS: readonly never[] = []

/** A small globe for the FTP button: drawn here, since the icon libraries have no server icon in use. */
const GlobeGlyph = () => (
  <svg
    width="11"
    height="11"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    aria-hidden="true"
  >
    <circle cx="8" cy="8" r="6.25" />
    <path d="M1.75 8h12.5M8 1.75c-2.2 2.6-2.2 9.9 0 12.5M8 1.75c2.2 2.6 2.2 9.9 0 12.5" />
  </svg>
)

/** The current key of Connections (the keymap's first chord), for tooltips and menus. */
function useConnectionsKey(): string {
  const chord = useKeymapStore((s) => s.keymap.chords["remote.connections"]?.[0])
  return chord ? formatChord(chord) : ""
}

/** The volume holding the panel's folder (shared by the drive bar and the status line). */
export function usePanelVolume(side: Side): Volume | null {
  // On a connection the panel is on no drive: its folder of this computer is behind it.
  const local = useListingStore((s) => s[side].crumbs)
  const onServer = useListingStore((s) => s[side].remote !== null)
  const crumbs = onServer ? NO_CRUMBS : local
  const volumes = useDrivesStore((s) => s.volumes)
  // Free space ages: an old list is refreshed after a navigation.
  useEffect(() => {
    if (crumbs.length > 0) void ensureVolumes()
  }, [crumbs])
  return useMemo(() => volumeFor(volumes, crumbs), [volumes, crumbs])
}

const DRIVE_GAP = 2 // gap-0.5
const MORE_WIDTH = 24 // the … button, w-6

/**
 * How many drive buttons fit the bar. A new drive list renders in full once
 * and its buttons are measured before paint; a resize refits from those
 * widths, so only a change of the count re-renders.
 */
function useDriveFit(volumes: readonly Volume[]) {
  const stripRef = useRef<HTMLDivElement>(null)
  const tailRef = useRef<HTMLDivElement>(null)
  const widths = useRef<number[]>([])
  // Free-space refreshes replace the list; only new names need measuring.
  const names = useMemo(() => volumes.map(driveName).join("\n"), [volumes])
  const [fit, setFit] = useState<{ names: string; shown: number } | null>(null)

  const refit = useCallback(() => {
    const strip = stripRef.current
    const tail = tailRef.current
    if (!strip || !tail) return
    const room = strip.clientWidth - tail.offsetWidth
    const shown = fitDrives(widths.current, room, MORE_WIDTH, DRIVE_GAP)
    setFit((prev) => (prev && prev.shown === shown ? prev : prev && { ...prev, shown }))
  }, [])

  useLayoutEffect(() => {
    const strip = stripRef.current
    const tail = tailRef.current
    if (!strip || !tail) return
    widths.current = Array.from(
      strip.querySelectorAll<HTMLElement>("[data-drive]"),
      (b) => b.offsetWidth,
    )
    const room = strip.clientWidth - tail.offsetWidth
    setFit({ names, shown: fitDrives(widths.current, room, MORE_WIDTH, DRIVE_GAP) })
  }, [names])

  useEffect(() => {
    const strip = stripRef.current
    const tail = tailRef.current
    if (!strip || !tail || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(refit)
    observer.observe(strip)
    observer.observe(tail)
    return () => observer.disconnect()
  }, [refit])

  const shown = fit?.names === names ? fit.shown : volumes.length
  return { stripRef, tailRef, shown }
}

/**
 * The drive bar (Stage C03, CFR-09): a button per drive with the panel's
 * drive pressed, and the drive menu (Alt+F1 / Alt+F2) with labels, space,
 * and removable and network markers. A drive the other panel is on opens at
 * that panel's folder, any other at its root. A drive that isn't ready opens
 * to its error state in the panel; nothing here waits on a drive.
 */
export function DriveBar({ side }: { side: Side }) {
  const volumes = useDrivesStore((s) => s.volumes)
  const current = usePanelVolume(side)
  const menuOpen = useDrivesStore((s) => s.menu === side)
  // The drive being opened (one that has to spin up or reconnect takes a while).
  const opening = useListingStore((s) => (s[side].loading ? s[side].loadingTarget : null))
  const remote = useListingStore((s) => s[side].remote)
  const connectionsKey = useConnectionsKey()
  const { stripRef, tailRef, shown } = useDriveFit(volumes)
  const hidden = volumes.slice(shown)
  const currentHidden = hidden.some((v) => v.path === current?.path)
  // The dropdown of the drives that don't fit, opened under the … button.
  const [more, setMore] = useState<{ left: number; top: number } | null>(null)
  // A click on … while its dropdown is open closes it (the dropdown's outside
  // press) and must not open it again.
  const moreClosedAt = useRef(0)
  const closeMore = useCallback(() => {
    moreClosedAt.current = performance.now()
    setMore(null)
  }, [])
  const moreEntries = useMemo<MenuEntry[]>(
    () => (more ? volumes.slice(shown).map((v) => driveEntry(v, side, current)) : []),
    [more, volumes, shown, side, current],
  )
  return (
    <div
      role="toolbar"
      aria-label={`${side === "left" ? "Left" : "Right"} drives`}
      data-testid={`drives-${side}`}
      className="flex h-7 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-chrome px-1.5 text-2xs"
    >
      <Tooltip content={`Drive menu (${side === "left" ? "Alt+F1" : "Alt+F2"})`}>
        <button
          type="button"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={t("Drive menu")}
          onClick={() => (menuOpen ? closeDriveMenu() : openDriveMenu(side))}
          className="mr-1 flex h-5 shrink-0 items-center gap-1 rounded px-1.5 font-medium whitespace-nowrap text-text hover:bg-raised"
        >
          {/* One line: a volume name with a space ("Macintosh HD") never wraps. */}
          {remote ? remote.label : current ? driveName(current) : t("Drives")}
          <span aria-hidden="true" className="text-muted">
            ▾
          </span>
        </button>
      </Tooltip>
      {/* The drives take the room left; the ones that don't fit go behind …. */}
      <div
        ref={stripRef}
        data-drive-strip=""
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      >
        {volumes.slice(0, shown).map((v) => {
          const pressed = current?.path === v.path
          return (
            <Tooltip key={v.path} content={driveTitle(v)}>
              <button
                type="button"
                tabIndex={-1}
                aria-pressed={pressed}
                aria-busy={opening === v.path || undefined}
                data-drive=""
                data-not-ready={v.notReady || undefined}
                onClick={() => void openDrive(side, v.path)}
                {...dropTarget(side, () => (v.notReady ? null : { path: v.path, dirId: null }))}
                className={`glass-press h-5 min-w-6 shrink-0 rounded px-1.5 font-medium whitespace-nowrap ${pressed ? "bg-raised text-text ring-1 ring-accent/60 ring-inset" : "text-muted hover:bg-raised hover:text-text"} ${v.notReady ? "opacity-50" : ""}`}
              >
                {opening === v.path && (
                  <Spinner size={10} className="mr-1 inline-block align-[-1px]" />
                )}
                {driveName(v)}
              </button>
            </Tooltip>
          )
        })}
        {hidden.length > 0 && (
          <Tooltip content={t("More drives")}>
            <button
              type="button"
              tabIndex={-1}
              aria-haspopup="menu"
              aria-expanded={more !== null}
              aria-label={t("More drives")}
              data-testid={`more-drives-${side}`}
              onClick={(e) => {
                if (performance.now() - moreClosedAt.current < 300) return
                const r = e.currentTarget.getBoundingClientRect()
                setMore({ left: r.left, top: r.bottom + 2 })
              }}
              className={`glass-press h-5 w-6 shrink-0 rounded font-medium ${currentHidden || more ? "bg-raised text-text ring-1 ring-accent/60 ring-inset" : "text-muted hover:bg-raised hover:text-text"}`}
            >
              …
            </button>
          </Tooltip>
        )}
        {more && hidden.length > 0 && (
          <PopupMenu
            label={t("More drives")}
            testId={`more-drives-menu-${side}`}
            entries={moreEntries}
            onClose={closeMore}
            style={{ position: "fixed", left: more.left, top: more.top }}
          />
        )}
        <div ref={tailRef} data-drive-tail="" className="flex shrink-0 items-center gap-0.5">
          {/* Servers are not drives: set apart by a divider, outlined, with a globe. */}
          <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-border" />
          <Tooltip
            content={
              connectionsKey
                ? t("Connections to FTP servers ({key})", { key: connectionsKey })
                : t("Connections to FTP servers")
            }
          >
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={remote !== null}
              data-testid={`connections-${side}`}
              onClick={() => openConnections(side)}
              className={`glass-press flex h-5 shrink-0 items-center gap-1 rounded-md border px-1.5 font-medium ${remote ? "border-accent/60 bg-raised text-text" : "border-border text-muted hover:border-muted hover:bg-raised hover:text-text"}`}
            >
              <GlobeGlyph />
              FTP
            </button>
          </Tooltip>
          {remote && (
            <Tooltip content={t("Disconnect (Ctrl+Shift+F)")}>
              <button
                type="button"
                tabIndex={-1}
                data-testid={`disconnect-${side}`}
                onClick={() => void disconnect(side)}
                className="h-5 shrink-0 rounded px-1.5 text-muted hover:bg-raised hover:text-text"
              >
                {t("Disconnect")}
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {current && spaceText(current) && (
        <span className="min-w-0 truncate pl-2 text-muted prose-nums">{spaceText(current)}</span>
      )}
    </div>
  )
}

/** Alt+F1 / Alt+F2: drives, then places (Home and the common folders). */
export function DriveMenu({ side }: { side: Side }) {
  const open = useDrivesStore((s) => s.menu === side)
  const volumes = useDrivesStore((s) => s.volumes)
  const places = useDrivesStore((s) => s.places)
  const loading = useDrivesStore((s) => s.loading)
  const current = usePanelVolume(side)
  const connections = useRemoteStore((s) => s.connections)
  const connectionsKey = useConnectionsKey()
  // The saved connections are read when the menu first opens; opening it connects to nothing.
  useEffect(() => {
    if (open) void ensureConnections()
  }, [open])
  const entries = useMemo<MenuEntry[]>(() => {
    const out: MenuEntry[] = [{ id: "h-drives", label: t("Drives"), heading: true }]
    for (const v of volumes) out.push(driveEntry(v, side, current))
    if (places.length > 0) {
      out.push({ id: "h-places", label: t("Places"), heading: true })
      for (const p of places) {
        out.push({
          id: `place-${p.id}`,
          label: t(p.label),
          detail: p.path,
          onSelect: () => void openPlace(side, p.path),
        })
      }
    }
    out.push({ id: "h-connections", label: t("Connections"), heading: true })
    for (const c of connections) {
      out.push({
        id: `connection-${c.id}`,
        label: c.name,
        detail: hostLabel(c),
        onSelect: () => void connect(side, { saved: c }),
      })
    }
    out.push({
      id: "connections",
      label: t("Connections…"),
      detail: connectionsKey || undefined,
      onSelect: () => openConnections(side),
    })
    out.push({
      id: "quick-connect",
      label: t("Quick connect…"),
      detail: "Ctrl+N",
      onSelect: () => openQuickConnect(side),
    })
    return out
  }, [volumes, places, current, side, connections, connectionsKey])
  if (!open) return null
  return (
    <PopupMenu
      label={side === "left" ? t("Drives, left panel") : t("Drives, right panel")}
      testId={`drive-menu-${side}`}
      entries={entries}
      onClose={closeDriveMenu}
      footer={
        loading && <p className="px-3 pt-1 pb-0.5 text-2xs text-muted">{t("Updating drives…")}</p>
      }
    />
  )
}
