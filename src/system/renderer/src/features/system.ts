import type { SystemHardware, SystemLoad, Volume } from "@panelyth/contracts"
import { create } from "zustand"
import { bridge, isBridgeAvailable } from "../bridge"

/** One second of the computer's load: the dashboard's charts. */
export interface LoadPoint {
  at: number
  /** All processors together, 0..1. */
  cpu: number
  /** Each logical processor, 0..1. */
  cores: number[]
  /** Memory in use, 0..1. */
  memory: number
  usedBytes: number
  totalBytes: number
}

/** How many seconds of load the charts show. */
export const HISTORY = 60
/** Sampled this often while System is on screen. */
export const SAMPLE_MS = 1000
/** Volumes (free space) are read again this often while on screen. */
export const VOLUMES_MS = 15_000

const clamp = (v: number): number => Math.min(1, Math.max(0, v))

/** The load between two samples: busy time over all time, per processor. */
export function loadBetween(previous: SystemLoad, next: SystemLoad): LoadPoint {
  const cores = next.cores.map((core, i) => {
    const before = previous.cores[i]
    if (!before) return 0
    const total = core.totalMs - before.totalMs
    return total > 0 ? clamp((core.busyMs - before.busyMs) / total) : 0
  })
  const cpu = cores.length > 0 ? cores.reduce((sum, c) => sum + c, 0) / cores.length : 0
  const usedBytes = Math.max(0, next.totalMemoryBytes - next.freeMemoryBytes)
  return {
    at: next.at,
    cpu,
    cores,
    memory: next.totalMemoryBytes > 0 ? clamp(usedBytes / next.totalMemoryBytes) : 0,
    usedBytes,
    totalBytes: next.totalMemoryBytes,
  }
}

interface SystemState {
  hardware: SystemHardware | null
  hardwareFailed: boolean
  /** The last sample, to measure the next against. */
  sample: SystemLoad | null
  /** The last HISTORY seconds, oldest first. */
  history: LoadPoint[]
  volumes: Volume[] | null
  volumesFailed: boolean
}

export const useSystemStore = create<SystemState>(() => ({
  hardware: null,
  hardwareFailed: false,
  sample: null,
  history: [],
  volumes: null,
  volumesFailed: false,
}))

export async function sampleLoad(): Promise<void> {
  const next = await bridge.load()
  const { sample, history } = useSystemStore.getState()
  useSystemStore.setState({
    sample: next,
    history: sample ? [...history, loadBetween(sample, next)].slice(-HISTORY) : history,
  })
}

export async function readVolumes(): Promise<void> {
  try {
    useSystemStore.setState({ volumes: await bridge.volumes(), volumesFailed: false })
  } catch {
    useSystemStore.setState({ volumesFailed: true })
  }
}

async function readHardware(): Promise<void> {
  try {
    useSystemStore.setState({ hardware: await bridge.hardware(), hardwareFailed: false })
  } catch {
    useSystemStore.setState({ hardwareFailed: true })
  }
}

/**
 * Reads the computer once, then the load once a second and the volumes now
 * and then, only while System is on screen (ADR-0042): hidden behind another
 * app or minimized, it does nothing.
 */
export function startSystem(): () => void {
  if (!isBridgeAvailable()) return () => undefined
  let shown = true
  let loadTimer: ReturnType<typeof setInterval> | null = null
  let volumesTimer: ReturnType<typeof setInterval> | null = null
  const visible = (): boolean => shown && document.visibilityState !== "hidden"
  const stopTimers = (): void => {
    if (loadTimer) clearInterval(loadTimer)
    if (volumesTimer) clearInterval(volumesTimer)
    loadTimer = volumesTimer = null
  }
  const follow = (): void => {
    if (!visible()) {
      stopTimers()
      // A gap in the samples would read as a spike: start again from the next one.
      useSystemStore.setState({ sample: null })
      return
    }
    if (loadTimer) return
    // A sample that was still on its way when System was hidden is too old to measure against.
    useSystemStore.setState({ sample: null })
    void sampleLoad().catch(() => undefined)
    void readVolumes()
    loadTimer = setInterval(() => void sampleLoad().catch(() => undefined), SAMPLE_MS)
    volumesTimer = setInterval(() => void readVolumes(), VOLUMES_MS)
  }
  void readHardware()
  follow()
  const offShown = bridge.on("app.visibility", ({ app, visible: on }) => {
    if (app !== "system") return
    shown = on
    follow()
  })
  // Hidden, a change waits: the volumes are read again when System is shown.
  const offVolumes = bridge.on("volumes.changed", () => {
    if (visible()) void readVolumes()
  })
  document.addEventListener("visibilitychange", follow)
  return () => {
    stopTimers()
    offShown()
    offVolumes()
    document.removeEventListener("visibilitychange", follow)
  }
}

/** Tests. */
export function resetSystem(): void {
  useSystemStore.setState({
    hardware: null,
    hardwareFailed: false,
    sample: null,
    history: [],
    volumes: null,
    volumesFailed: false,
  })
}
