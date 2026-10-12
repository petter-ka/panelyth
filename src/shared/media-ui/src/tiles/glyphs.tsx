import { TypeGlyph } from "@panelyth/ui"

// Glyphs for tiles without a thumbnail. Folders and videos use the shared
// color type icons (src/shared/ui, the commander's rows show the same ones).

interface GlyphProps {
  size: number
}

export const FolderGlyph = ({ size }: GlyphProps) => <TypeGlyph glyph="folder" size={size} />

export const VideoTileGlyph = ({ size }: GlyphProps) => <TypeGlyph glyph="video" size={size} />

export function UnavailableGlyph({ size }: GlyphProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.25" />
      <path d="M5 17 19 7" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}
