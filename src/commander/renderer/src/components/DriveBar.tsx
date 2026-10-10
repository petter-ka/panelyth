import type { Volume, VolumeKind } from "@panelyth/contracts"
import { Tooltip } from "@panelyth/ui"
import { useEffect, useMemo } from "react"
import {
  closeDriveMenu,
  driveName,
  ensureVolumes,
  openDrive,
  openDriveMenu,
  useDrivesStore,
  volumeFor,
} from "../features/drives"
import { formatBytes } from "../features/format"
import { useListingStore } from "../features/listing"
import type { Side } from "../features/panels"
import { dropTarget } from "./panelDnd"
import { PopupMenu, type MenuEntry } from "./PopupMenu"

const MARKERS: Partial<Record<VolumeKind, string>> = {
  removable: "removable",
  network: "network",
  optical: "optical",
}

export function spaceText(v: Volume): string {
  if (v.notReady) return "not ready"
  if (v.freeBytes === undefined || !v.totalBytes) return ""
  return `${formatBytes(v.freeBytes)} free of ${formatBytes(v.totalBytes)}`
}

const driveTitle = (v: Volume): string =>
  [v.path, v.label, MARKERS[v.kind], spaceText(v)].filter(Boolean).join(" · ")

/** The volume holding the panel's folder (shared by the drive bar and the status line). */
export function usePanelVolume(side: Side): Volume | null {
  const crumbs = useListingStore((s) => s[side].crumbs)
  const volumes = useDrivesStore((s) => s.volumes)
  // Free space ages: an old list is refreshed after a navigation.
  useEffect(() => {
    if (crumbs.length > 0) void ensureVolumes()
  }, [crumbs])
  return useMemo(() => volumeFor(volumes, crumbs), [volumes, crumbs])
}

/**
 * The drive bar (Stage C03, CFR-09): a button per drive with the panel's
 * drive pressed, and the drive menu (Alt+F1 / Alt+F2) with labels, space,
 * and removable and network markers. A drive that isn't ready opens to its
 * error state in the panel; nothing here waits on a drive.
 */
export function DriveBar({ side }: { side: Side }) {
  const volumes = useDrivesStore((s) => s.volumes)
  const current = usePanelVolume(side)
  const menuOpen = useDrivesStore((s) => s.menu === side)
  return (
    <div
      role="toolbar"
      aria-label={`${side === "left" ? "Left" : "Right"} drives`}
      data-testid={`drives-${side}`}
      className="flex h-7 shrink-0 items-center gap-0.5 overflow-hidden border-b border-border bg-chrome px-1.5 text-[0.6875rem]"
    >
      <Tooltip content={`Drive menu (${side === "left" ? "Alt+F1" : "Alt+F2"})`}>
        <button
          type="button"
          tabIndex={-1}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label="Drive menu"
          onClick={() => (menuOpen ? closeDriveMenu() : openDriveMenu(side))}
          className="mr-1 flex h-5 items-center gap-1 rounded px-1.5 font-medium text-text hover:bg-raised"
        >
          {current ? driveName(current) : "Drives"}
          <span aria-hidden="true" className="text-muted">
            ▾
          </span>
        </button>
      </Tooltip>
      {volumes.map((v) => {
        const pressed = current?.path === v.path
        return (
          <Tooltip key={v.path} content={driveTitle(v)}>
            <button
              type="button"
              tabIndex={-1}
              aria-pressed={pressed}
              data-not-ready={v.notReady || undefined}
              onClick={() => void openDrive(side, v.path)}
              {...dropTarget(side, () => (v.notReady ? null : { path: v.path, dirId: null }))}
              className={`h-5 max-w-24 min-w-6 truncate rounded px-1.5 font-medium ${pressed ? "bg-raised text-text ring-1 ring-accent/60" : "text-muted hover:bg-raised hover:text-text"} ${v.notReady ? "opacity-50" : ""}`}
            >
              {driveName(v)}
            </button>
          </Tooltip>
        )
      })}
      <span className="flex-1" />
      {current && spaceText(current) && (
        <span className="shrink-0 truncate pl-2 text-muted tabular-nums">{spaceText(current)}</span>
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
  const entries = useMemo<MenuEntry[]>(() => {
    const out: MenuEntry[] = [{ id: "h-drives", label: "Drives", heading: true }]
    for (const v of volumes) {
      const name = driveName(v)
      out.push({
        id: `drive-${v.path}`,
        label: (
          <span className="flex items-center gap-2">
            <span className="font-medium">{name}</span>
            {v.label && v.label !== name && <span className="text-muted">{v.label}</span>}
            {MARKERS[v.kind] && (
              <span className="rounded border border-border px-1 text-[0.625rem] text-muted">
                {MARKERS[v.kind]}
              </span>
            )}
          </span>
        ),
        detail: spaceText(v),
        current: current?.path === v.path,
        ...(name.length === 1 && { accessKey: name }),
        onSelect: () => void openDrive(side, v.path),
      })
    }
    if (places.length > 0) {
      out.push({ id: "h-places", label: "Places", heading: true })
      for (const p of places) {
        out.push({
          id: `place-${p.id}`,
          label: p.label,
          detail: p.path,
          onSelect: () => void openDrive(side, p.path),
        })
      }
    }
    return out
  }, [volumes, places, current, side])
  if (!open) return null
  return (
    <PopupMenu
      label={`Drives, ${side} panel`}
      testId={`drive-menu-${side}`}
      entries={entries}
      onClose={closeDriveMenu}
      footer={
        loading && <p className="px-3 pt-1 pb-0.5 text-[0.6875rem] text-muted">Updating drives…</p>
      }
    />
  )
}
