import { describe, expect, it, vi } from "vitest"

vi.mock("electron", () => ({ protocol: {} }))

const {
  MediaTokens,
  corsHeaders,
  mintMediaUrl,
  parseMediaUrl,
  parseRange,
  toFileOpenResult,
  toMediaOpenResult,
} = await import("../src/main/mediaProtocol")
const { allowPermission, contentSecurityPolicy } = await import("../src/main/security")

const resolved = {
  path: "/videos/clip.mp4",
  kind: "video" as const,
  mime: "video/mp4",
  sizeBytes: 1000,
  width: 1920,
  height: 1080,
  original: true,
  durationMs: 12_345,
  videoCodec: "h264",
  audioCodec: "aac",
}

describe("media.open result", () => {
  it("gives a video a token URL plus probe fields, never the path", () => {
    const tokens = new MediaTokens()
    const r = toMediaOpenResult(resolved, tokens)
    expect(r).toMatchObject({ kind: "video", width: 1920, durationMs: 12_345, videoCodec: "h264" })
    expect(parseMediaUrl(r.url!)).not.toBeNull()
    expect(JSON.stringify(r)).not.toContain("/videos")
    expect(tokens.get(parseMediaUrl(r.url!)!)).toEqual({
      path: "/videos/clip.mp4",
      mime: "video/mp4",
    })
  })

  it("mints nothing when only previews may be shown (TIFF, > 50 MP)", () => {
    const tokens = new MediaTokens()
    const r = toMediaOpenResult(
      { ...resolved, kind: "image", mime: "image/tiff", original: false },
      tokens,
    )
    expect(r.url).toBeNull()
    expect(tokens.size).toBe(0)
  })
})

describe("permissions", () => {
  it("allows only element fullscreen, only for our own page", () => {
    expect(allowPermission("fullscreen", "app://fastview/index.html", "app://fastview")).toBe(true)
    expect(allowPermission("fullscreen", "https://example.com/", "app://fastview")).toBe(false)
    for (const p of ["media", "clipboard-read", "notifications", "openExternal", "pointerLock"])
      expect(allowPermission(p, "app://fastview/index.html", "app://fastview")).toBe(false)
  })
})

describe("media tokens", () => {
  it("mints opaque 128-bit tokens that resolve to the validated target", () => {
    const tokens = new MediaTokens()
    const url = mintMediaUrl(tokens, { path: "/photos/a.jpg", mime: "image/jpeg" })
    const token = parseMediaUrl(url)
    expect(token).toMatch(/^[0-9a-f]{32}$/)
    expect(url).not.toContain("photos")
    expect(tokens.get(token!)).toEqual({ path: "/photos/a.jpg", mime: "image/jpeg" })
  })

  it("keeps a bounded LRU; recently used tokens survive", () => {
    const tokens = new MediaTokens(3)
    const a = tokens.mint({ path: "/a", mime: "" })
    const b = tokens.mint({ path: "/b", mime: "" })
    tokens.mint({ path: "/c", mime: "" })
    tokens.get(a) // touch a
    tokens.mint({ path: "/d", mime: "" })
    expect(tokens.size).toBe(3)
    expect(tokens.get(a)).toBeDefined()
    expect(tokens.get(b)).toBeUndefined()
  })

  it.each([
    "fastview-media://m/../../etc/passwd",
    "fastview-media://m/ABCDEF0123456789ABCDEF0123456789",
    `fastview-media://x/${"0".repeat(32)}`,
    `fastview-media://m/${"0".repeat(32)}?x=1`,
    `fastview-media://m/${"0".repeat(31)}`,
    "file:///etc/passwd",
  ])("rejects %s", (url) => {
    expect(parseMediaUrl(url)).toBeNull()
  })
})

describe("byte ranges", () => {
  it.each([
    [null, null],
    ["bytes=0-99", { start: 0, end: 99 }],
    ["bytes=100-", { start: 100, end: 999 }],
    ["bytes=-100", { start: 900, end: 999 }],
    ["bytes=900-5000", { start: 900, end: 999 }],
    ["bytes=1000-", "invalid"],
    ["bytes=5-2", "invalid"],
    ["bytes=0-1,5-9", "invalid"],
    ["bytes=-0", "invalid"],
    ["items=0-1", "invalid"],
  ] as const)("%s", (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected)
  })
})

describe("file tokens for the commander (Stage C05, ADR-0027)", () => {
  const resolved = {
    path: "/logs/big.log",
    kind: "file" as const,
    mime: "application/octet-stream",
    sizeBytes: 9,
  }

  it("mints a token bound to the commander's origin, never exposing the path", () => {
    const tokens = new MediaTokens()
    const r = toFileOpenResult(resolved, tokens, "app://commander")
    expect(r).toMatchObject({ kind: "file", mime: "application/octet-stream", sizeBytes: 9 })
    expect(JSON.stringify(r)).not.toContain("/logs")
    const token = parseMediaUrl(r.url)!
    expect(tokens.get(token)).toEqual({
      path: "/logs/big.log",
      mime: "application/octet-stream",
      fetchOrigin: "app://commander",
    })
  })

  it("allows fetch() only from the minting origin; element loads carry no Origin", () => {
    const fileTarget = {
      path: "/a",
      mime: "application/octet-stream",
      fetchOrigin: "app://commander",
    }
    expect(corsHeaders(fileTarget, null)).toEqual({})
    expect(corsHeaders(fileTarget, "app://commander")).toMatchObject({
      "Access-Control-Allow-Origin": "app://commander",
    })
    expect(corsHeaders(fileTarget, "app://fastview")).toBe("denied")
    expect(corsHeaders(fileTarget, "null")).toBe("denied")
    // The viewer's media tokens are never fetch()able.
    const mediaTarget = { path: "/a.jpg", mime: "image/jpeg" }
    expect(corsHeaders(mediaTarget, "app://fastview")).toBe("denied")
    expect(corsHeaders(mediaTarget, null)).toEqual({})
  })
})

describe("token fetch is the commander's only (Stage C05, ADR-0027)", () => {
  it("gives fetch() access to token URLs in the commander's CSP alone", () => {
    const connect = (csp: string) => csp.split("; ").find((d) => d.startsWith("connect-src"))
    expect(connect(contentSecurityPolicy(null))).toBe("connect-src 'self'")
    expect(connect(contentSecurityPolicy(null, true))).toBe("connect-src 'self' fastview-media:")
    expect(connect(contentSecurityPolicy("http://localhost:5173"))).toBe(
      "connect-src 'self' ws://localhost:5173",
    )
    expect(connect(contentSecurityPolicy("http://localhost:5174", true))).toBe(
      "connect-src 'self' fastview-media: ws://localhost:5174",
    )
    // Both apps still show images and play videos from tokens.
    for (const csp of [contentSecurityPolicy(null), contentSecurityPolicy(null, true)]) {
      expect(csp).toContain("img-src 'self' data: fastview-thumb: fastview-media:")
      expect(csp).toContain("media-src fastview-media:")
    }
  })
})
