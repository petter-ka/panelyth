import type { Glyph } from "../features/format"

// Small, color-coded outline glyphs; keep the list legible without platform icons.
const PATHS: Record<Glyph | "up", string[]> = {
  up: ["M8 13V3M4.5 6.5 8 3l3.5 3.5"],
  folder: ["M2 4.5h4.3l1.4 1.6H14v7H2z"],
  image: ["M2 3h12v10H2z", "M3.5 11 6.4 7.5l2.1 2 1.3-1.4 2.7 2.9", "M11.1 5.5h.01"],
  video: ["M2 4h8v8H2z", "m10 6.2 4-2v7.6l-4-2z"],
  archive: ["M2.5 3h11v10h-11z", "M2.5 5.3h11", "M8 3v2.3m0 1.3v1.2m0 1.3v1.2"],
  text: ["M4 2h5l3 3v9H4z", "M9 2v3h3", "M6 8h4m-4 2.5h4"],
  program: ["M2 3h12v10H2z", "M2 5.5h12", "m4 7.5 2 1.5-2 1.5", "M8 10.5h2"],
  link: [
    "m6.5 10.5-1 1a2.1 2.1 0 0 1-3-3l2.2-2.2a2.1 2.1 0 0 1 3 0",
    "m9.5 5.5 1-1a2.1 2.1 0 0 1 3 3l-2.2 2.2a2.1 2.1 0 0 1-3 0",
    "m6 10 4-4",
  ],
  other: ["M4 2h5l3 3v9H4z", "M9 2v3h3"],
}

const COLORS: Record<Glyph, string> = {
  folder: "var(--label-yellow)",
  image: "var(--label-purple)",
  video: "var(--label-red)",
  archive: "var(--label-orange)",
  text: "var(--label-blue)",
  program: "var(--label-green)",
  link: "var(--label-gray)",
  other: "var(--text)",
}

export function TypeGlyph({
  glyph,
  muted = false,
  marked = false,
}: {
  glyph: Glyph | "up"
  muted?: boolean
  marked?: boolean
}) {
  const color = marked ? "var(--accent)" : glyph === "up" || muted ? "var(--muted)" : COLORS[glyph]

  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      data-glyph={glyph}
      style={{ color }}
    >
      {PATHS[glyph].map((path) => (
        <path key={path} d={path} />
      ))}
    </svg>
  )
}
