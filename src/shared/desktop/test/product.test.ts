import { APP_TARGETS } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import { aboutInfo, openTarget, PROJECT_URL, type TargetDeps } from "../src/main/product"

const deps = (patch: Partial<TargetDeps> = {}): TargetDeps => ({
  logsDir: () => "/logs",
  noticesPath: () => "/res/THIRD-PARTY-NOTICES.txt",
  exists: vi.fn(async () => true),
  openPath: vi.fn(async () => ""),
  openExternal: vi.fn(async () => undefined),
  ...patch,
})

describe("the fixed places main opens (Stage P06)", () => {
  it("opens the log folder and the notices as files of the app", async () => {
    const d = deps()
    await openTarget("logs", d)
    await openTarget("notices", d)
    expect(vi.mocked(d.openPath).mock.calls).toEqual([["/logs"], ["/res/THIRD-PARTY-NOTICES.txt"]])
    expect(d.openExternal).not.toHaveBeenCalled()
  })

  it("opens only pages of the project in the browser", async () => {
    const d = deps()
    for (const target of APP_TARGETS) await openTarget(target, d)
    const urls = vi.mocked(d.openExternal).mock.calls.map(([url]) => url)
    expect(urls).toEqual([`${PROJECT_URL}/releases`, `${PROJECT_URL}/issues`, PROJECT_URL])
    for (const url of urls) expect(new URL(url).protocol).toBe("https:")
  })

  it("says so when a build has no notices, and passes an open error on", async () => {
    await expect(openTarget("notices", deps({ exists: async () => false }))).rejects.toThrow(
      /packaged builds/,
    )
    await expect(openTarget("logs", deps({ openPath: async () => "no handler" }))).rejects.toThrow(
      "no handler",
    )
  })

  it("describes the build", () => {
    expect(
      aboutInfo({
        version: "1.2.0",
        sidecarVersion: "1.2.0+g1647109",
        packaged: true,
        versions: { electron: "44.5.1", chrome: "150.0.0.0", node: "24.1.0" },
        platform: "win32",
        arch: "x64",
      }),
    ).toEqual({
      name: "Panelyth",
      version: "1.2.0",
      sidecarVersion: "1.2.0+g1647109",
      electron: "44.5.1",
      chrome: "150.0.0.0",
      node: "24.1.0",
      platform: "win32 x64",
      packaged: true,
      copyright: "Copyright © Panelyth contributors",
    })
  })
})
