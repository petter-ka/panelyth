// Minimal line glyphs for tiles without a thumbnail. currentColor, no fills
// that would compete with photos on the canvas.

interface GlyphProps {
  size: number
}

export function FolderGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4.2l2 2h8.8A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function VideoGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path
        d="M10 9.2v5.6l4.8-2.8L10 9.2Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function UnavailableGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 17 19 7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
