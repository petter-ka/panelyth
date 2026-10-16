import { describe, expect, it } from "vitest"
import { gpusOf, osName, rendererName, systemLoad } from "../src/main/systemInfo"

// Panelyth System's readings in main (ADR-0042): names of the OS and the
// graphics adapters, and the CPU and memory sample.

describe("the OS name", () => {
  it("names Windows 11 by its build, which still reports Windows 10", async () => {
    expect(await osName("win32", "Windows 10 Pro", "10.0.26300")).toBe("Windows 11 Pro")
    expect(await osName("win32", "Windows 10 Pro", "10.0.19045")).toBe("Windows 10 Pro")
  })

  it("names macOS by its product version", async () => {
    expect(await osName("darwin", "Darwin Kernel", "24.1.0", "15.1")).toBe("macOS 15.1")
    expect(await osName("darwin", "Darwin Kernel", "24.1.0", undefined)).toBe("macOS 24.1.0")
  })
})

describe("graphics adapters", () => {
  it("takes the adapter's name from Chromium's renderer string", () => {
    expect(
      rendererName("ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)"),
    ).toBe("NVIDIA GeForce RTX 3070")
    expect(
      rendererName("ANGLE (Intel, Intel(R) UHD Graphics (0x00009A49) Direct3D11 vs_5_0, D3D11)"),
    ).toBe("Intel(R) UHD Graphics")
    expect(rendererName("Mesa Intel(R) Xe Graphics")).toBe("Mesa Intel(R) Xe Graphics")
  })

  it("lists the adapters, the one in use first, with vendor and driver", () => {
    const gpus = gpusOf({
      gpuDevice: [
        { vendorId: 0x8086, deviceId: 1, active: false, driverVersion: "31.0.101" },
        { vendorId: 0x10de, deviceId: 2, active: true, driverVersion: "32.0.15.7" },
      ],
      auxAttributes: {
        glRenderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 5080 Direct3D11 vs_5_0 ps_5_0, D3D11)",
      },
    })
    expect(gpus).toEqual([
      { name: "NVIDIA GeForce RTX 5080", vendor: "NVIDIA", driver: "32.0.15.7", active: true },
      { name: "Intel", vendor: "Intel", driver: "31.0.101", active: false },
    ])
  })

  it("prefers Chromium's device string and skips empty devices", () => {
    expect(
      gpusOf({
        gpuDevice: [
          { vendorId: 0, deviceId: 0 },
          { vendorId: 0x106b, active: true, deviceString: "Apple M3 Pro" },
        ],
      }),
    ).toEqual([{ name: "Apple M3 Pro", vendor: "Apple", driver: "", active: true }])
  })

  it("falls back on the renderer string, and on nothing", () => {
    expect(gpusOf({ auxAttributes: { glRenderer: "llvmpipe" } })).toEqual([
      { name: "llvmpipe", vendor: "", driver: "", active: true },
    ])
    expect(gpusOf(null)).toEqual([])
  })
})

describe("the load sample", () => {
  it("has busy and total time per logical processor and the memory", () => {
    const load = systemLoad()
    expect(load.cores.length).toBeGreaterThan(0)
    for (const core of load.cores) expect(core.totalMs).toBeGreaterThanOrEqual(core.busyMs)
    expect(load.totalMemoryBytes).toBeGreaterThan(load.freeMemoryBytes)
  })
})
