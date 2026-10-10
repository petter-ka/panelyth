// Validates the golden frames produced by the Go sidecar
// (src/shared/sidecar/internal/app/golden_test.go) against the TS contracts.
import { readFileSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  PROTOCOL_VERSION,
  SIDECAR_EVENT_CHANNELS,
  eventGuards,
  isEventFrame,
  isHelloFrame,
  isInboundFrame,
  isResponseFrame,
  isSelectionDescriptor,
  sidecarResultGuards,
  type EventChannel,
  type SidecarMethod,
} from "../src"

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures")
const load = (name: string): unknown => JSON.parse(readFileSync(join(dir, name), "utf8"))

describe("golden frames from Go", () => {
  it("hello matches HelloFrame and protocol version", () => {
    const hello = load("hello.json")
    expect(isHelloFrame(hello)).toBe(true)
    expect((hello as { protocol: number }).protocol).toBe(PROTOCOL_VERSION)
  })

  it("every fixture is a valid inbound frame", () => {
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) expect(isInboundFrame(load(f)), f).toBe(true)
  })

  const methods = Object.keys(sidecarResultGuards) as SidecarMethod[]
  it.each(methods)("%s result matches its contract", (method) => {
    const frame = load(`res-${method}.json`)
    expect(isResponseFrame(frame)).toBe(true)
    if (!isResponseFrame(frame) || !frame.ok) throw new Error(`${method} fixture is not a success`)
    expect(sidecarResultGuards[method](frame.r)).toBe(true)
  })

  it("error envelope uses a known code", () => {
    const frame = load("res-error.json")
    expect(isResponseFrame(frame) && !frame.ok && frame.e.code).toBe("METHOD_NOT_FOUND")
  })

  it("a video resolves to a playable original, with probe fields present even when unknown", () => {
    const frame = load("res-media.resolve-video.json")
    if (!isResponseFrame(frame) || !frame.ok) throw new Error("not a success")
    expect(sidecarResultGuards["media.resolve"](frame.r)).toBe(true)
    expect(frame.r).toMatchObject({
      kind: "video",
      mime: "video/mp4",
      original: true,
      durationMs: 0,
    })
  })

  it("an expired query session is NOT_FOUND so the renderer can reopen it", () => {
    const frame = load("res-query.page-expired.json")
    expect(isResponseFrame(frame) && !frame.ok && frame.e.code).toBe("NOT_FOUND")
  })

  it("a selection for an outdated version is rejected, not silently misapplied", () => {
    const frame = load("res-selection.info-stale.json")
    expect(isResponseFrame(frame) && !frame.ok && frame.e.code).toBe("INVALID_ARGUMENT")
  })

  it("dir.open crumbs end with the opened folder", () => {
    const frame = load("res-dir.open.json") as { r: { path: string; crumbs: { path: string }[] } }
    expect(frame.r.crumbs.at(-1)?.path).toBe(frame.r.path)
  })

  it("every Go event fixture matches its channel payload", () => {
    const files = readdirSync(dir).filter((f) => f.startsWith("evt-"))
    expect(files.length).toBeGreaterThan(0)
    for (const f of files) {
      const frame = load(f)
      if (!isEventFrame(frame)) throw new Error(`${f} is not an event frame`)
      const channel = frame.ch as EventChannel
      expect(SIDECAR_EVENT_CHANNELS as readonly string[], f).toContain(channel)
      expect(eventGuards[channel](frame.p), f).toBe(true)
    }
  })

  it("every sidecar event channel has a fixture", () => {
    for (const ch of SIDECAR_EVENT_CHANNELS.filter((c) => c !== "query.invalidated")) {
      expect(() => load(`evt-${ch}.json`)).not.toThrow()
    }
  })
})

describe("guards reject malformed payloads", () => {
  it.each([
    ["negative total", { queryId: 1, version: 1, total: -1 }],
    ["fractional id", { queryId: 1.5, version: 1, total: 0 }],
    ["missing version", { queryId: 1, total: 0 }],
  ])("query snapshot: %s", (_name, v) => {
    expect(eventGuards["query.invalidated"](v)).toBe(false)
  })

  it("rejects unknown content kinds and scan states", () => {
    const item = { id: 1, kind: "file", name: "x", ext: "", sizeBytes: 0, modifiedMs: 0 }
    expect(
      sidecarResultGuards["query.page"]({
        queryId: 1,
        version: 1,
        total: 1,
        offset: 0,
        items: [item],
      }),
    ).toBe(false)
    expect(
      isSelectionDescriptor({ queryId: 1, version: 1, ranges: [[3, 1]], include: [], exclude: [] }),
    ).toBe(false)
    expect(
      sidecarResultGuards["fs.volumes"]({ volumes: [{ path: "/", label: "", kind: "cloud" }] }),
    ).toBe(false)
    const progress = load("evt-index.progress.json") as { p: Record<string, unknown> }
    expect(eventGuards["index.progress"]({ ...progress.p, state: "paused" })).toBe(false)
  })
})
