import type { Glyph } from "../features/format"

// One 12 px outline glyph per entry type (UX-DESIGN "Rows"); no OS icons.
const PATHS: Record<Glyph | "up", string> = {
  up: "M6 9.5V3M3.5 5.5 6 3l2.5 2.5",
  folder: "M1.5 3.5v6h9v-5H5.5l-1-1z",
  image: "M1.5 2.5h9v7h-9zM2.5 8.5l2.5-3 2 2 1-1 1.5 2",
  video: "M1.5 3h6.5v6H1.5zM8 5.5l2.5-1.5v4L8 6.5",
  archive: "M2 2.5h8v7H2zM6 2.5v2M6 5.5v1M6 7.5v1",
  text: "M2.5 1.5h5l2 2v7h-7zM4 5.5h4M4 7.5h4",
  program: "M1.5 2.5h9v7h-9zM1.5 4.5h9M3 6.5l1.5 1L3 8.5",
  link: "M5 7l2-2M4.5 5.5 3.5 6.5a1.4 1.4 0 0 0 2 2l1-1M7.5 6.5l1-1a1.4 1.4 0 0 0-2-2l-1 1",
  other: "M2.5 1.5h5l2 2v7h-7z",
}

export function TypeGlyph({ glyph }: { glyph: Glyph | "up" }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      data-glyph={glyph}
    >
      <path d={PATHS[glyph]} />
    </svg>
  )
}
