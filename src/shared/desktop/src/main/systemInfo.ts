import { readFile } from "node:fs/promises"
import os from "node:os"
import type { SystemGpu, SystemHardware, SystemLoad } from "@panelyth/contracts"

/**
 * Panelyth System's view of the computer (ADR-0042), answered by main:
 * Node's `os` and Chromium's GPU info. Nothing here touches a disk but the
 * Linux distribution's name, read once.
 */

/** PCI vendor ids of the common graphics vendors. */
const VENDORS: Record<number, string> = {
  0x10de: "NVIDIA",
  0x1002: "AMD",
  0x1022: "AMD",
  0x8086: "Intel",
  0x106b: "Apple",
  0x5143: "Qualcomm",
  0x1414: "Microsoft",
  0x15ad: "VMware",
  0x80ee: "VirtualBox",
}

interface ChromiumGpuDevice {
  vendorId?: number
  deviceId?: number
  active?: boolean
  vendorString?: string
  deviceString?: string
  driverVendor?: string
  driverVersion?: string
}

interface ChromiumGpuInfo {
  gpuDevice?: ChromiumGpuDevice[]
  auxAttributes?: { glRenderer?: string }
}

/**
 * The graphics adapter's name from the renderer string when Chromium has no
 * device string: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0
 * ps_5_0, D3D11)" is "NVIDIA GeForce RTX 3070".
 */
export function rendererName(glRenderer: string): string {
  const angle = /^ANGLE \(([^,]*),\s*([^,]*?)(?:\s+Direct3D.*|\s+\(0x[0-9a-f]+\).*)?,/i.exec(
    glRenderer,
  )
  return (angle?.[2] ?? glRenderer).trim()
}

/** The graphics adapters, the one Chromium draws with first. */
export function gpusOf(info: unknown): SystemGpu[] {
  const { gpuDevice = [], auxAttributes } = (info ?? {}) as ChromiumGpuInfo
  const renderer = auxAttributes?.glRenderer ?? ""
  const gpus = gpuDevice
    .filter((d) => (d.vendorId ?? 0) !== 0 || d.deviceString)
    .map((d): SystemGpu => {
      const vendor = d.vendorString || VENDORS[d.vendorId ?? 0] || d.driverVendor || ""
      const name = d.deviceString || (d.active && renderer ? rendererName(renderer) : "") || vendor
      return { name, vendor, driver: d.driverVersion ?? "", active: d.active === true }
    })
  if (gpus.length === 0 && renderer) {
    return [{ name: rendererName(renderer), vendor: "", driver: "", active: true }]
  }
  return gpus.sort((a, b) => Number(b.active) - Number(a.active))
}

/**
 * The OS's name. Windows 11 still names itself "Windows 10" in the registry,
 * which `os.version()` reads: builds from 22000 on are Windows 11.
 */
export async function osName(
  platform: NodeJS.Platform = process.platform,
  version = os.version(),
  release = os.release(),
  macVersion = (process as { getSystemVersion?: () => string }).getSystemVersion?.(),
): Promise<string> {
  if (platform === "win32") {
    const build = Number(release.split(".")[2] ?? 0)
    return build >= 22000 ? version.replace(/^Windows 10\b/, "Windows 11") : version
  }
  if (platform === "darwin") return `macOS ${macVersion ?? release}`
  if (platform === "linux") {
    const text = await readFile("/etc/os-release", "utf8").catch(() => "")
    const pretty = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(text)?.[1]
    return pretty || `Linux ${release}`
  }
  return version
}

let hardware: Promise<SystemHardware> | null = null

/**
 * Read once: the OS, the CPU and the graphics adapters do not change while
 * the app runs. Uptime is read on each call.
 */
export async function systemHardware(gpuInfo: () => Promise<unknown>): Promise<SystemHardware> {
  hardware ??= (async (): Promise<SystemHardware> => {
    const cpus = os.cpus()
    return {
      os: {
        name: await osName(),
        release: os.release(),
        arch: os.arch(),
        platform: process.platform,
      },
      hostname: os.hostname(),
      uptimeMs: 0,
      cpu: {
        model: (cpus[0]?.model ?? "").replace(/\s+/g, " ").trim(),
        threads: os.availableParallelism?.() ?? cpus.length,
        speedMhz: cpus[0]?.speed ?? 0,
      },
      memoryBytes: os.totalmem(),
      gpus: gpusOf(await gpuInfo().catch(() => null)),
    }
  })()
  return { ...(await hardware), uptimeMs: Math.round(os.uptime() * 1000) }
}

/** CPU time per logical processor and memory, now: two `os` calls, no disk. */
export function systemLoad(): SystemLoad {
  return {
    at: Date.now(),
    cores: os.cpus().map(({ times }) => {
      const busyMs = times.user + times.nice + times.sys + times.irq
      return { busyMs, totalMs: busyMs + times.idle }
    }),
    freeMemoryBytes: os.freemem(),
    totalMemoryBytes: os.totalmem(),
  }
}
