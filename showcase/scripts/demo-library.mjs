// Generates the demo library the showcase's screenshots and hero video are
// taken from: a home folder (Users/user) with procedurally drawn photographs,
// short video clips and a few documents. Everything is drawn here, so the
// pictures on the product page carry no third-party rights.
//
//   node showcase/scripts/demo-library.mjs [--force]
//
// Output: showcase/.demo/Users/user (ignored by git). Deterministic: the same
// seed draws the same picture.
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { crc32 } from "node:zlib"

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, "..", "..")
export const demoRoot = join(here, "..", ".demo")
export const demoHome = join(demoRoot, "Users", "user")

// The canvas library is a dependency of pdf.js in the main workspace; the
// showcase itself stays free of build-time dependencies.
const docviewer = createRequire(join(repo, "src", "shared", "docviewer", "package.json"))
const { createCanvas } = createRequire(docviewer.resolve("pdfjs-dist/package.json"))(
  "@napi-rs/canvas",
)

// ---------------------------------------------------------------- helpers

function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hex = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16))
const rgba = (c, a = 1) => `rgba(${hex(c).join(",")},${a})`
function mix(a, b, t) {
  const [x, y] = [hex(a), hex(b)]
  return `#${x
    .map((v, i) =>
      Math.round(v + (y[i] - v) * t)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`
}
const between = (r, lo, hi) => lo + r() * (hi - lo)
const pick = (r, list) => list[Math.floor(r() * list.length)]

/** Fractal value noise over x in 0..1, result in 0..1. */
function ridgeNoise(r, roughness = 0.5, base = 2.2, octaves = 7) {
  const table = Float32Array.from({ length: 1024 }, r)
  const shift = r() * 512
  const at = (x) => {
    const i = Math.floor(x)
    const t = (1 - Math.cos((x - i) * Math.PI)) / 2
    return table[i & 1023] * (1 - t) + table[(i + 1) & 1023] * t
  }
  return (x) => {
    let sum = 0
    let amp = 1
    let norm = 0
    let freq = base
    for (let o = 0; o < octaves; o++) {
      sum += at(x * freq + shift + o * 37) * amp
      norm += amp
      amp *= roughness
      freq *= 2
    }
    return sum / norm
  }
}

function sky(ctx, W, H, stops, to = H) {
  const g = ctx.createLinearGradient(0, 0, 0, to)
  stops.forEach((c, i) => g.addColorStop(i / (stops.length - 1), c))
  ctx.fillStyle = g
  ctx.fillRect(0, 0, W, H)
}

function glow(ctx, x, y, radius, color, alpha) {
  const g = ctx.createRadialGradient(x, y, 0, x, y, radius)
  g.addColorStop(0, rgba(color, alpha))
  g.addColorStop(0.35, rgba(color, alpha * 0.35))
  g.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = g
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2)
}

function sun(ctx, W, x, y, color, size = 0.018) {
  glow(ctx, x, y, W * 0.55, color, 0.5)
  glow(ctx, x, y, W * 0.12, "#ffffff", 0.75)
  ctx.fillStyle = "#fffdf4"
  ctx.beginPath()
  ctx.arc(x, y, W * size, 0, Math.PI * 2)
  ctx.fill()
}

function clouds(ctx, W, H, r, color, count, band = [0.08, 0.42], alpha = 0.22) {
  ctx.save()
  ctx.filter = `blur(${Math.round(W / 140)}px)`
  for (let i = 0; i < count; i++) {
    const cx = r() * W
    const cy = between(r, band[0], band[1]) * H
    const w = between(r, 0.12, 0.34) * W
    const puffs = 6 + Math.floor(r() * 9)
    for (let p = 0; p < puffs; p++) {
      const px = cx + (r() - 0.5) * w
      const py = cy + (r() - 0.5) * w * 0.09
      const pr = between(r, 0.035, 0.1) * w + W * 0.012
      ctx.fillStyle = rgba(color, alpha * between(r, 0.5, 1))
      ctx.beginPath()
      ctx.ellipse(px, py, pr * 2.4, pr * 0.62, 0, 0, Math.PI * 2)
      ctx.fill()
    }
  }
  ctx.restore()
}

/** Fills a silhouette whose top edge is `top(x)` (pixels) down to the bottom. */
function silhouette(ctx, W, H, top, fill, step = 3) {
  ctx.beginPath()
  ctx.moveTo(0, H)
  for (let x = 0; x <= W + step; x += step) ctx.lineTo(x, top(x))
  ctx.lineTo(W, H)
  ctx.closePath()
  ctx.fillStyle = fill
  ctx.fill()
}

function ridges(ctx, W, H, r, o) {
  const { layers, from, to, far, near, haze, roughness = 0.52, snow, light } = o
  for (let i = 0; i < layers; i++) {
    const t = layers === 1 ? 1 : i / (layers - 1)
    const base = (from + (to - from) * t) * H
    const amp = (o.amp ?? 0.3) * H * (1 - t * (o.flatten ?? 0.45))
    const n = ridgeNoise(r, roughness - t * 0.06, between(r, 1.4, 2.6) + t * 1.5)
    const top = (x) => base - n(x / W) * amp
    const color = mix(far, near, Math.pow(t, 0.85))
    const g = ctx.createLinearGradient(0, base - amp, 0, base + H * 0.22)
    g.addColorStop(0, light ? mix(color, light, 0.28 * (1 - t)) : color)
    g.addColorStop(1, mix(color, haze, 0.55 * (1 - t) + 0.12))
    silhouette(ctx, W, H, top, g)
    if (snow && i < snow.layers) {
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(0, H)
      for (let x = 0; x <= W + 3; x += 3) ctx.lineTo(x, top(x))
      ctx.lineTo(W, H)
      ctx.clip()
      // Snow follows the crest: the same profile, a little lower and rougher.
      const cap = ridgeNoise(r, 0.62, 9)
      const line = (x) => top(x) + amp * (0.03 + 0.2 * cap(x / W) - (i ? 0.05 : 0))
      const sg = ctx.createLinearGradient(0, base - amp, 0, base)
      sg.addColorStop(0, rgba(snow.color, 0.95))
      sg.addColorStop(1, rgba(snow.color, 0.55))
      ctx.beginPath()
      ctx.moveTo(0, 0)
      for (let x = 0; x <= W + 3; x += 3) ctx.lineTo(x, line(x))
      ctx.lineTo(W, 0)
      ctx.closePath()
      ctx.fillStyle = sg
      ctx.fill()
      ctx.restore()
    }
    // Haze settles in the valleys between two ridges.
    const hz = ctx.createLinearGradient(0, base - amp * 0.25, 0, base + H * 0.1)
    hz.addColorStop(0, rgba(haze, 0))
    hz.addColorStop(1, rgba(haze, 0.42 * (1 - t)))
    ctx.fillStyle = hz
    ctx.fillRect(0, base - amp * 0.25, W, H)
  }
}

function pines(ctx, W, H, r, baseline, height, color, density = 1) {
  ctx.fillStyle = color
  const n = ridgeNoise(r, 0.5, 3)
  let x = -height * 0.2
  while (x < W + height * 0.2) {
    const h = height * between(r, 0.55, 1.15)
    const y = baseline(x) + h * 0.08
    const w = h * between(r, 0.2, 0.3)
    const tiers = 5
    ctx.beginPath()
    ctx.moveTo(x, y - h)
    for (let k = 1; k <= tiers; k++) {
      const ty = y - h + (h * k) / tiers
      const tw = (w * k) / tiers
      ctx.lineTo(x + tw, ty)
      ctx.lineTo(x + tw * 0.55, ty)
    }
    ctx.lineTo(x + w * 0.1, y)
    ctx.lineTo(x - w * 0.1, y)
    for (let k = tiers; k >= 1; k--) {
      const ty = y - h + (h * k) / tiers
      const tw = (w * k) / tiers
      ctx.lineTo(x - tw * 0.55, ty)
      ctx.lineTo(x - tw, ty)
    }
    ctx.closePath()
    ctx.fill()
    x += (h * between(r, 0.12, 0.42)) / density + n(x / W) * 4
  }
}

function mirror(ctx, canvas, W, H, horizon, tint, r, strength = 0.42) {
  const copy = createCanvas(W, Math.ceil(horizon))
  copy.getContext("2d").drawImage(canvas, 0, 0)
  ctx.save()
  ctx.translate(0, horizon * 2)
  ctx.scale(1, -1)
  ctx.filter = `blur(${Math.max(1, Math.round(W / 900))}px)`
  ctx.drawImage(copy, 0, 0)
  ctx.restore()
  const g = ctx.createLinearGradient(0, horizon, 0, H)
  g.addColorStop(0, rgba(tint, strength * 0.55))
  g.addColorStop(1, rgba(tint, Math.min(0.94, strength * 1.9)))
  ctx.fillStyle = g
  ctx.fillRect(0, horizon, W, H - horizon)
  // Ripples: short bright and dark strokes, longer towards the viewer.
  for (let i = 0; i < 520; i++) {
    const d = Math.pow(r(), 1.6)
    const y = horizon + d * (H - horizon)
    const w = (0.01 + d * 0.11) * W * between(r, 0.3, 1)
    ctx.fillStyle = r() < 0.55 ? rgba("#ffffff", 0.05 + r() * 0.07) : rgba("#06121a", 0.08)
    ctx.fillRect(r() * W - w / 2, y, w, 1 + d * 2.4)
  }
  ctx.fillStyle = rgba("#ffffff", 0.25)
  ctx.fillRect(0, horizon - 1, W, 2)
}

let grainTile
function finish(ctx, W, H, r, o = {}) {
  if (!grainTile) {
    grainTile = createCanvas(512, 512)
    const g = grainTile.getContext("2d")
    const img = g.createImageData(512, 512)
    const n = rng(7)
    for (let i = 0; i < img.data.length; i += 4) {
      const v = 128 + (n() - 0.5) * 150
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v
      img.data[i + 3] = 255
    }
    g.putImageData(img, 0, 0)
  }
  ctx.save()
  ctx.globalAlpha = o.grain ?? 0.1
  ctx.globalCompositeOperation = "overlay"
  ctx.fillStyle = ctx.createPattern(grainTile, "repeat")
  ctx.translate(-Math.floor(r() * 512), -Math.floor(r() * 512))
  ctx.fillRect(0, 0, W + 512, H + 512)
  ctx.restore()
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.42, W / 2, H / 2, W * 0.78)
  v.addColorStop(0, "rgba(0,0,0,0)")
  v.addColorStop(1, `rgba(0,0,0,${o.vignette ?? 0.34})`)
  ctx.fillStyle = v
  ctx.fillRect(0, 0, W, H)
}

// ----------------------------------------------------------------- scenes

const ALPINE = {
  dawn: {
    sky: ["#30486e", "#8a8fb4", "#f0b9a0", "#ffe3bd"],
    sun: "#ffd9a8",
    far: "#8f93b8",
    near: "#1e2a3d",
    haze: "#f2c9b6",
    cloud: "#ffd8c4",
    snow: "#fff1e6",
    light: "#ffc8a0",
  },
  day: {
    sky: ["#2f6fb4", "#6aa5d8", "#b7d6ec", "#e6f1f5"],
    sun: "#fff6d8",
    far: "#8fa9c4",
    near: "#1d3a36",
    haze: "#dcebf2",
    cloud: "#ffffff",
    snow: "#ffffff",
    light: "#e8f1f6",
  },
  golden: {
    sky: ["#3d5a80", "#c98f6b", "#f4b860", "#ffe6a8"],
    sun: "#ffcf73",
    far: "#b98a78",
    near: "#2a2420",
    haze: "#f6c98a",
    cloud: "#ffd39a",
    snow: "#ffe6c2",
    light: "#ffb866",
  },
  dusk: {
    sky: ["#1b2148", "#4f3f7a", "#b4577e", "#f29a6e"],
    sun: "#ff9d6b",
    far: "#6d5f93",
    near: "#14162b",
    haze: "#c8739a",
    cloud: "#f08fa0",
    snow: "#f3d6e2",
    light: "#f08a8a",
  },
  storm: {
    sky: ["#2d3640", "#56636e", "#8b979e", "#c4cbc9"],
    sun: "#e8eae4",
    far: "#75838c",
    near: "#161d20",
    haze: "#aab4b6",
    cloud: "#dfe4e2",
    snow: "#eef1f0",
    light: "#cfd8d8",
  },
}

function alps(c, ctx, W, H, r, o = {}) {
  const p = ALPINE[o.palette ?? pick(r, Object.keys(ALPINE))]
  const horizon = between(r, 0.6, 0.72)
  sky(ctx, W, H, p.sky, H * horizon)
  if (!o.noSun) sun(ctx, W, between(r, 0.15, 0.85) * W, between(r, 0.2, 0.46) * H, p.sun)
  clouds(ctx, W, H, r, p.cloud, 3 + Math.floor(r() * 6))
  ridges(ctx, W, H, r, {
    layers: 5,
    from: horizon,
    to: 0.98,
    amp: between(r, 0.3, 0.46),
    far: p.far,
    near: p.near,
    haze: p.haze,
    roughness: 0.56,
    snow: { layers: 2, color: p.snow },
    light: p.light,
  })
  if (r() < 0.7) {
    const n = ridgeNoise(r, 0.4, 2)
    pines(ctx, W, H, r, (x) => H * (0.97 + n(x / W) * 0.06), H * 0.16, mix(p.near, "#000000", 0.45))
  }
  finish(ctx, W, H, r)
}

function lake(c, ctx, W, H, r, o = {}) {
  const p = ALPINE[o.palette ?? pick(r, ["dawn", "day", "golden", "dusk"])]
  const horizon = H * between(r, 0.52, 0.6)
  sky(ctx, W, H, p.sky, horizon)
  sun(ctx, W, between(r, 0.2, 0.8) * W, horizon * between(r, 0.35, 0.8), p.sun)
  clouds(ctx, W, H, r, p.cloud, 4 + Math.floor(r() * 4), [0.06, 0.3])
  ridges(ctx, W, horizon, r, {
    layers: 4,
    from: 0.86,
    to: 1.0,
    amp: between(r, 0.5, 0.72),
    far: p.far,
    near: mix(p.near, p.far, 0.15),
    haze: p.haze,
    roughness: 0.55,
    snow: { layers: 2, color: p.snow },
    light: p.light,
    flatten: 0.62,
  })
  const shore = ridgeNoise(r, 0.4, 5)
  pines(ctx, W, H, r, (x) => horizon + shore(x / W) * 4, H * 0.06, mix(p.near, "#000000", 0.3), 1.4)
  ctx.clearRect(0, horizon, W, H - horizon)
  mirror(ctx, c, W, H, horizon, mix(p.near, p.sky[0], 0.5), r)
  finish(ctx, W, H, r)
}

const SEAS = {
  noon: {
    sky: ["#1f6fb5", "#63a9dc", "#bfe0ee"],
    sea: ["#2f8fb0", "#0f4f77", "#0a2f4d"],
    sun: "#fff7dc",
    land: "#3b4a3c",
    sand: "#e3cfa4",
    cloud: "#ffffff",
  },
  sunset: {
    sky: ["#27305e", "#a2507d", "#f6925a", "#ffd58a"],
    sea: ["#e59a6a", "#7b4c78", "#1c2548"],
    sun: "#ffc46b",
    land: "#1c1a2a",
    sand: "#a9765c",
    cloud: "#ffb28a",
  },
  nordic: {
    sky: ["#3a4f63", "#7f95a3", "#cfd9da"],
    sea: ["#7c949c", "#38525e", "#14232c"],
    sun: "#f1f1e6",
    land: "#15191b",
    sand: "#2a2b2c",
    cloud: "#eef1f0",
  },
  morning: {
    sky: ["#4a78b0", "#a9c3de", "#f5d7c0"],
    sea: ["#c6c3c9", "#5f87a8", "#1f4468"],
    sun: "#ffe8c6",
    land: "#2b3540",
    sand: "#d8bf9c",
    cloud: "#fff0e4",
  },
}

function coast(c, ctx, W, H, r, o = {}) {
  const p = SEAS[o.palette ?? pick(r, Object.keys(SEAS))]
  const horizon = H * between(r, 0.44, 0.56)
  sky(ctx, W, H, p.sky, horizon)
  const sx = between(r, 0.25, 0.75) * W
  const sy = horizon * between(r, 0.45, 0.93)
  sun(ctx, W, sx, sy, p.sun, 0.022)
  clouds(ctx, W, H, r, p.cloud, 3 + Math.floor(r() * 5), [0.05, 0.34])
  const g = ctx.createLinearGradient(0, horizon, 0, H)
  p.sea.forEach((col, i) => g.addColorStop(i / (p.sea.length - 1), col))
  ctx.fillStyle = g
  ctx.fillRect(0, horizon, W, H - horizon)
  // The sun's path on the water.
  for (let i = 0; i < 900; i++) {
    const d = Math.pow(r(), 1.3)
    const y = horizon + d * (H - horizon)
    const spread = (0.012 + d * 0.16) * W
    const w = (0.004 + d * 0.05) * W * r()
    ctx.fillStyle = rgba(p.sun, 0.1 + r() * 0.3 * (1 - d * 0.6))
    ctx.fillRect(sx + (r() + r() - 1) * spread - w / 2, y, w, 1 + d * 3)
  }
  for (let i = 0; i < 380; i++) {
    const d = Math.pow(r(), 1.5)
    const w = (0.02 + d * 0.16) * W * r()
    ctx.fillStyle = r() < 0.5 ? rgba("#ffffff", 0.05 + 0.05 * r()) : rgba("#000b14", 0.07)
    ctx.fillRect(r() * W - w / 2, horizon + d * (H - horizon), w, 1 + d * 2.5)
  }
  // A headland running out from one side.
  const left = r() < 0.5
  const reach = between(r, 0.35, 0.7)
  for (let k = 0; k < 2; k++) {
    const n = ridgeNoise(r, 0.55, 3 + k * 2)
    const height = H * (0.2 - k * 0.07) * between(r, 0.7, 1.2)
    const span = reach * (1 - k * 0.35)
    // The nearer one stands a little in front of the horizon; both end at their waterline.
    const waterline = horizon + (k ? H * 0.04 : 0)
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, 0, W, waterline)
    ctx.clip()
    silhouette(
      ctx,
      W,
      H,
      (x) => {
        const u = (left ? x : W - x) / (W * span)
        if (u >= 1) return H + 10
        return waterline + 4 - n(x / W) * height * Math.pow(1 - u, 0.6)
      },
      mix(p.land, p.sky[p.sky.length - 1], 0.3 - k * 0.25),
    )
    ctx.restore()
    ctx.fillStyle = rgba("#ffffff", 0.22)
    ctx.fillRect(left ? 0 : W * (1 - span), waterline - 1, W * span, 2)
  }
  // The beach in front, with two lines of foam.
  const b = ridgeNoise(r, 0.35, 1.2)
  const beach = (x) => H * (0.86 + b(x / W) * 0.1) - (left ? 1 - x / W : x / W) * H * 0.07
  for (let k = 2; k >= 1; k--) {
    silhouette(ctx, W, H, (x) => beach(x) - k * H * 0.012, rgba("#ffffff", 0.2 + 0.25 / k))
  }
  silhouette(ctx, W, H, beach, mix(p.sand, p.land, 0.12))
  finish(ctx, W, H, r)
}

function night(c, ctx, W, H, r, o = {}) {
  const aurora = o.aurora ?? r() < 0.5
  sky(
    ctx,
    W,
    H,
    aurora
      ? ["#030712", "#06162b", "#0c2a3d", "#12404a"]
      : ["#02040c", "#0a1230", "#1b2450", "#3a3560"],
    H * 0.8,
  )
  // The Milky Way: a soft diagonal band of dust and many more stars.
  const angle = between(r, -0.9, -0.4)
  const cx = W * between(r, 0.3, 0.7)
  const cy = H * 0.34
  if (!aurora) {
    ctx.save()
    ctx.filter = `blur(${Math.round(W / 60)}px)`
    for (let i = 0; i < 90; i++) {
      const t = (r() - 0.5) * W * 1.5
      const off = (r() + r() - 1) * H * 0.09
      const x = cx + Math.cos(angle) * t - Math.sin(angle) * off
      const y = cy + Math.sin(angle) * t + Math.cos(angle) * off
      ctx.fillStyle = rgba(pick(r, ["#8c9ad8", "#c9b7e8", "#e8c9b0", "#6f86c8"]), 0.07)
      ctx.beginPath()
      ctx.arc(x, y, W * between(r, 0.02, 0.07), 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
  for (let i = 0; i < 5200; i++) {
    let x = r() * W
    let y = Math.pow(r(), 1.25) * H * 0.9
    if (!aurora && r() < 0.45) {
      const t = (r() - 0.5) * W * 1.5
      const off = (r() + r() + r() - 1.5) * H * 0.08
      x = cx + Math.cos(angle) * t - Math.sin(angle) * off
      y = cy + Math.sin(angle) * t + Math.cos(angle) * off
    }
    const big = r() < 0.03
    ctx.fillStyle = rgba(
      pick(r, ["#ffffff", "#ffffff", "#cfe0ff", "#ffe9cf"]),
      big ? 0.95 : 0.25 + r() * 0.6,
    )
    ctx.beginPath()
    ctx.arc(x, y, (big ? 2.1 : 0.5 + r() * 0.9) * (W / 2400), 0, Math.PI * 2)
    ctx.fill()
    if (big) glow(ctx, x, y, W * 0.006, "#cfe0ff", 0.5)
  }
  if (aurora) {
    // The curtains are drawn at a quarter of the size and blurred once on the way up.
    const [w, h] = [Math.ceil(W / 4), Math.ceil(H / 4)]
    const veil = createCanvas(w, h)
    const v = veil.getContext("2d")
    for (let band = 0; band < 3; band++) {
      const wave = ridgeNoise(r, 0.5, 1.6)
      const fold = ridgeNoise(r, 0.6, 9)
      const top = h * between(r, 0.08, 0.28)
      const color = pick(r, ["#39f0a0", "#58f7c0", "#7df58f"])
      for (let x = 0; x < w; x++) {
        const y = top + wave(x / w) * h * 0.3
        const len = h * (0.16 + fold(x / w) * 0.32)
        const g = v.createLinearGradient(0, y - len * 0.75, 0, y + len * 0.25)
        g.addColorStop(0, rgba("#a05cf0", 0))
        g.addColorStop(0.35, rgba("#7a6cf0", 0.07))
        g.addColorStop(0.82, rgba(color, 0.16 + fold(x / w) * 0.36))
        g.addColorStop(1, rgba(color, 0))
        v.fillStyle = g
        v.fillRect(x, y - len * 0.75, 1, len)
      }
    }
    ctx.save()
    ctx.globalCompositeOperation = "screen"
    ctx.filter = `blur(${Math.round(W / 260)}px)`
    ctx.drawImage(veil, 0, 0, W, H)
    ctx.restore()
  }
  glow(ctx, W * between(r, 0.2, 0.8), H * 0.82, W * 0.5, aurora ? "#2f8f7a" : "#c98a5a", 0.2)
  ridges(ctx, W, H, r, {
    layers: 3,
    from: 0.74,
    to: 0.98,
    amp: between(r, 0.14, 0.28),
    far: aurora ? "#0b2a33" : "#1a1c3a",
    near: "#020308",
    haze: aurora ? "#134a4d" : "#3a3158",
    roughness: 0.55,
  })
  finish(ctx, W, H, r, { grain: 0.16, vignette: 0.45 })
}

function dunes(c, ctx, W, H, r) {
  const p = pick(r, [
    {
      sky: ["#3f6f9c", "#a9c2cf", "#f1dcb8"],
      lit: "#f0b56a",
      shade: "#9c5a2c",
      haze: "#f3d9ae",
      sun: "#fff1cc",
    },
    {
      sky: ["#2a2f5c", "#93506f", "#f28c4a", "#ffd27a"],
      lit: "#ef8a3c",
      shade: "#5c2a20",
      haze: "#f6a765",
      sun: "#ffc15e",
    },
    {
      sky: ["#6f9fc8", "#cfe0e8", "#f7ecd6"],
      lit: "#f3cf96",
      shade: "#b98852",
      haze: "#f8ead0",
      sun: "#ffffff",
    },
  ])
  const horizon = between(r, 0.42, 0.56)
  sky(ctx, W, H, p.sky, H * horizon)
  sun(ctx, W, between(r, 0.2, 0.8) * W, H * between(r, 0.14, 0.4), p.sun, 0.02)
  const layers = 6
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1)
    const base = H * (horizon + 0.02 + t * (1 - horizon) * 0.95)
    const amp = H * (0.06 + t * 0.16)
    const n = ridgeNoise(r, 0.3, between(r, 0.8, 1.6), 4)
    const top = (x) => base - n(x / W) * amp
    const lit = mix(mix(p.haze, p.lit, 0.35 + t * 0.65), "#000000", t * 0.06)
    const shade = mix(mix(p.haze, p.shade, 0.3 + t * 0.7), "#000000", t * 0.12)
    const g = ctx.createLinearGradient(0, 0, W, 0)
    const k = r() < 0.5
    g.addColorStop(0, k ? lit : shade)
    g.addColorStop(between(r, 0.35, 0.65), mix(lit, shade, 0.5))
    g.addColorStop(1, k ? shade : lit)
    silhouette(ctx, W, H, top, g)
    // A sharp crest: the shaded slip face under each ridge line.
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(0, H)
    for (let x = 0; x <= W + 3; x += 3) ctx.lineTo(x, top(x))
    ctx.lineTo(W, H)
    ctx.clip()
    const face = ctx.createLinearGradient(0, base - amp, 0, base + amp * 0.5)
    face.addColorStop(0, rgba("#ffffff", 0.14))
    face.addColorStop(0.25, rgba(p.shade, 0))
    face.addColorStop(1, rgba(p.shade, 0.5))
    ctx.fillStyle = face
    ctx.fillRect(0, base - amp, W, H)
    // Wind ripples on the nearest dune.
    if (i === layers - 1) {
      ctx.strokeStyle = rgba(p.shade, 0.16)
      ctx.lineWidth = Math.max(1, W / 1400)
      const ripple = ridgeNoise(r, 0.4, 3, 3)
      for (let y = base - amp; y < H; y += H * 0.008) {
        ctx.beginPath()
        for (let x = 0; x <= W; x += 12) {
          const yy = y + ripple(x / W + y / H) * H * 0.03
          if (x) ctx.lineTo(x, yy)
          else ctx.moveTo(x, yy)
        }
        ctx.stroke()
      }
    }
    ctx.restore()
  }
  finish(ctx, W, H, r)
}

function city(c, ctx, W, H, r) {
  const p = pick(r, [
    {
      sky: ["#141a3c", "#4b3c77", "#c0587a", "#f7a66b"],
      far: "#5d4a7e",
      near: "#0e1020",
      lamp: "#ffd98a",
      water: "#1c1a3a",
      sun: "#ff9c6a",
    },
    {
      sky: ["#0a1026", "#162a52", "#2f507c", "#6f8cab"],
      far: "#243a5e",
      near: "#05070f",
      lamp: "#ffe6a6",
      water: "#0a1428",
      sun: "#9db8d8",
    },
    {
      sky: ["#2f5f95", "#89b1d6", "#f3d3b4", "#ffe9c4"],
      far: "#8f9bb0",
      near: "#232733",
      lamp: "#fff2c2",
      water: "#33506e",
      sun: "#ffe0b0",
    },
  ])
  const horizon = H * between(r, 0.6, 0.7)
  sky(ctx, W, H, p.sky, horizon)
  sun(ctx, W, between(r, 0.15, 0.85) * W, horizon * between(r, 0.6, 0.95), p.sun, 0.02)
  clouds(ctx, W, H, r, mix(p.sky[2], "#ffffff", 0.4), 4, [0.08, 0.36], 0.2)
  for (let layer = 0; layer < 3; layer++) {
    const t = layer / 2
    const color = mix(p.far, p.near, t)
    let x = -W * 0.02
    while (x < W) {
      const w = W * between(r, 0.018, 0.06) * (1 + t * 0.5)
      const h = H * between(r, 0.06, 0.22 + t * 0.2) * (r() < 0.12 ? 1.6 : 1)
      const y = horizon - h
      ctx.fillStyle = color
      ctx.fillRect(x, y, w, h + 2)
      if (r() < 0.25) ctx.fillRect(x + w * 0.42, y - h * 0.16, w * 0.16, h * 0.16)
      if (r() < 0.2) {
        ctx.beginPath()
        ctx.moveTo(x, y)
        ctx.lineTo(x + w / 2, y - w * 0.5)
        ctx.lineTo(x + w, y)
        ctx.fill()
      }
      if (layer > 0) {
        const cell = Math.max(4, W / 420)
        for (let wy = y + cell; wy < horizon - cell; wy += cell * 1.9) {
          for (let wx = x + cell * 0.8; wx < x + w - cell; wx += cell * 1.6) {
            if (r() < 0.16 + t * 0.12) {
              ctx.fillStyle = rgba(r() < 0.85 ? p.lamp : "#bfe3ff", 0.35 + r() * 0.6)
              ctx.fillRect(wx, wy, cell * 0.8, cell)
            }
          }
        }
      }
      x += w + (r() < 0.3 ? W * 0.004 : 0)
    }
  }
  ctx.clearRect(0, horizon, W, H - horizon)
  mirror(ctx, c, W, H, horizon, p.water, r, 0.36)
  finish(ctx, W, H, r, { grain: 0.13 })
}

function forest(c, ctx, W, H, r) {
  const p = pick(r, [
    { fog: ["#dfe6df", "#c6d3c7", "#aabdb0"], far: "#9fb4a5", near: "#0f1f18", light: "#fff3d0" },
    { fog: ["#f3dcc0", "#e0c2a0", "#b89a84"], far: "#b99a80", near: "#1e1712", light: "#ffd9a0" },
    { fog: ["#c9d9e6", "#a9bfd2", "#8aa3bb"], far: "#8ba3b8", near: "#0c1a26", light: "#f2f6ff" },
  ])
  sky(ctx, W, H, p.fog)
  glow(ctx, W * between(r, 0.25, 0.75), H * between(r, 0.1, 0.35), W * 0.7, p.light, 0.75)
  const layers = 6
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1)
    const n = ridgeNoise(r, 0.45, 2 + i)
    const base = (x) => H * (0.5 + t * 0.52) - n(x / W) * H * 0.1
    const color = mix(p.far, p.near, Math.pow(t, 1.2))
    silhouette(ctx, W, H, (x) => base(x) + H * 0.02, color)
    pines(ctx, W, H, r, base, H * (0.1 + t * 0.34), color, 1.1 - t * 0.35)
    const fog = ctx.createLinearGradient(0, H * (0.3 + t * 0.5), 0, H * (0.62 + t * 0.5))
    fog.addColorStop(0, rgba(p.fog[0], 0))
    fog.addColorStop(1, rgba(p.fog[0], 0.5 * (1 - t)))
    ctx.fillStyle = fog
    ctx.fillRect(0, 0, W, H)
  }
  finish(ctx, W, H, r)
}

function fields(c, ctx, W, H, r) {
  const p = pick(r, [
    {
      sky: ["#2e6fb5", "#7fb4de", "#d5e9f2"],
      hills: ["#9cc7a0", "#7fb26a", "#5c9a45", "#3f7a31", "#2a5a25"],
      crop: "#d9c95c",
      cloud: "#ffffff",
      sun: "#fff8dc",
    },
    {
      sky: ["#4a6fa0", "#d79a78", "#f8cf8c"],
      hills: ["#c7b98a", "#c2a557", "#a8872f", "#7f6a2a", "#4f4a22"],
      crop: "#f0c24a",
      cloud: "#ffd9b0",
      sun: "#ffd68a",
    },
    {
      sky: ["#5b88b8", "#b9d2e4", "#eef3f0"],
      hills: ["#b9d2b6", "#96c08a", "#74ad5c", "#4f9440", "#356f2f"],
      crop: "#f2e06a",
      cloud: "#ffffff",
      sun: "#ffffff",
    },
  ])
  const horizon = between(r, 0.46, 0.58)
  sky(ctx, W, H, p.sky, H * horizon)
  sun(ctx, W, between(r, 0.15, 0.85) * W, H * between(r, 0.1, 0.3), p.sun, 0.02)
  clouds(ctx, W, H, r, p.cloud, 7 + Math.floor(r() * 6), [0.06, 0.4], 0.42)
  for (let i = 0; i < p.hills.length; i++) {
    const t = i / (p.hills.length - 1)
    const base = H * (horizon + 0.04 + t * (1 - horizon) * 0.9)
    const amp = H * (0.07 + t * 0.09)
    const n = ridgeNoise(r, 0.3, between(r, 0.8, 1.8), 4)
    const top = (x) => base - n(x / W) * amp
    const g = ctx.createLinearGradient(0, base - amp, 0, base + H * 0.25)
    g.addColorStop(0, mix(p.hills[i], "#ffffff", 0.12))
    g.addColorStop(1, mix(p.hills[i], "#000000", 0.25))
    silhouette(ctx, W, H, top, g)
    if (i % 2 === 1) {
      // Crop rows following the slope.
      ctx.save()
      ctx.beginPath()
      ctx.moveTo(0, H)
      for (let x = 0; x <= W + 3; x += 3) ctx.lineTo(x, top(x))
      ctx.lineTo(W, H)
      ctx.clip()
      ctx.strokeStyle = rgba(p.crop, 0.34)
      ctx.lineWidth = Math.max(1.5, (W / 900) * (0.6 + t))
      const lean = between(r, -0.5, 0.5)
      for (let x = -W; x < W * 2; x += W * (0.012 + t * 0.012)) {
        ctx.beginPath()
        ctx.moveTo(x, base - amp)
        ctx.lineTo(x + lean * W * 0.5, H)
        ctx.stroke()
      }
      ctx.restore()
    }
    if (i === 2 || (i === 3 && r() < 0.5)) {
      // A lone tree or two on a crest.
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        const x = between(r, 0.1, 0.9) * W
        const y = top(x)
        const s = H * (0.03 + t * 0.05)
        const leaf = mix(p.hills[4], "#000000", 0.35)
        ctx.fillStyle = leaf
        ctx.fillRect(x - s * 0.05, y - s * 0.7, s * 0.1, s * 0.75)
        for (let b = 0; b < 9; b++) {
          ctx.beginPath()
          ctx.arc(
            x + (r() - 0.5) * s * 0.9,
            y - s * (0.75 + r() * 0.65),
            s * between(r, 0.22, 0.42),
            0,
            Math.PI * 2,
          )
          ctx.fill()
        }
      }
    }
  }
  finish(ctx, W, H, r)
}

const SCENES = { alps, lake, coast, night, dunes, city, forest, fields }

function photo(file, scene, seed, size, options) {
  const [W, H] = size
  const canvas = createCanvas(W, H)
  const ctx = canvas.getContext("2d")
  SCENES[scene](canvas, ctx, W, H, rng(seed), options)
  writeFileSync(file, canvas.toBuffer(file.endsWith(".png") ? "image/png" : "image/jpeg", 90))
}

// ---------------------------------------------------------------- library

const LANDSCAPE = [2400, 1600]
const PORTRAIT = [1600, 2400]
const WIDE = [2560, 1440]

/** Each album: the folder, how its files are named, when it was shot and what is in it. */
const ALBUMS = [
  {
    folder: "Pictures/Dolomites 2026",
    name: (i) => `DSC_${String(4180 + i * 3).padStart(4, "0")}.jpg`,
    start: "2026-06-14T05:10:00",
    hours: 150,
    scenes: [
      ["alps", 20],
      ["lake", 10],
      ["forest", 8],
      ["night", 4],
    ],
    clips: [
      ["Tre Cime sunrise.mp4", "alps", 11],
      ["Lago di Braies.mp4", "lake", 9],
    ],
  },
  {
    folder: "Pictures/Iceland",
    name: (i) => `IMG_${String(2210 + i * 2).padStart(4, "0")}.jpg`,
    start: "2026-02-08T09:30:00",
    hours: 120,
    scenes: [
      ["coast", 10, { palette: "nordic" }],
      ["night", 9, { aurora: true }],
      ["alps", 8, { palette: "storm" }],
      ["lake", 5, { palette: "dusk" }],
    ],
    clips: [["Aurora over Kirkjufell.mp4", "night", 10, { aurora: true }]],
  },
  {
    folder: "Pictures/Sahara",
    name: (i) => `P10${String(40311 + i * 4)}.jpg`,
    start: "2025-11-21T06:00:00",
    hours: 70,
    scenes: [
      ["dunes", 18],
      ["night", 4, { aurora: false }],
    ],
    clips: [],
  },
  {
    folder: "Pictures/Lisbon weekend",
    name: (i, d) =>
      `PXL_${d.toISOString().slice(0, 10).replace(/-/g, "")}_${d.toISOString().slice(11, 19).replace(/:/g, "")}.jpg`,
    start: "2026-09-18T08:20:00",
    hours: 56,
    scenes: [
      ["city", 14],
      ["coast", 8, { palette: "sunset" }],
      ["coast", 4, { palette: "morning" }],
    ],
    clips: [["Tagus ferry.mp4", "city", 8]],
  },
  {
    folder: "Pictures/Countryside",
    name: (i) => `DSCF${String(1032 + i).padStart(4, "0")}.jpg`,
    start: "2026-05-02T10:00:00",
    hours: 200,
    scenes: [
      ["fields", 16],
      ["forest", 6],
    ],
    clips: [],
  },
]

const WALLPAPERS = [
  ["Alpine dawn.jpg", "alps", { palette: "dawn" }],
  ["Aurora ridge.jpg", "night", { aurora: true }],
  ["Blue hour skyline.jpg", "city"],
  ["Dune sea.jpg", "dunes"],
  ["Evening tide.jpg", "coast", { palette: "sunset" }],
  ["Misty pines.jpg", "forest"],
  ["Mirror lake.jpg", "lake", { palette: "day" }],
  ["Milky Way.jpg", "night", { aurora: false }],
  ["Rolling fields.jpg", "fields"],
  ["Storm light.jpg", "alps", { palette: "storm" }],
]

const DOCUMENTS = {
  "Documents/Trips/Dolomites itinerary.md": `# Dolomites, June 2026

| Day | Base | Plan |
|---|---|---|
| 1 | Cortina d'Ampezzo | Arrive, Lago di Sorapis in the afternoon |
| 2 | Cortina d'Ampezzo | Tre Cime loop at sunrise, Cadini viewpoint |
| 3 | Val Gardena | Seceda ridge, down by the cable car |
| 4 | Val Gardena | Alpe di Siusi, slow day |
| 5 | Braies | The lake before the boats go out |

## To book

- [x] Rifugio Auronzo, night of day 1
- [x] Car from Venice
- [ ] Seceda cable car, first ride
`,
  "Documents/Trips/Packing list.txt": `Camera, two batteries, charger
24-70 and 70-200, polariser, six-stop ND
Tripod, the light one
Headlamp
Rain shell, down jacket, gloves
Boots, two pairs of socks per day
Paper map of Tre Cime (no signal on the north side)
`,
  "Documents/Trips/Budget.csv": `item,category,eur
Flights,travel,284.00
Car hire,travel,312.50
Rifugio Auronzo,stay,96.00
Hotel Val Gardena,stay,402.00
Cable cars,activities,118.00
Fuel,travel,74.30
Food,food,390.00
`,
  "Documents/Notes/Photo book ideas.md": `# Photo book

1. Open with the sunrise at Tre Cime, full bleed.
2. A spread of the lakes, morning against evening.
3. The night pictures get black pages.
4. Close with the walk down in the rain.

Printer wants sRGB JPEG at 300 dpi; export from the editor with the "Print" recipe.
`,
  "Documents/Notes/Export settings.json": `{
  "recipe": "Web gallery",
  "steps": [
    { "tool": "resize", "longEdge": 2048 },
    { "tool": "sharpen", "amount": 0.4, "radius": 0.8 },
    { "tool": "watermark", "text": "© 2026", "anchor": "bottom-right", "opacity": 0.35 }
  ],
  "output": { "format": "jpeg", "quality": 86, "folder": "Web" }
}
`,
  "Downloads/readme.txt": "Maps and tracks for the June trip.\n",
  "Desktop/To sort.txt": "Card 2 is still in the bag.\n",
}

const TRACKS = ["Day 1 Sorapis", "Day 2 Tre Cime", "Day 3 Seceda", "Day 5 Braies"].map((day) => [
  `${day}.gpx`,
  `<?xml version="1.0"?>\n<gpx version="1.1" creator="demo"><trk><name>${day}</name></trk></gpx>\n`,
])

/** A zip archive of small text files, stored without compression. */
function zip(files) {
  const local = []
  const central = []
  let offset = 0
  for (const [name, text] of files) {
    const [file, data] = [Buffer.from(name), Buffer.from(text)]
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // names are UTF-8
    head.writeUInt32LE(0x5ace0000, 10) // 14 June 2025, midnight
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(data.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(file.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    head.copy(entry, 6, 4, 30) // the same fields, from "version needed" on
    entry.writeUInt32LE(offset, 42)
    local.push(head, file, data)
    central.push(entry, file)
    offset += 30 + file.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

function ffmpeg(args) {
  execFileSync(process.env.PANELYTH_FFMPEG || "ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    ...args,
  ])
}

function build() {
  const marker = join(demoRoot, ".generated")
  if (existsSync(marker) && !process.argv.includes("--force")) {
    console.log(`demo library already at ${demoHome} (pass --force to draw it again)`)
    return
  }
  rmSync(demoRoot, { recursive: true, force: true })
  const started = performance.now()
  let seed = 1000
  let pictures = 0
  const stills = join(demoRoot, ".stills")
  mkdirSync(stills, { recursive: true })

  for (const album of ALBUMS) {
    const dir = join(demoHome, album.folder)
    mkdirSync(dir, { recursive: true })
    // Scenes are interleaved the way a day of shooting mixes subjects.
    const shots = album.scenes.flatMap(([scene, count, options]) =>
      Array.from({ length: count }, () => ({ scene, options })),
    )
    const order = rng(seed++)
    shots.sort(() => order() - 0.5)
    const total = shots.length
    shots.forEach((shot, i) => {
      const taken = new Date(new Date(album.start).getTime() + (i / total) * album.hours * 3600e3)
      const file = join(dir, album.name(i, taken))
      const shape = rng(seed + 5)() < 0.16 ? PORTRAIT : LANDSCAPE
      photo(file, shot.scene, seed++, shape, shot.options)
      utimesSync(file, taken, taken)
      pictures++
    })
    for (const [name, scene, seconds, options] of album.clips) {
      const still = join(stills, `${seed}.png`)
      photo(still, scene, seed++, [2880, 1620], options)
      const frames = seconds * 30
      // A slow push-in over a still: a real, seekable H.264 clip with a poster frame.
      ffmpeg([
        "-loop",
        "1",
        "-i",
        still,
        "-vf",
        `scale=5760:-1,zoompan=z='1+0.16*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30`,
        "-t",
        String(seconds),
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "21",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        join(dir, name),
      ])
      const taken = new Date(new Date(album.start).getTime() + album.hours * 1800e3)
      utimesSync(join(dir, name), taken, taken)
    }
    console.log(`${album.folder}: ${total} pictures, ${album.clips.length} clips`)
  }

  const wallpapers = join(demoHome, "Pictures", "Wallpapers")
  mkdirSync(wallpapers, { recursive: true })
  for (const [name, scene, options] of WALLPAPERS) {
    photo(join(wallpapers, name), scene, seed++, WIDE, options)
    pictures++
  }

  // The Videos folder holds the same clips, as a library would after a copy.
  const videos = join(demoHome, "Videos")
  mkdirSync(videos, { recursive: true })
  for (const [name, scene, seconds, options] of [
    ["Morning on the ridge.mp4", "alps", 8, { palette: "golden" }],
    ["Dunes at dusk.mp4", "dunes", 8],
    ["Harbour lights.mp4", "city", 7],
  ]) {
    const still = join(stills, `${seed}.png`)
    photo(still, scene, seed++, [2880, 1620], options)
    const frames = seconds * 30
    ffmpeg([
      "-loop",
      "1",
      "-i",
      still,
      "-vf",
      `scale=5760:-1,zoompan=z='1.16-0.16*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=30`,
      "-t",
      String(seconds),
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "21",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(videos, name),
    ])
  }

  for (const [path, text] of Object.entries(DOCUMENTS)) {
    mkdirSync(dirname(join(demoHome, path)), { recursive: true })
    writeFileSync(join(demoHome, path), text)
  }
  // An archive the commander can enter like a folder.
  writeFileSync(join(demoHome, "Downloads", "Dolomites tracks.zip"), zip(TRACKS))
  rmSync(stills, { recursive: true, force: true })

  writeFileSync(marker, new Date().toISOString())
  console.log(
    `${pictures} pictures in ${Math.round((performance.now() - started) / 1000)} s → ${demoHome}`,
  )
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) build()

export { photo, zip, SCENES, TRACKS }
