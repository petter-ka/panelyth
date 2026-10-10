import type { ReactNode } from "react"

// Filled, color type icons in the macOS style, shared by both apps. Drawn for
// a 16 px box; they scale for the viewer's tiles. The shapes live once in a
// sprite (GlyphSprite, mounted by each app's shell); a row or tile only holds
// a <use>, so thousands of them share the shapes.

export type GlyphName =
  | "folder"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "archive"
  | "text"
  | "program"
  | "link"
  | "other"
  // Places (the viewer's sidebar)
  | "drive"
  | "home"
  | "bookmark"
  | "recent"

const PAGE = "M4 1.5h5.4L13 5.1v8.4a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z"
const PAGE_FOLD = "M9.4 1.5v2.6a1 1 0 0 0 1 1H13z"

/** A sheet of paper with a folded corner; the document icons draw on it. */
const page = (
  <>
    <path d={PAGE} fill="url(#glyph-fill-paper)" stroke="#aeb4bf" strokeWidth=".5" />
    <path d={PAGE_FOLD} fill="#d5d9e0" />
  </>
)

const SYMBOLS: Record<GlyphName, ReactNode> = {
  folder: (
    <>
      <path
        d="M1.5 4.3a1.3 1.3 0 0 1 1.3-1.3h3a1.3 1.3 0 0 1 .9.4l.9.9h5.6a1.3 1.3 0 0 1 1.3 1.3v6.6a1.3 1.3 0 0 1-1.3 1.3H2.8a1.3 1.3 0 0 1-1.3-1.3z"
        fill="url(#glyph-fill-folder-back)"
      />
      <rect x="1.5" y="5.9" width="13" height="7.6" rx="1.3" fill="url(#glyph-fill-folder-front)" />
      <path d="M2.4 6.4h11.2" stroke="#fff" strokeOpacity=".45" strokeWidth=".5" />
    </>
  ),
  image: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.8" fill="#fff" />
      <rect x="2.6" y="3.6" width="10.8" height="8.8" rx=".7" fill="url(#glyph-fill-sky)" />
      <circle cx="10.7" cy="6" r="1.15" fill="#ffd60a" />
      <path d="M2.6 11.3 6 7.7l2.3 2.4 1.6-1.5 3.5 3.4v.4H2.6z" fill="#30b455" />
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.8"
        fill="none"
        stroke="#aeb4bf"
        strokeWidth=".5"
      />
    </>
  ),
  video: (
    <>
      <rect x="1.5" y="2.5" width="13" height="11" rx="2.2" fill="url(#glyph-fill-video)" />
      <path
        d="M2.6 4.3h1v1h-1zm0 3.2h1v1h-1zm0 3.2h1v1h-1zm9.8-6.4h1v1h-1zm0 3.2h1v1h-1zm0 3.2h1v1h-1z"
        fill="#fff"
        fillOpacity=".55"
      />
      <path d="M6.6 5.5v5l4.2-2.5z" fill="#fff" />
    </>
  ),
  audio: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="url(#glyph-fill-audio)" />
      <path
        d="M6.6 4.6 11 3.7v6a1.5 1.3 0 1 1-.9-1.2V5.5l-2.6.5v4.7a1.5 1.3 0 1 1-.9-1.2z"
        fill="#fff"
      />
    </>
  ),
  pdf: (
    <>
      {page}
      <rect x="1.5" y="8" width="10" height="4.6" rx="1" fill="#ff3b30" />
      <path
        d="M3 11.6V9h.9a.8.8 0 0 1 0 1.6H3m2.6 1V9h.6a1.3 1.3 0 0 1 0 2.6zm2.9 0V9H10m-1.5 1.3h1.2"
        fill="none"
        stroke="#fff"
        strokeWidth=".6"
      />
    </>
  ),
  text: (
    <>
      {page}
      <path d="M5 7.2h6M5 9.2h6M5 11.2h4" stroke="#6b7480" strokeWidth=".9" strokeLinecap="round" />
    </>
  ),
  archive: (
    <>
      <rect x="2.5" y="1.5" width="11" height="13" rx="1.6" fill="url(#glyph-fill-archive)" />
      <path d="M7.4 1.5h1.2v1.3H7.4zm0 2.6h1.2v1.3H7.4zm0 2.6h1.2V8H7.4z" fill="#5b4420" />
      <rect x="6.6" y="8.6" width="2.8" height="3.2" rx=".6" fill="#f5efe2" stroke="#5b4420" />
    </>
  ),
  program: (
    <>
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="url(#glyph-fill-program)" />
      <path
        d="m4.3 5.8 2.5 2.1-2.5 2.1M8 10.4h3.4"
        fill="none"
        stroke="#32d74b"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  link: (
    <>
      {page}
      <rect x="1.5" y="8.5" width="6" height="6" rx="1.4" fill="#0a84ff" />
      <path
        d="M3.2 12.8c.2-1.4 1-2.2 2.3-2.3M4.3 10.2l1.4.3-.4 1.3"
        fill="none"
        stroke="#fff"
        strokeWidth=".8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
  other: page,
  drive: (
    <>
      <rect
        x="1.5"
        y="4"
        width="13"
        height="8.5"
        rx="2"
        fill="url(#glyph-fill-drive)"
        stroke="#8e949e"
        strokeWidth=".5"
      />
      <path d="M1.8 9.4h12.4" stroke="#8e949e" strokeWidth=".5" />
      <circle cx="12.2" cy="10.9" r=".75" fill="#32d74b" />
      <path d="M3.4 10.9h4.2" stroke="#8e949e" strokeWidth=".8" strokeLinecap="round" />
    </>
  ),
  home: (
    <>
      <rect
        x="3.2"
        y="7"
        width="9.6"
        height="7"
        rx=".9"
        fill="url(#glyph-fill-paper)"
        stroke="#aeb4bf"
        strokeWidth=".5"
      />
      <rect x="6.8" y="9.8" width="2.4" height="4.2" rx=".4" fill="#0a84ff" />
      <path
        d="M7.3 2.1a1 1 0 0 1 1.4 0l5.9 5.4a.6.6 0 0 1-.4 1H1.8a.6.6 0 0 1-.4-1z"
        fill="url(#glyph-fill-roof)"
      />
    </>
  ),
  bookmark: (
    <path
      d="M7.5 1.9a.55.55 0 0 1 1 0l1.6 3.3 3.6.5a.55.55 0 0 1 .3 1l-2.6 2.5.6 3.6a.55.55 0 0 1-.8.6L8 11.7l-3.2 1.7a.55.55 0 0 1-.8-.6l.6-3.6L2 6.7a.55.55 0 0 1 .3-1l3.6-.5z"
      fill="url(#glyph-fill-star)"
      stroke="#d98a00"
      strokeWidth=".4"
    />
  ),
  recent: (
    <>
      <circle cx="8" cy="8" r="6.3" fill="url(#glyph-fill-recent)" />
      <circle cx="8" cy="8" r="4.9" fill="#fff" />
      <path
        d="M8 5v3.1l2 1.3"
        fill="none"
        stroke="#1c1c1e"
        strokeWidth="1.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  ),
}

const stops = (from: string, to: string): ReactNode => (
  <>
    <stop offset="0" stopColor={from} />
    <stop offset="1" stopColor={to} />
  </>
)

const GRADIENTS: Record<string, [string, string]> = {
  "glyph-fill-paper": ["#ffffff", "#eceef2"],
  "glyph-fill-folder-back": ["#3aa0f5", "#1b7fe0"],
  "glyph-fill-folder-front": ["#7dccff", "#2f9df4"],
  "glyph-fill-sky": ["#4fb4ff", "#b8e3ff"],
  "glyph-fill-video": ["#7d7aff", "#3f3cc4"],
  "glyph-fill-audio": ["#ff6482", "#f02d55"],
  "glyph-fill-archive": ["#e6c48a", "#c2965a"],
  "glyph-fill-program": ["#55565c", "#1c1c1e"],
  "glyph-fill-drive": ["#f4f5f7", "#c6cad1"],
  "glyph-fill-roof": ["#ffb340", "#ff8a00"],
  "glyph-fill-star": ["#ffe14d", "#ffb300"],
  "glyph-fill-recent": ["#5ac8fa", "#0a84ff"],
}

/** The icon shapes, once per window. Not `display: none`: that would drop the gradients. */
export function GlyphSprite() {
  return (
    <svg aria-hidden="true" width="0" height="0" className="absolute">
      <defs>
        {Object.entries(GRADIENTS).map(([id, [from, to]]) => (
          <linearGradient key={id} id={id} x1="0" y1="0" x2="0" y2="1">
            {stops(from, to)}
          </linearGradient>
        ))}
      </defs>
      {(Object.keys(SYMBOLS) as GlyphName[]).map((glyph) => (
        <symbol key={glyph} id={`glyph-${glyph}`} viewBox="0 0 16 16">
          {SYMBOLS[glyph]}
        </symbol>
      ))}
    </svg>
  )
}

interface TypeGlyphProps {
  glyph: GlyphName | "up"
  size?: number
  /** Hidden and system entries show the icon faded. */
  muted?: boolean
}

export function TypeGlyph({ glyph, size = 16, muted = false }: TypeGlyphProps) {
  if (glyph === "up")
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        className="shrink-0 text-muted"
        data-glyph="up"
      >
        <path d="M8 13V3M4.5 6.5 8 3l3.5 3.5" />
      </svg>
    )
  return (
    <svg
      width={size}
      height={size}
      aria-hidden="true"
      className={muted ? "shrink-0 opacity-50" : "shrink-0"}
      data-glyph={glyph}
    >
      <use href={`#glyph-${glyph}`} />
    </svg>
  )
}
