// Draws the app icon and writes every file made from it (`pnpm icons`).
//
// The mark: an isometric block, the shell that hosts both apps, drawn in
// flat-shaded polygons with its front edges chamfered. Its top is a sheet of
// white paper that is an eye (the diamond of the top is the eye's lids, with a
// gem-cut iris lying in it); its two sides are the two panels, the viewer's
// green and the commander's blue, with file rows across them. Light falls from
// the top left. It stands free on Windows and Linux, over a soft shadow, and
// sits on a dark tile on macOS.
//
// The small sizes (up to 32 px: the taskbar, the menu bar) have their own
// drawing: wider chamfers, a plain iris and bare panels, and no shadow, because
// facets, rows and soft shadows turn into a smudge in a 16 px slot.
//
// In src/shared/desktop/build:
//   icon.svg        the mark: Windows, Linux and the window icon
//   icon-small.svg  the mark drawn for 32 px and below
//   icon-mac.svg    the mark on the macOS tile (the 824 px grid of Apple's template)
//   mark.svg        icon.svg cropped to the page, for pages and documents
//   icon.png        1024 px, the window icon on macOS and Linux (src/shared/desktop/src/main/paths.ts)
//   icons/*.png     the Linux set
//   icon.ico        Windows, 16 to 256 px at the scales the shell asks for; also the window icon there
//   icon.icns       macOS, 16 to 1024 px on the tile
// and showcase/src/media/mark.svg, the site's header and footer, also written to
// src/shared/ui/src/assets/mark.svg, the mark at the top of the apps' rail.
//
// Chromium renders the pictures, through the e2e package's Playwright: its own
// build when installed (`pnpm --filter @panelyth/e2e exec playwright install
// chromium`), else Chrome or Edge.
import { mkdirSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { inflateSync } from "node:zlib"

const root = join(dirname(fileURLToPath(import.meta.url)), "..")
const BUILD = join(root, "src", "shared", "desktop", "build")
const SHOWCASE_MARK = join(root, "showcase", "src", "media", "mark.svg")
const RAIL_MARK = join(root, "src", "shared", "ui", "src", "assets", "mark.svg")

/** Up to this size the small drawing is used. */
const SMALL = 32
const LINUX = [16, 24, 32, 48, 64, 128, 256, 512, 1024]
/** Windows: 16, 24, 32 and 48 px at 100 % to 200 % scale (20 is 16 at 125 %), 128 and 256. */
const WINDOWS = [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 128, 256]
/** What `iconutil` writes for a full .iconset: [type, pixels]. */
const MAC = [
  ["icp4", 16],
  ["ic11", 32],
  ["icp5", 32],
  ["ic12", 64],
  ["ic07", 128],
  ["ic13", 256],
  ["ic08", 256],
  ["ic14", 512],
  ["ic09", 512],
  ["ic10", 1024],
]

// ---- Drawing, on a 1024 px canvas ------------------------------------------------

const C = 512
const num = (n) => String(Math.round(n * 10) / 10)

/**
 * The palette: the viewer's green and the commander's blue on the two
 * panels, paper white on top, and the eye's colours.
 */
const INK = {
  green: { light: "#3ff0a0", dark: "#0f9d62", edge: "#d9ffec" },
  blue: { light: "#3d86ff", dark: "#1a3fb8", edge: "#dce8ff" },
  paper: { back: "#dce5f0", front: "#fbfcfe", rim: "#a9b8cc" },
  iris: { green: "#2bf07f", teal: "#19c9c2", blue: "#2f6bff", deep: "#0b2f6e" },
  pupil: "#050d1f",
}

const stops = (list) =>
  list
    .map(([at, color, opacity = 1]) =>
      opacity === 1
        ? `<stop offset="${at}" stop-color="${color}"/>`
        : `<stop offset="${at}" stop-color="${color}" stop-opacity="${opacity}"/>`,
    )
    .join("")
const linear = (id, [x1, y1], [x2, y2], list) =>
  `<linearGradient id="${id}" x1="${num(x1)}" y1="${num(y1)}" x2="${num(x2)}" y2="${num(y2)}" gradientUnits="userSpaceOnUse">${stops(list)}</linearGradient>`
const radial = (id, [cx, cy], r, list) =>
  `<radialGradient id="${id}" cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" gradientUnits="userSpaceOnUse">${stops(list)}</radialGradient>`
const shape = (points) => `M${points.map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}Z`

/** `a` to `b` (hex colours) by `k`. */
function mix(a, b, k) {
  const ch = (hex, i) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16)
  const out = [0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * k))
  return `#${out.map((v) => v.toString(16).padStart(2, "0")).join("")}`
}

const COS = Math.cos(Math.PI / 6)
const SIN = 0.5
/**
 * A point of the block on the canvas, in isometric view: `x` runs toward
 * you on the right, `y` toward you on the left and `z` up; the block's top
 * back corner is at the origin.
 */
const iso = ([x, y, z]) => [(x - y) * COS, (x + y) * SIN - z]

/**
 * Each drawing, the block's sizes as parts of its top's side: its height, and
 * how far its three front edges are chamfered; the iris's radius as a part of
 * the top's side; how many file rows each panel shows; and how much of the
 * canvas the block fills.
 */
const DRAWINGS = {
  big: { height: 0.8, chamfer: 0.055, iris: 0.52, rows: 4, fill: 0.86 },
  small: { height: 0.78, chamfer: 0.08, iris: 0.56, rows: 0, fill: 0.95 },
}

/** The file rows on a panel, in the panel's own units (its width and height 1): left end, top, length. */
const ROWS = [
  [0.14, 0.2, 0.62],
  [0.14, 0.38, 0.44],
  [0.14, 0.56, 0.7],
  [0.14, 0.74, 0.36],
]

/**
 * The iris, a cut gem round `[cx, cy]` of radius `r`, lying in a plane that
 * `squash`es it upright (1 / √3 on the block's top): two rings of facets,
 * green toward the light at the top left and blue away from it, each lit by
 * which way it leans and darker the deeper it lies; the pupil in its middle.
 */
function iris([cx, cy], r, squash) {
  const ring = (rr, offset) =>
    Array.from({ length: 12 }, (_, k) => {
      const a = ((k * 30 + offset - 90) * Math.PI) / 180
      return [cx + rr * Math.cos(a), cy + rr * Math.sin(a) * squash]
    })
  const A = ring(r, 0)
  const B = ring(r * 0.7, 15)
  const P = ring(r * 0.4, 0)
  /** The facet's colour: its hue by where it lies round the iris, its light by which way it leans and how deep it lies. */
  const tone = (points, lean, depth) => {
    const [x, y] = points.reduce(([sx, sy], [px, py]) => [sx + px / 3, sy + py / 3], [0, 0])
    const a = Math.atan2((y - cy) / squash, x - cx)
    // 0 toward the light (top left), 1 away from it.
    const away = (1 - Math.cos(a + (3 * Math.PI) / 4)) / 2
    const hue =
      away < 0.5
        ? mix(INK.iris.green, INK.iris.teal, away * 2)
        : mix(INK.iris.teal, INK.iris.blue, away * 2 - 1)
    const lit =
      lean > 0
        ? mix(hue, "#ffffff", 0.18 * lean * (1 - away))
        : mix(hue, INK.iris.deep, -0.35 * lean)
    return mix(lit, INK.iris.deep, depth)
  }
  const facets = []
  for (let k = 0; k < 12; k++) {
    const n = (k + 1) % 12
    facets.push({ points: [A[k], A[n], B[k]], lean: 1, depth: 0 })
    facets.push({ points: [B[k], B[n], A[n]], lean: -0.4, depth: 0.1 })
    facets.push({ points: [B[k], B[n], P[n]], lean: 0.6, depth: 0.28 })
    facets.push({ points: [P[k], P[n], B[k]], lean: -0.6, depth: 0.4 })
  }
  return {
    facets: facets.map((f) => ({ d: shape(f.points), fill: tone(f.points, f.lean, f.depth) })),
    rim: shape(A),
    pupil: shape(P),
  }
}

/**
 * The block in isometric view, its top 100 a side and `height` of that tall,
 * with its three front edges chamfered and its back edge too (which, seen
 * edge on, cuts the top's back corner as the others are cut): each face as a
 * polygon on the canvas, and the maps that take a panel's own units (its width
 * and height 1) onto the left and right panels.
 */
function block({ height, chamfer }) {
  const L = 100
  const H = height * L
  const c = chamfer * L
  const e = L - c
  const P = (list) => list.map(iso)
  const faces = {
    // From the back corner's cut round by the right, front and left corners.
    top: P([
      [0, c, H],
      [c, 0, H],
      [e, 0, H],
      [e, e, H],
      [0, e, H],
    ]),
    left: P([
      [0, L, H - c],
      [e, L, H - c],
      [e, L, 0],
      [0, L, 0],
    ]),
    right: P([
      [L, e, H - c],
      [L, 0, H - c],
      [L, 0, 0],
      [L, e, 0],
    ]),
    // The chamfers: along the top's front left and front right edges, down the front edge, and where they meet.
    topLeft: P([
      [0, e, H],
      [e, e, H],
      [e, L, H - c],
      [0, L, H - c],
    ]),
    topRight: P([
      [e, 0, H],
      [e, e, H],
      [L, e, H - c],
      [L, 0, H - c],
    ]),
    front: P([
      [e, L, H - c],
      [L, e, H - c],
      [L, e, 0],
      [e, L, 0],
    ]),
    corner: P([
      [e, e, H],
      [L, e, H - c],
      [e, L, H - c],
    ]),
    ground: P([
      [0, 0, 0],
      [L, 0, 0],
      [L, L, 0],
      [0, L, 0],
    ]),
  }
  // A panel's (u, v) to the canvas: u along its top edge, v down it.
  const [lx, ly] = iso([0, L, H - c])
  const [rx, ry] = iso([L, e, H - c])
  const maps = {
    left: [COS * e, SIN * e, 0, H - c, lx, ly],
    right: [COS * e, -SIN * e, 0, H - c, rx, ry],
  }
  const eye = iso([e / 2, e / 2, H])
  return { faces, maps, eye, side: e }
}

/**
 * The mark: an isometric block, the shell that hosts both apps. Its top is a
 * sheet of white paper that is an eye: the diamond of the top is the eye's
 * lids, and a gem-cut iris lies in it, with a small diamond (the top's own
 * shape) for a catchlight. Its two sides are the two panels, the viewer's
 * green on the left and the commander's blue on the right, with file rows
 * across them. Light falls from the top left: the top is brightest, the green
 * side lit, the blue side in shade, and the chamfered front edges catch the
 * light. Small, the iris is plain and the panels bare. `p` prefixes its ids.
 */
function mark(small, p = "") {
  const d = small ? DRAWINGS.small : DRAWINGS.big
  const b = block(d)
  const f = b.faces
  const all = Object.values(f).flat()
  const xs = all.map(([x]) => x)
  const ys = all.map(([, y]) => y)
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const scale = (2 * C * d.fill) / Math.max(x1 - x0, y1 - y0)
  const place = `translate(${C} ${C}) scale(${Math.round(scale * 1000) / 1000}) translate(${num(-(x0 + x1) / 2)} ${num(-(y0 + y1) / 2)})`
  const [ex, ey] = b.eye
  const r = d.iris * b.side
  const top = (k) => [f.top[3][0], f.top[0][1] + (f.top[3][1] - f.top[0][1]) * k]
  const defs = [
    linear(`${p}paper`, top(0), top(1), [
      [0, INK.paper.back],
      [1, INK.paper.front],
    ]),
    linear(`${p}green`, f.left[0], f.left[3], [
      [0, INK.green.light],
      [1, INK.green.dark],
    ]),
    linear(`${p}blue`, f.right[0], f.right[3], [
      [0, INK.blue.light],
      [1, INK.blue.dark],
    ]),
    linear(`${p}front`, f.front[0], f.front[3], [
      [0, "#7defd3"],
      [1, "#16928f"],
    ]),
    // The upper lid's shadow on the eye.
    linear(`${p}lid`, top(0), top(0.4), [
      [0, "#0a2340", 0.1],
      [1, "#0a2340", 0],
    ]),
    `<clipPath id="${p}top"><path d="${shape(f.top)}"/></clipPath>`,
  ]
  const body = []
  if (!small) {
    defs.push(
      `<filter id="${p}blur" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="3.5"/></filter>`,
    )
    // The block's shadow on the ground.
    body.push(
      `<path d="${shape(f.ground)}" transform="translate(0 6)" fill="#04101f" fill-opacity=".28" filter="url(#${p}blur)"/>`,
    )
  }
  body.push(
    `<path d="${shape(f.left)}" fill="url(#${p}green)"/>`,
    `<path d="${shape(f.right)}" fill="url(#${p}blue)"/>`,
    `<path d="${shape(f.front)}" fill="url(#${p}front)"/>`,
  )
  // The file rows: light bars across each panel, as a file list shows them.
  for (const [side, opacity] of [
    ["left", 0.32],
    ["right", 0.26],
  ])
    if (d.rows)
      body.push(
        `<g transform="matrix(${b.maps[side].map((v) => num(v)).join(" ")})" fill="#ffffff" fill-opacity="${opacity}">`,
        ...ROWS.slice(0, d.rows).map(
          ([u, v, len]) => `  <rect x="${u}" y="${v}" width="${len}" height=".085" rx=".04"/>`,
        ),
        `</g>`,
      )
  body.push(
    `<path d="${shape(f.top)}" fill="url(#${p}paper)"/>`,
    `<path d="${shape(f.topLeft)}" fill="${INK.green.edge}"/>`,
    `<path d="${shape(f.topRight)}" fill="${INK.blue.edge}"/>`,
    `<path d="${shape(f.corner)}" fill="#ffffff"/>`,
  )
  // The eye, lying in the top's own plane, and its catchlight: a small diamond, the block's own top.
  const eye = iris([ex, ey], r, 1 / Math.sqrt(3))
  const glint = (w) => {
    const [gx, gy] = [ex - r * 0.36, ey - r * 0.2]
    return shape([
      [gx - w * COS, gy],
      [gx, gy - w * SIN],
      [gx + w * COS, gy],
      [gx, gy + w * SIN],
    ])
  }
  body.push(`<g clip-path="url(#${p}top)">`)
  if (small)
    body.push(
      `  <path d="${eye.rim}" fill="${INK.iris.teal}"/>`,
      `  <path d="${eye.pupil}" fill="${INK.pupil}"/>`,
      `  <path d="${glint(r * 0.3)}" fill="#ffffff"/>`,
    )
  else
    body.push(
      ...eye.facets.map((facet) => `  <path d="${facet.d}" fill="${facet.fill}"/>`),
      `  <path d="${eye.rim}" fill="none" stroke="${INK.iris.deep}" stroke-opacity=".55" stroke-width="${num(r * 0.04)}" stroke-linejoin="round"/>`,
      `  <path d="${eye.pupil}" fill="${INK.pupil}"/>`,
      `  <path d="${shape(f.top)}" fill="url(#${p}lid)"/>`,
      `  <path d="${glint(r * 0.24)}" fill="#ffffff" fill-opacity=".95"/>`,
    )
  body.push(`</g>`)
  // The top's back edges and the chamfers' ends, drawn fine so the block keeps its shape on a white page.
  body.push(
    `<path d="M${[f.topLeft[3], f.top[4], f.top[0], f.top[1], f.top[2], f.topRight[3]].map(([x, y]) => `${num(x)} ${num(y)}`).join("L")}" fill="none" stroke="${INK.paper.rim}" stroke-width="${small ? 1.4 : 0.8}" stroke-linejoin="round"/>`,
  )
  return { defs, body: [`<g transform="${place}">`, ...body.map((l) => `  ${l}`), `</g>`] }
}

/** The mark on the macOS tile: 824 px with a 100 px margin, corner radius 184. */
function macTile(small) {
  const m = mark(small, "m-")
  const k = small ? 0.84 : 0.74
  return {
    defs: [
      linear(
        "tile",
        [C, 100],
        [C, 924],
        [
          [0, "#162133"],
          [1, "#070b12"],
        ],
      ),
      linear(
        "edge",
        [C, 100],
        [C, 924],
        [
          [0, "#ffffff", 0.2],
          [0.5, "#ffffff", 0.03],
          [1, "#ffffff", 0.08],
        ],
      ),
      radial("glow", [C, C * 0.9], 430, [
        [0, INK.iris.teal, 0.22],
        [1, INK.iris.teal, 0],
      ]),
      ...m.defs,
    ],
    body: [
      `<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#tile)"/>`,
      ...(small
        ? []
        : [`<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#glow)"/>`]),
      `<g transform="translate(${C} ${C}) scale(${k}) translate(-${C} -${C})">`,
      ...m.body.map((l) => `  ${l}`),
      `</g>`,
      `<rect x="102" y="102" width="820" height="820" rx="182" fill="none" stroke="url(#edge)" stroke-width="4"/>`,
    ],
  }
}

const NOTE = "<!-- Drawn by scripts/icons.mjs (pnpm icons): change the script, not this file. -->"
const doc = ({ defs, body }, { viewBox = "0 0 1024 1024", size = 1024, title } = {}) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">`,
    ...(title ? [`  <title>${title}</title>`] : []),
    `  ${NOTE}`,
    ...(defs.length ? [`  <defs>`, ...defs.map((l) => `    ${l}`), `  </defs>`] : []),
    ...body.map((l) => `  ${l}`),
    `</svg>`,
    ``,
  ].join("\n")

/** Cropped to the drawing, as a square, with a little room round it. */
const crop = ({ fill }) => {
  const at = Math.floor(C * (1 - fill)) - 12
  return `${at} ${at} ${2 * (C - at)} ${2 * (C - at)}`
}

// ---- Packing ------------------------------------------------------------------------

/** The pixels of an 8-bit RGBA PNG without interlacing (what Chromium writes). */
function pixels(png) {
  let width = 0
  let height = 0
  const idat = []
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at)
    const type = png.toString("latin1", at + 4, at + 8)
    const data = png.subarray(at + 8, at + 8 + length)
    if (type === "IHDR") {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      if (data[8] !== 8 || data[9] !== 6 || data[12] !== 0) throw new Error("not 8-bit RGBA")
    } else if (type === "IDAT") idat.push(data)
    at += length + 12
  }
  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * 4
  const out = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4] : 0
      const b = y > 0 ? out[(y - 1) * stride + x] : 0
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0
      const p = a + b - c
      const paeth =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c
      const predictor = [0, a, b, (a + b) >> 1, paeth][filter]
      out[y * stride + x] = (raw[line + x] + predictor) & 255
    }
  }
  return { width, height, out }
}

/** A 32-bit bitmap for an .ico: bottom-up BGRA, then the 1-bit mask of what is transparent. */
function dib(png) {
  const { width: w, height: h, out: rgba } = pixels(png)
  const maskRow = Math.ceil(w / 32) * 4
  const bmp = Buffer.alloc(40 + w * h * 4 + maskRow * h)
  bmp.writeUInt32LE(40, 0)
  bmp.writeInt32LE(w, 4)
  bmp.writeInt32LE(h * 2, 8) // the colours and the mask
  bmp.writeUInt16LE(1, 12)
  bmp.writeUInt16LE(32, 14)
  bmp.writeUInt32LE(w * h * 4 + maskRow * h, 20)
  for (let y = 0; y < h; y++) {
    const row = h - 1 - y
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4
      const d = 40 + (row * w + x) * 4
      bmp[d] = rgba[s + 2]
      bmp[d + 1] = rgba[s + 1]
      bmp[d + 2] = rgba[s]
      bmp[d + 3] = rgba[s + 3]
      if (rgba[s + 3] === 0) bmp[40 + w * h * 4 + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7)
    }
  }
  return bmp
}

/**
 * A Windows .ico: bitmaps below 256 px and a PNG at 256, the layout every
 * reader takes (some, such as .NET's System.Drawing, misread smaller PNGs).
 */
function ico(images) {
  const data = images.map(([size, png]) => (size >= 256 ? png : dib(png)))
  const head = Buffer.alloc(6 + 16 * images.length)
  head.writeUInt16LE(1, 2)
  head.writeUInt16LE(images.length, 4)
  let offset = head.length
  images.forEach(([size], i) => {
    const at = 6 + 16 * i
    head.writeUInt8(size >= 256 ? 0 : size, at)
    head.writeUInt8(size >= 256 ? 0 : size, at + 1)
    head.writeUInt16LE(1, at + 4)
    head.writeUInt16LE(32, at + 6)
    head.writeUInt32LE(data[i].length, at + 8)
    head.writeUInt32LE(offset, at + 12)
    offset += data[i].length
  })
  return Buffer.concat([head, ...data])
}

/** An Apple .icns of PNG entries. */
function icns(entries) {
  const parts = entries.map(([type, png]) => {
    const head = Buffer.alloc(8)
    head.write(type, 0, "latin1")
    head.writeUInt32BE(png.length + 8, 4)
    return Buffer.concat([head, png])
  })
  const head = Buffer.alloc(8)
  head.write("icns", 0, "latin1")
  head.writeUInt32BE(8 + parts.reduce((n, p) => n + p.length, 0), 4)
  return Buffer.concat([head, ...parts])
}

// ---- Rendering ----------------------------------------------------------------------

async function browser() {
  const e2e = createRequire(join(root, "src", "shared", "e2e", "package.json"))
  const { chromium } = e2e("@playwright/test")
  for (const options of [{}, { channel: "chrome" }, { channel: "msedge" }]) {
    try {
      return await chromium.launch(options)
    } catch {
      // Try the next browser.
    }
  }
  throw new Error(
    "No Chromium to render with: run `pnpm --filter @panelyth/e2e exec playwright install chromium`.",
  )
}

/** Renders an SVG at `size` px on a transparent background. */
async function png(page, svg, size) {
  await page.setViewportSize({ width: size, height: size })
  const src = `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}img{display:block}</style><img width="${size}" height="${size}" src="${src}">`,
  )
  await page.locator("img").evaluate((img) => img.decode())
  return page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } })
}

const svgs = {
  big: doc(mark(false)),
  small: doc(mark(true)),
  mac: doc(macTile(false)),
  macSmall: doc(macTile(true)),
}
const written = []
const write = (path, data) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, data)
  written.push(relative(root, path))
}

write(join(BUILD, "icon.svg"), svgs.big)
write(join(BUILD, "icon-small.svg"), svgs.small)
write(join(BUILD, "icon-mac.svg"), svgs.mac)
write(
  join(BUILD, "mark.svg"),
  doc(mark(false), { viewBox: crop(DRAWINGS.big), size: 96, title: "Panelyth" }),
)
const smallMark = doc(mark(true), { viewBox: crop(DRAWINGS.small), size: 96, title: "Panelyth" })
write(SHOWCASE_MARK, smallMark)
write(RAIL_MARK, smallMark)

const chromium = await browser()
try {
  const page = await chromium.newPage({ deviceScaleFactor: 1 })
  const cache = new Map()
  const render = async (kind, size) => {
    const key = `${kind}@${size}`
    if (!cache.has(key)) cache.set(key, await png(page, svgs[kind], size))
    return cache.get(key)
  }
  const free = (size) => render(size <= SMALL ? "small" : "big", size)
  const mac = (size) => render(size <= SMALL ? "macSmall" : "mac", size)

  for (const size of LINUX) write(join(BUILD, "icons", `${size}x${size}.png`), await free(size))
  write(join(BUILD, "icon.png"), await free(1024))
  const win = []
  for (const size of WINDOWS) win.push([size, await free(size)])
  write(join(BUILD, "icon.ico"), ico(win))
  const apple = []
  for (const [type, size] of MAC) apple.push([type, await mac(size)])
  write(join(BUILD, "icon.icns"), icns(apple))
} finally {
  await chromium.close()
}
console.log(`Wrote ${written.length} files:\n  ${written.join("\n  ")}`)
