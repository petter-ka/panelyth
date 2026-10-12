import type { Crumb, Place, Volume } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"
import { openPath, useListingStore } from "./listing"
import { otherSide, setActivePanel, type Side } from "./panels"

// Drives and places (Stage C03, CFR-09): the drive bar and the drive menus
// (Alt+F1 / Alt+F2) read one small store. Go reads each volume's space with
// a timeout, so a dead network share answers "not ready" instead of
// stalling; the menu opens at once with the last list and refreshes behind.
// Drives that come and go arrive as volumes.changed.

interface DrivesState {
  volumes: Volume[]
  places: Place[]
  /** Epoch ms of the last volume list (free space ages; refreshed after VOLUMES_TTL_MS). */
  at: number
  /** A refresh is in flight (the menu shows "Updating…"). */
  loading: boolean
  /** The drive menu, when open, and the panel it opens for. */
  menu: Side | null
}

export const VOLUMES_TTL_MS = 10_000

export const useDrivesStore = create<DrivesState>(() => ({
  volumes: [],
  places: [],
  at: 0,
  loading: false,
  menu: null,
}))

const set = useDrivesStore.setState
const get = useDrivesStore.getState

let inflight: Promise<void> | null = null

/** Re-reads the volumes (and places once); concurrent callers share one call. */
export function refreshVolumes(): Promise<void> {
  if (!isBridgeAvailable()) return Promise.resolve()
  inflight ??= (async () => {
    set({ loading: true })
    const [volumes, places] = await Promise.all([
      bridge.volumes().catch(() => null),
      get().places.length > 0 ? Promise.resolve(get().places) : bridge.places().catch(() => []),
    ])
    set({
      ...(volumes && { volumes, at: Date.now() }),
      places,
      loading: false,
    })
  })().finally(() => {
    inflight = null
  })
  return inflight
}

/** Refreshes when the list is older than the TTL (free space shown in the status line). */
export function ensureVolumes(): Promise<void> {
  return Date.now() - get().at > VOLUMES_TTL_MS ? refreshVolumes() : Promise.resolve()
}

const fold = (s: string): string => s.toLowerCase()

/** The volume holding a folder: the deepest crumb that is a volume root. */
export function volumeFor(volumes: readonly Volume[], crumbs: readonly Crumb[]): Volume | null {
  for (let i = crumbs.length - 1; i >= 0; i--) {
    const path = fold(crumbs[i]!.path)
    const hit = volumes.find((v) => fold(v.path) === path)
    if (hit) return hit
  }
  return null
}

/** "C" for a Windows drive root, else the label or the path. */
export function driveName(v: Volume): string {
  const letter = /^([A-Za-z]):[\\/]?$/.exec(v.path)
  if (letter) return letter[1]!.toUpperCase()
  return v.label || v.path
}

export function openDriveMenu(side: Side): void {
  setActivePanel(side)
  set({ menu: side })
  // Opens with the list it has; Go answers within its per-volume timeouts.
  void refreshVolumes()
}

export function closeDriveMenu(): void {
  set({ menu: null })
}

/**
 * Where a drive button leads. When the other panel is on that drive, it is
 * the other panel's folder (Total Commander's rule): one click puts both
 * panels in the same place. Otherwise, and when this panel already shows
 * that folder, it is the drive's root.
 */
export function driveTarget(side: Side, drive: string): string {
  const panels = useListingStore.getState()
  const other = panels[otherSide(side)]
  // A panel on a connection is on no drive: its folder of this computer is hidden behind it.
  if (other.dirId === null || other.remote || other.disconnected) return drive
  const volume = volumeFor(get().volumes, other.crumbs)
  if (!volume || fold(volume.path) !== fold(drive)) return drive
  const here = panels[side]
  const plain = !here.remote && !here.archive && !here.find && !here.branch
  return plain && fold(here.path) === fold(other.path) ? drive : other.path
}

/**
 * A drive button or menu entry: the drive opens in that panel, at the other
 * panel's folder when that panel is on it, else at its root (a drive not
 * ready shows its state there).
 */
export function openDrive(side: Side, path: string): Promise<void> {
  closeDriveMenu()
  setActivePanel(side)
  return openPath(side, driveTarget(side, path))
}

/** A place of the drive menu (Home, Documents, …): always that folder. */
export function openPlace(side: Side, path: string): Promise<void> {
  closeDriveMenu()
  setActivePanel(side)
  return openPath(side, path)
}

/** Follows volumes.changed; the first list is read now. */
export function startDrives(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  void refreshVolumes()
  return bridge.on("volumes.changed", ({ volumes }) => set({ volumes, at: Date.now() }))
}

/** Tests. */
export function resetDrives(): void {
  inflight = null
  set({ volumes: [], places: [], at: 0, loading: false, menu: null })
}
