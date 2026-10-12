import { isUpdateState, MAX_RELEASE_NOTE_CHARS, type UpdateState } from "@panelyth/contracts"
import { describe, expect, it, vi } from "vitest"
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  notesToText,
  releaseNotes,
  resolveUpdateMode,
  scriptedEngine,
  updateErrorMessage,
  UpdateService,
  type DownloadProgress,
  type FoundUpdate,
  type Timers,
  type UpdateEngine,
} from "../src/main/updates"

const found: FoundUpdate = {
  version: "1.2.0",
  releaseDate: "2026-11-01T10:00:00.000Z",
  notes: [{ version: "1.2.0", text: "• Faster folders" }],
}

/** Timers a test fires by hand. */
function manualTimers() {
  const pending = new Map<number, { fn: () => void; ms: number }>()
  let next = 1
  const timers: Timers = {
    set: (fn, ms) => {
      pending.set(next, { fn, ms })
      return next++
    },
    clear: (handle) => void pending.delete(handle as number),
  }
  return {
    timers,
    delays: () => [...pending.values()].map((t) => t.ms),
    fire: () => {
      const [[id, timer] = []] = [...pending]
      if (id === undefined || !timer) throw new Error("no timer is pending")
      pending.delete(id)
      timer.fn()
    },
  }
}

interface Fake {
  engine: UpdateEngine
  check: ReturnType<typeof vi.fn<() => Promise<FoundUpdate | null>>>
  install: ReturnType<typeof vi.fn<() => void>>
  progress: (p: DownloadProgress) => void
  finishDownload: (error?: Error) => void
}

function fakeEngine(result: FoundUpdate | null | Error = found): Fake {
  let onProgress: (p: DownloadProgress) => void = () => undefined
  let finish: (error?: Error) => void = () => undefined
  const check = vi.fn(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  )
  const install = vi.fn<() => void>()
  return {
    engine: {
      check,
      download: (report) => {
        onProgress = report
        return new Promise<void>((resolve, reject) => {
          finish = (error) => (error ? reject(error) : resolve())
        })
      },
      install,
    },
    check,
    install,
    progress: (p) => onProgress(p),
    finishDownload: (error) => finish(error),
  }
}

function setup(fake = fakeEngine(), mode: UpdateState["mode"] = "auto") {
  const states: UpdateState[] = []
  const clock = { now: 1_000_000 }
  const manual = manualTimers()
  const load = vi.fn(() => Promise.resolve(fake.engine))
  const service = new UpdateService({
    mode,
    currentVersion: "1.1.0",
    engine: load,
    onState: (s) => states.push(s),
    now: () => clock.now,
    timers: manual.timers,
  })
  const phases = (): string[] => states.map((s) => s.phase)
  return { service, states, phases, clock, manual, fake, load }
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

describe("the update service (ADR-0038)", () => {
  it("finds a newer version and says what changed", async () => {
    const { service, phases, clock } = setup()
    expect(service.check().phase).toBe("checking")
    await settle()
    expect(phases()).toEqual(["checking", "available"])
    expect(service.state).toMatchObject({
      phase: "available",
      currentVersion: "1.1.0",
      version: "1.2.0",
      notes: found.notes,
      checkedAt: clock.now,
      error: null,
    })
    expect(isUpdateState(service.state)).toBe(true)
  })

  it("says so when the running version is the newest", async () => {
    const { service } = setup(fakeEngine(null))
    service.check()
    await settle()
    expect(service.state).toMatchObject({ phase: "upToDate", version: null, notes: [] })
  })

  it("loads the engine with the first check, not before, and once", async () => {
    const { service, load } = setup()
    expect(load).not.toHaveBeenCalled()
    service.check()
    await settle()
    service.check()
    await settle()
    expect(load).toHaveBeenCalledTimes(1)
  })

  it("shows why a check the user asked for failed", async () => {
    const { service } = setup(fakeEngine(new Error("net::ERR_INTERNET_DISCONNECTED\n  at stack")))
    service.check()
    await settle()
    expect(service.state).toMatchObject({
      phase: "error",
      error: "net::ERR_INTERNET_DISCONNECTED",
    })
  })

  it("keeps a failed automatic check to itself and tries again later", async () => {
    const { service, phases, manual } = setup(fakeEngine(new Error("offline")))
    service.start()
    expect(manual.delays()).toEqual([FIRST_CHECK_DELAY_MS])
    manual.fire()
    await settle()
    expect(phases()).toEqual(["checking", "idle"])
    expect(service.state.error).toBeNull()
    expect(manual.delays()).toEqual([CHECK_INTERVAL_MS])
  })

  it("checks by itself only while the setting says so", async () => {
    const { service, manual, fake } = setup()
    service.setAuto(false)
    service.start()
    expect(manual.delays()).toEqual([])
    service.setAuto(true)
    expect(manual.delays()).toEqual([FIRST_CHECK_DELAY_MS])
    service.setAuto(false)
    expect(manual.delays()).toEqual([])
    expect(fake.check).not.toHaveBeenCalled()
    // A check the user asks for still runs.
    service.check()
    await settle()
    expect(service.state.phase).toBe("available")
    expect(manual.delays()).toEqual([])
  })

  it("does nothing in a build without updates", async () => {
    const { service, states, load, manual } = setup(fakeEngine(), "off")
    service.start()
    service.check()
    service.download()
    await settle()
    expect(service.install()).toBe(false)
    expect(states).toEqual([])
    expect(load).not.toHaveBeenCalled()
    expect(manual.delays()).toEqual([])
  })

  it("downloads only when asked, reports progress sparingly and then waits for the restart", async () => {
    const { service, states, clock, fake } = setup()
    service.check()
    await settle()
    expect(fake.install).not.toHaveBeenCalled()
    expect(service.download().phase).toBe("downloading")
    await settle()
    const before = states.length
    // A burst within one interval is one event.
    for (const percent of [1, 2, 3, 4]) {
      fake.progress({ percent, transferredBytes: percent * 10, totalBytes: 1000 })
    }
    expect(states.length - before).toBe(1)
    clock.now += 300
    fake.progress({ percent: 60, transferredBytes: 600, totalBytes: 1000 })
    expect(service.state).toMatchObject({ percent: 60, transferredBytes: 600, totalBytes: 1000 })
    fake.finishDownload()
    await settle()
    expect(service.state).toMatchObject({ phase: "ready", percent: 100, version: "1.2.0" })
    expect(isUpdateState(service.state)).toBe(true)

    expect(service.install()).toBe(true)
    await settle()
    expect(fake.install).toHaveBeenCalledTimes(1)
  })

  it("leaves the version to download again when a download fails", async () => {
    const { service, fake } = setup()
    service.check()
    await settle()
    service.download()
    await settle()
    fake.finishDownload(new Error("sha512 checksum mismatch"))
    await settle()
    expect(service.state).toMatchObject({
      phase: "available",
      version: "1.2.0",
      error: "sha512 checksum mismatch",
    })
  })

  it("never downloads or installs out of turn", async () => {
    const { service, fake } = setup()
    expect(service.download().phase).toBe("idle")
    expect(service.install()).toBe(false)
    service.check()
    await settle()
    expect(service.install()).toBe(false)
    service.download()
    await settle()
    // A check during a download, and one after it, change nothing.
    expect(service.check().phase).toBe("downloading")
    fake.finishDownload()
    await settle()
    expect(service.check().phase).toBe("ready")
    expect(fake.check).toHaveBeenCalledTimes(1)
  })

  it("finds a version it cannot install in a manual build, and offers no download", async () => {
    const { service } = setup(fakeEngine(), "manual")
    service.check()
    await settle()
    expect(service.state).toMatchObject({ mode: "manual", phase: "available", version: "1.2.0" })
    expect(service.download().phase).toBe("available")
    expect(service.install()).toBe(false)
  })

  it("announces the build's mode once it is known", () => {
    const { service, states } = setup(fakeEngine(), "off")
    service.setMode("auto")
    service.setMode("auto")
    expect(states.map((s) => s.mode)).toEqual(["auto"])
  })
})

describe("what a build can do with a newer version", () => {
  const build = {
    packaged: true,
    platform: "win32" as NodeJS.Platform,
    hasFeed: true,
    signed: false,
    appImage: undefined as string | undefined,
  }

  it("is off in development and without a feed", () => {
    expect(resolveUpdateMode({ ...build, packaged: false })).toBe("off")
    expect(resolveUpdateMode({ ...build, hasFeed: false })).toBe("off")
  })

  it("installs on Windows, on macOS only into a signed app, on Linux only as an AppImage", () => {
    expect(resolveUpdateMode(build)).toBe("auto")
    expect(resolveUpdateMode({ ...build, platform: "darwin" })).toBe("manual")
    expect(resolveUpdateMode({ ...build, platform: "darwin", signed: true })).toBe("auto")
    expect(resolveUpdateMode({ ...build, platform: "linux" })).toBe("manual")
    expect(
      resolveUpdateMode({ ...build, platform: "linux", appImage: "/a/Panelyth.AppImage" }),
    ).toBe("auto")
  })
})

describe("release notes", () => {
  it("become plain text: no markup from a feed reaches a renderer", () => {
    const html =
      "<h2>What&#39;s new</h2><ul><li>Faster <b>folders</b></li><li>Fixes &amp; polish</li></ul>" +
      '<p>See <a href="https://example.com" onclick="x()">the page</a></p>' +
      "<script>alert(1)</script><img src=x onerror=alert(2)>"
    const text = notesToText(html)
    expect(text).toBe("What's new\n\n• Faster folders\n• Fixes & polish\n\nSee the page")
    expect(text).not.toMatch(/[<>]|alert/)
  })

  it("are cut at the limit", () => {
    const text = notesToText("x".repeat(MAX_RELEASE_NOTE_CHARS * 2))
    expect(text.length).toBe(MAX_RELEASE_NOTE_CHARS)
    expect(text.endsWith("…")).toBe(true)
  })

  it("come as one text or as a list of versions, and empty ones are left out", () => {
    expect(releaseNotes("1.2.0", "<p>One</p>")).toEqual([{ version: "1.2.0", text: "One" }])
    expect(
      releaseNotes("1.2.0", [
        { version: "1.2.0", note: "<li>Two</li>" },
        { version: "1.1.1", note: null },
      ]),
    ).toEqual([{ version: "1.2.0", text: "• Two" }])
    expect(releaseNotes("1.2.0", null)).toEqual([])
  })

  it("keep an error to its first line", () => {
    expect(updateErrorMessage(new Error("Cannot find latest.yml\nHeaders: {…}"))).toBe(
      "Cannot find latest.yml",
    )
    expect(updateErrorMessage("")).toBe("the update could not be completed")
  })
})

describe("the scripted engine of the e2e tests", () => {
  it("finds, downloads and records the install", async () => {
    const installed: string[] = []
    const engine = scriptedEngine('{"version":"9.9.9","notes":"<li>New</li>"}', (v) =>
      installed.push(v),
    )
    await expect(engine.check()).resolves.toEqual({
      version: "9.9.9",
      releaseDate: null,
      notes: [{ version: "9.9.9", text: "• New" }],
    })
    const seen: number[] = []
    await engine.download((p) => seen.push(p.percent))
    expect(seen.at(-1)).toBe(100)
    engine.install()
    expect(installed).toEqual(["9.9.9"])
  })

  it("is up to date or fails as scripted", async () => {
    await expect(scriptedEngine("{}", () => undefined).check()).resolves.toBeNull()
    await expect(scriptedEngine('{"error":"offline"}', () => undefined).check()).rejects.toThrow(
      "offline",
    )
  })
})
