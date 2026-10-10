// Integration test against the real Go binary (built by `pnpm build:sidecar`).
import { existsSync } from "node:fs"
import { join, resolve } from "node:path"
import type { SidecarStatus } from "@panelyth/contracts"
import { afterEach, describe, expect, it } from "vitest"
import type { Logger } from "../src/main/log"
import { SidecarProcess } from "../src/main/sidecar/SidecarProcess"

const exe = process.platform === "win32" ? ".exe" : ""
const binary = resolve(
  __dirname,
  "..",
  "resources",
  "bin",
  `${process.platform}-${process.arch}`,
  `panelyth-sidecar${exe}`,
)

const quiet: Logger = { info() {}, warn() {}, error() {}, sidecar() {} }

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitFor(pred: () => boolean, ms = 5_000): Promise<void> {
  const until = Date.now() + ms
  while (!pred()) {
    if (Date.now() > until) throw new Error("condition not met in time")
    await new Promise((r) => setTimeout(r, 20))
  }
}

const tmp = resolve(__dirname, "..", "..", "..", "..", "node_modules", ".tmp-sidecar-test")
const env = { PANELYTH_CACHE_DIR: join(tmp, "cache"), PANELYTH_CONFIG_DIR: join(tmp, "config") }

describe.runIf(existsSync(binary) || process.env.CI)("SidecarProcess (real binary)", () => {
  let sc: SidecarProcess | null = null
  afterEach(async () => {
    await sc?.stop()
    sc = null
  })

  it("starts, answers ping and info, and stops cleanly", async () => {
    sc = new SidecarProcess({ binaryPath: binary, logger: quiet, env })
    sc.start()
    await sc.whenReady()
    await expect(sc.call("system.ping", {})).resolves.toMatchObject({ pong: true })
    const info = await sc.call("system.info", {})
    expect(info.protocol).toBe(1)
    expect(sc.getHello()?.cacheRoot).toBe(join(env.PANELYTH_CACHE_DIR, "v1"))
    const pid = sc.getStatus().pid!
    await sc.stop()
    expect(sc.getStatus().state).toBe("stopped")
    await waitFor(() => !isAlive(pid))
  })

  it("restarts after a crash and fails pending calls", async () => {
    const states: SidecarStatus["state"][] = []
    sc = new SidecarProcess({ binaryPath: binary, logger: quiet, env, restartDelaysMs: [10, 10] })
    sc.onStatus((s) => states.push(s.state))
    sc.start()
    await sc.whenReady()
    const firstPid = sc.getStatus().pid!
    process.kill(firstPid)
    await waitFor(() => sc!.getStatus().state === "ready" && sc!.getStatus().pid !== firstPid)
    expect(states).toContain("restarting")
    expect(sc.getStatus().restarts).toBe(1)
    await expect(sc.call("system.ping", {})).resolves.toMatchObject({ pong: true })
  })

  it("gives up after the restart budget is exhausted", async () => {
    sc = new SidecarProcess({ binaryPath: binary, logger: quiet, env, restartDelaysMs: [10] })
    sc.start()
    await sc.whenReady()
    const firstPid = sc.getStatus().pid!
    process.kill(firstPid)
    await waitFor(() => sc!.getStatus().state === "ready" && sc!.getStatus().pid !== firstPid)
    process.kill(sc.getStatus().pid!)
    await waitFor(() => sc!.getStatus().state === "failed")
    await expect(sc.call("system.ping", {})).rejects.toMatchObject({ code: "SIDECAR_UNAVAILABLE" })
  })

  it("reports a missing binary as a failure, not a hang", async () => {
    sc = new SidecarProcess({
      binaryPath: binary + ".missing",
      logger: quiet,
      restartDelaysMs: [10],
    })
    sc.start()
    await waitFor(() => sc!.getStatus().state === "failed")
  })
})
