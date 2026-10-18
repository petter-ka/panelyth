// Draws the app icon and writes every file made from it (`pnpm icons`).
//
// The mark: a sheet of paper with lines of text and an eye in the middle of it,
// circled by two comets, one neon green and one blue. The paper stands for the
// commander's files and the eye for the viewer; the comets are the two apps,
// which share one shell, folder and selection (ADR-0031). The sheet is tilted:
// the ring passes in front of its lower corner and behind its upper one, and a
// second sheet lies under it. The eye's catchlight is a window of two panes.
//
// In src/shared/desktop/build:
//   icon.svg        the mark: Windows, Linux and the window icon
//   icon-small.svg  the mark drawn again for 16 to 32 px: a thicker ring, one sheet, bold lines, a plain eye
//   icon-mac.svg    the mark on the macOS tile (the 824 px grid of Apple's template)
//   mark.svg        icon.svg cropped to the mark, for pages and documents
//   icon.png        1024 px, the window icon (src/shared/desktop/src/main/paths.ts)
//   icons/*.png     the Linux set
//   icon.ico        Windows, 16 to 256 px at the scales the shell asks for
//   icon.icns       macOS, 16 to 1024 px on the tile
// and showcase/src/media/mark.svg, the site's header and footer.
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
const frac = (n) => String(Math.round(n * 1000) / 1000)
const rad = (deg) => (deg * Math.PI) / 180
const polar = (r, deg, [cx, cy] = [C, C]) => [
  cx + r * Math.cos(rad(deg)),
  cy + r * Math.sin(rad(deg)),
]
const xy = ([x, y]) => `${num(x)} ${num(y)}`
/** `point` turned `deg` degrees round `centre`. */
const turn = ([x, y], [cx, cy], deg) => {
  const c = Math.cos(rad(deg))
  const s = Math.sin(rad(deg))
  return [cx + (x - cx) * c - (y - cy) * s, cy + (x - cx) * s + (y - cy) * c]
}
const indent = (lines) => lines.map((l) => `  ${l}`)
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

/** Head to tail: lime, neon green, spring green, teal, blue. */
const GREEN = [
  [0, "#f2ff7a"],
  [0.12, "#c6ff3a"],
  [0.32, "#5cff4a"],
  [0.54, "#1ef09a"],
  [0.77, "#13c8d8"],
  [1, "#1f7bff"],
]
/** Head to tail: ice, cyan, azure, blue, royal blue. */
const BLUE = [
  [0, "#b8fbff"],
  [0.12, "#4fe3ff"],
  [0.32, "#2aa8ff"],
  [0.54, "#2f6bff"],
  [0.77, "#3346e8"],
  [1, "#2a5cff"],
]

/**
 * A comet: a round head at `head` degrees (clockwise from three o'clock) moving
 * clockwise, and a body trailing `span` degrees behind it. Its outer edge
 * spirals in from radius `r0` to `r1` while it thins from `w0` to `w1`.
 */
function comet({ head, span, r0, r1, w0, w1, thin, spiral }) {
  const N = 160
  const outer = []
  const inner = []
  for (let i = 0; i <= N; i++) {
    const t = i / N
    const ro = r0 + (r1 - r0) * t ** spiral
    const w = w1 + (w0 - w1) * (1 - t) ** thin
    outer.push(polar(ro, head - span * t))
    inner.push(polar(ro - w, head - span * t))
  }
  // Half a circle from the outer edge to the inner one, ahead of the head or behind the tail.
  const cap = (deg, mid, r, ahead, from, to) => {
    const [cx, cy] = polar(mid, deg)
    const n = [Math.cos(rad(deg)), Math.sin(rad(deg))]
    const d = ahead ? 1 : -1
    const t = [-n[1] * d, n[0] * d]
    const out = []
    for (let i = 1; i < 24; i++) {
      const th = from + ((to - from) * i) / 24
      const u = Math.cos(th) * r
      const v = Math.sin(th) * r
      out.push([cx + n[0] * u + t[0] * v, cy + n[1] * u + t[1] * v])
    }
    return out
  }
  const tail = cap(head - span, r1 - w1 / 2, w1 / 2, false, 0, Math.PI)
  const nose = cap(head, r0 - w0 / 2, w0 / 2, true, Math.PI, 0)
  return `M${[...outer, ...tail, ...inner.reverse(), ...nose].map(xy).join("L")}Z`
}

/** The eye at `at`: dark blue glass, green and cyan coating reflections, a two-pane catchlight. */
function eye(p, at, r, small) {
  const [ex, ey] = at
  const circle = (rr, attributes) =>
    `<circle cx="${num(ex)}" cy="${num(ey)}" r="${num(rr)}" ${attributes}/>`
  const arc = (rr, a0, a1) =>
    `M${xy(polar(rr, a0, at))}A${num(rr)} ${num(rr)} 0 0 1 ${xy(polar(rr, a1, at))}`
  const defs = [
    radial(`${p}glass`, [ex - r * 0.35, ey - r * 0.4], r * 1.5, [
      [0, "#2f86ff"],
      [0.28, "#1146a8"],
      [0.62, "#06204e"],
      [1, "#020a1a"],
    ]),
    linear(
      `${p}rim`,
      [ex - r, ey - r],
      [ex + r, ey + r],
      [
        [0, "#ffffff", 0.9],
        [0.5, "#3fd0ff", 0.35],
        [1, "#5cff7a", 0.85],
      ],
    ),
  ]
  if (small) {
    // A pupil, a rim and one square catchlight: what still reads at 16 px.
    return {
      defs,
      body: [
        circle(r, `fill="url(#${p}glass)"`),
        circle(r * 0.42, `fill="#010812"`),
        circle(r * 0.95, `fill="none" stroke="url(#${p}rim)" stroke-width="${num(r * 0.1)}"`),
        `<rect x="${num(ex - r * 0.66)}" y="${num(ey - r * 0.66)}" width="${num(r * 0.34)}" height="${num(r * 0.34)}" rx="${num(r * 0.1)}" fill="#fff" fill-opacity=".9"/>`,
      ],
    }
  }
  defs.push(
    linear(
      `${p}pane`,
      [0, ey - r * 0.64],
      [0, ey - r * 0.26],
      [
        [0, "#ffffff"],
        [1, "#ffffff", 0.55],
      ],
    ),
    `<filter id="${p}soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${num(r * 0.07)}"/></filter>`,
    `<clipPath id="${p}clip">${circle(r, "")}</clipPath>`,
  )
  const pane = (x) =>
    `<rect x="${num(x)}" y="${num(ey - r * 0.64)}" width="${num(r * 0.19)}" height="${num(r * 0.34)}" rx="${num(r * 0.055)}"/>`
  return {
    defs,
    body: [
      circle(r, `fill="url(#${p}glass)"`),
      `<g clip-path="url(#${p}clip)" filter="url(#${p}soft)" fill="none" stroke-linecap="round">`,
      `  <path d="${arc(r * 0.8, 10, 80)}" stroke="#5cff7a" stroke-width="${num(r * 0.12)}" stroke-opacity=".7"/>`,
      `  <path d="${arc(r * 0.8, 190, 245)}" stroke="#38e0ff" stroke-width="${num(r * 0.1)}" stroke-opacity=".5"/>`,
      `</g>`,
      circle(
        r * 0.64,
        `fill="none" stroke="#6fb8ff" stroke-opacity=".3" stroke-width="${num(r * 0.022)}"`,
      ),
      circle(r * 0.36, `fill="#010812"`),
      circle(r * 0.975, `fill="none" stroke="url(#${p}rim)" stroke-width="${num(r * 0.05)}"`),
      `<g fill="url(#${p}pane)" transform="rotate(-22 ${num(ex - r * 0.4)} ${num(ey - r * 0.44)})">`,
      `  ${pane(ex - r * 0.63)}`,
      `  ${pane(ex - r * 0.4)}`,
      `</g>`,
      `<circle cx="${num(ex + r * 0.27)}" cy="${num(ey + r * 0.3)}" r="${num(r * 0.045)}" fill="#fff" fill-opacity=".6"/>`,
    ],
  }
}

/**
 * A sheet of paper turned `rot` degrees round its centre, with its top right
 * corner folded over. `text` lines run across it and part round a circle of
 * radius `gap` at `hole` (the eye, in the sheet's own unturned frame).
 */
function sheet(p, { x, y, w, h, rot, fold }, { text, hole = [0, 0], gap = 0, plain = false }) {
  const r = w * 0.07
  const f = w * fold
  const defs = [
    linear(
      `${p}sheet`,
      [x, y],
      [x + w, y + h],
      plain
        ? [
            [0, "#e4eefa"],
            [1, "#c3d8f0"],
          ]
        : [
            [0, "#ffffff"],
            [0.6, "#eef6ff"],
            [1, "#d9eaff"],
          ],
    ),
    linear(
      `${p}sheetEdge`,
      [x, y],
      [x, y + h],
      [
        [0, "#ffffff", 0.9],
        [1, "#8fb2dc", 0.7],
      ],
    ),
    linear(
      `${p}flap`,
      [x + w - f, y + f],
      [x + w - f / 2, y + f / 2],
      [
        [0, "#b9d4f5"],
        [1, "#f4f9ff"],
      ],
    ),
  ]
  const R = (a, b) => `${num(a)} ${num(b)}`
  const outline = [
    `M${R(x + r, y)}H${num(x + w - f)}L${R(x + w, y + f)}V${num(y + h - r)}`,
    `Q${R(x + w, y + h)} ${R(x + w - r, y + h)}H${num(x + r)}`,
    `Q${R(x, y + h)} ${R(x, y + h - r)}V${num(y + r)}Q${R(x, y)} ${R(x + r, y)}Z`,
  ].join("")
  const flap = `M${R(x + w - f, y)}V${num(y + f - r * 0.6)}Q${R(x + w - f, y + f)} ${R(x + w - f + r * 0.6, y + f)}H${num(x + w)}Z`
  const lines = []
  for (const { top, length, thick, color, opacity } of text) {
    const ly = y + h * top
    const t = h * thick
    const x0 = x + w * 0.14
    const x1 = x0 + w * 0.72 * length
    // A line that crosses the eye is split round it, as text flows round a picture.
    const dy = Math.max(Math.abs(ly + t / 2 - hole[1]) - t / 2, 0)
    const half = dy < gap ? Math.sqrt(gap * gap - dy * dy) : 0
    const parts = half
      ? [
          [x0, Math.min(x1, hole[0] - half)],
          [Math.max(x0, hole[0] + half), x1],
        ]
      : [[x0, x1]]
    for (const [a, b] of parts)
      if (b - a > t * 1.5)
        lines.push(
          `<rect x="${num(a)}" y="${num(ly)}" width="${num(b - a)}" height="${num(t)}" rx="${num(t / 2)}" fill="${color}" fill-opacity="${opacity}"/>`,
        )
  }
  const transform = `rotate(${rot} ${num(x + w / 2)} ${num(y + h / 2)})`
  return {
    defs,
    outline,
    transform,
    body: [
      `<g transform="${transform}">`,
      `  <path d="${outline}" fill="url(#${p}sheet)"/>`,
      `  <path d="${outline}" fill="none" stroke="url(#${p}sheetEdge)" stroke-width="${num(w * 0.008)}"/>`,
      ...indent(lines),
      `  <path d="${flap}" fill="url(#${p}flap)"/>`,
      `</g>`,
    ],
  }
}

/** Lines of text: a title, then body lines `step` apart (fractions of the sheet's height). */
function textLines({ first, step, count, title, body, lengths }, small) {
  return Array.from({ length: count }, (_, i) => ({
    top: first + i * step,
    length: lengths[i % lengths.length],
    thick: i === 0 ? title : body,
    color: i === 0 ? "#2a4a78" : small ? "#6a88b0" : "#7f98b8",
    opacity: i === 0 ? 0.85 : small ? 0.8 : 0.55,
  }))
}

/**
 * Each drawing: the comets round the canvas centre; the `sheet` (and the `under`
 * one); the eye in the middle of the sheet, `dy` below its centre; `size`, the
 * ring's diameter once fitted to the canvas; and `tile`, its diameter on the
 * macOS tile.
 */
const DRAWINGS = {
  big: {
    comet: { head: -38, span: 172, r0: 468, r1: 398, w0: 168, w1: 26, thin: 0.7, spiral: 1.4 },
    sheet: { x: 282, y: 212, w: 460, h: 600, rot: -10, fold: 0.22 },
    under: { x: 318, y: 190, w: 440, h: 580, rot: 4, fold: 0.22 },
    eye: { r: 146, dy: 0.04 },
    text: {
      first: 0.13,
      step: 0.068,
      count: 11,
      title: 0.044,
      body: 0.026,
      lengths: [0.55, 1, 0.92, 1, 0.84, 1, 0.96, 0.72, 1, 0.88, 0.6],
    },
    size: 944,
    tile: 690,
  },
  small: {
    comet: { head: -38, span: 168, r0: 500, r1: 470, w0: 200, w1: 96, thin: 0.9, spiral: 1.2 },
    sheet: { x: 300, y: 196, w: 424, h: 620, rot: -10, fold: 0.3 },
    eye: { r: 120, dy: 0.06 },
    text: { first: 0.12, step: 0.11, count: 8, title: 0.055, body: 0.055, lengths: [0.62, 1] },
    size: 1000,
    tile: 800,
  },
}

/** The mark's defs and body; `p` prefixes its ids. */
function mark(small, p = "") {
  const d = small ? DRAWINGS.small : DRAWINGS.big
  const green = d.comet
  const blue = { ...green, head: green.head + 180 }
  const head = (c) => polar(c.r0 - c.w0 / 2, c.head)
  const tail = (c) => polar(c.r1, c.head - c.span)
  const innermost = Math.min(green.r0 - green.w0, green.r1 - green.w1)
  const defs = [
    linear(`${p}green`, head(green), tail(green), GREEN),
    linear(`${p}blue`, head(blue), tail(blue), BLUE),
    // Shading across each comet: darker on the inner edge, a lit outer rim.
    radial(`${p}tube`, [C, C], green.r0, [
      [frac(innermost / green.r0), "#031a38", 0.38],
      [frac((innermost + (green.r0 - innermost) * 0.55) / green.r0), "#031a38", 0],
      [0.93, "#ffffff", 0],
      [1, "#ffffff", 0.3],
    ]),
  ]
  const outlines = []
  const ring = []
  for (const [c, name, light] of [
    [green, "green", "#f6ffd0"],
    [blue, "blue", "#e6fdff"],
  ]) {
    const outline = comet(c)
    outlines.push(outline)
    ring.push(`<path d="${outline}" fill="url(#${p}${name})"/>`)
    if (!small) {
      defs.push(
        radial(`${p}${name}Head`, head(c), c.w0 * 0.55, [
          [0, light, 0.7],
          [1, light, 0],
        ]),
      )
      ring.push(`<path d="${outline}" fill="url(#${p}${name}Head)"/>`)
    }
    ring.push(`<path d="${outline}" fill="url(#${p}tube)"/>`)
  }

  const { x, y, w, h, rot } = d.sheet
  const hole = [x + w / 2, y + h / 2 + h * d.eye.dy]
  const S = sheet(p, d.sheet, { text: textLines(d.text, small), hole, gap: d.eye.r * 1.18 })
  const U = d.under && sheet(`${p}under-`, d.under, { text: [], plain: true })
  const E = eye(p, turn(hole, [x + w / 2, y + h / 2], rot), d.eye.r, small)
  defs.push(...S.defs, ...(U ? U.defs : []), ...E.defs)
  // Like a planet's ring, the ring runs in front of the sheets' lower half and
  // behind the upper half; it crosses over beside the sheets, clear of them. It is
  // drawn once, under the sheets, and the sheets are cut away where it is in front.
  const lowerRing = (fill) => [
    `<g clip-path="url(#${p}lowerHalf)" fill="${fill}">`,
    ...outlines.map((o) => `  <path d="${o}"/>`),
    `</g>`,
  ]
  defs.push(
    `<clipPath id="${p}lowerHalf"><rect y="${C}" width="1024" height="${C}"/></clipPath>`,
    [
      `<mask id="${p}inFront" maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">`,
      `<rect width="1024" height="1024" fill="#fff"/>`,
      ...lowerRing("#000"),
      `</mask>`,
    ].join(""),
  )
  const sheets = [...(U ? U.body : []), ...S.body]
  const body = [...ring, `<g mask="url(#${p}inFront)">`]
  if (small) body.push(...indent(sheets))
  else {
    // The sheets' shadow on the ring behind them, and the ring's on the paper in front.
    const onSheets = [S, ...(U ? [U] : [])].map(
      (s) => `<path d="${s.outline}" transform="${s.transform}"/>`,
    )
    defs.push(
      `<filter id="${p}lift" x="-20%" y="-15%" width="140%" height="140%"><feDropShadow dy="${num(h * 0.025)}" stdDeviation="${num(h * 0.03)}" flood-color="#021026" flood-opacity=".45"/></filter>`,
      `<filter id="${p}soften" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="10"/></filter>`,
      `<clipPath id="${p}onSheets">${onSheets.join("")}</clipPath>`,
    )
    body.push(
      `  <g filter="url(#${p}lift)">`,
      ...indent(indent(sheets)),
      `  </g>`,
      `  <g clip-path="url(#${p}onSheets)">`,
      `    <g transform="translate(0 8)" filter="url(#${p}soften)" opacity=".35">`,
      ...indent(indent(indent(lowerRing("#021026")))),
      `    </g>`,
      `  </g>`,
    )
  }
  body.push(`</g>`, ...E.body)
  const k = d.size / (2 * green.r0)
  return {
    defs,
    body: [
      `<g transform="translate(${C} ${C}) scale(${frac(k)}) translate(-${C} -${C})">`,
      ...indent(body),
      `</g>`,
    ],
  }
}

const NOTE = "<!-- Drawn by scripts/icons.mjs (pnpm icons): change the script, not this file. -->"
const doc = ({ defs, body }, { viewBox = "0 0 1024 1024", size = 1024, title } = {}) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">`,
    ...(title ? [`  <title>${title}</title>`] : []),
    `  ${NOTE}`,
    `  <defs>`,
    ...defs.map((l) => `    ${l}`),
    `  </defs>`,
    ...indent(body),
    `</svg>`,
    ``,
  ].join("\n")

/** The mark on the macOS tile: 824 px with a 100 px margin, corner radius 184. */
function macTile(small) {
  const m = mark(small, "m-")
  const d = small ? DRAWINGS.small : DRAWINGS.big
  return {
    defs: [
      linear(
        "tile",
        [512, 100],
        [512, 924],
        [
          [0, "#0f3157"],
          [0.55, "#081a33"],
          [1, "#030b17"],
        ],
      ),
      linear(
        "edge",
        [512, 100],
        [512, 924],
        [
          [0, "#ffffff", 0.22],
          [0.5, "#ffffff", 0.04],
          [1, "#ffffff", 0.1],
        ],
      ),
      `<filter id="lift" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dy="12" stdDeviation="12" flood-color="#000" flood-opacity=".3"/></filter>`,
      ...m.defs,
    ],
    body: [
      `<rect x="100" y="100" width="824" height="824" rx="184" fill="url(#tile)" filter="url(#lift)"/>`,
      `<g transform="translate(512 512) scale(${frac(d.tile / d.size)}) translate(-512 -512)">`,
      ...indent(m.body),
      `</g>`,
      `<rect x="102" y="102" width="820" height="820" rx="182" fill="none" stroke="url(#edge)" stroke-width="4"/>`,
    ],
  }
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
// Cropped to the ring, whose diameter is `size`.
const crop = ({ size }) => `${C - size / 2 - 4} ${C - size / 2 - 4} ${size + 8} ${size + 8}`
write(
  join(BUILD, "mark.svg"),
  doc(mark(false), { viewBox: crop(DRAWINGS.big), size: 96, title: "Panelyth" }),
)
write(
  SHOWCASE_MARK,
  doc(mark(true), { viewBox: crop(DRAWINGS.small), size: 96, title: "Panelyth" }),
)

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
