// Player icons (moved from the viewer, Stage C05): 16px grid, currentColor,
// 1.5 stroke, like the viewer's chrome icons.
import { Icon, type IconProps } from "@panelyth/ui"

export const PlayIcon = (p: IconProps) => (
  <Icon name="play" {...p}>
    <path d="M5 3.25v9.5L12.5 8 5 3.25Z" fill="currentColor" />
  </Icon>
)
export const PauseIcon = (p: IconProps) => (
  <Icon name="pause" {...p}>
    <path d="M4.75 3.5h2v9h-2zM9.25 3.5h2v9h-2z" fill="currentColor" strokeWidth="0" />
  </Icon>
)
export const VolumeIcon = (p: IconProps) => (
  <Icon name="volume" {...p}>
    <path d="M2.5 6.25h2.25L8 3.5v9L4.75 9.75H2.5v-3.5Z" />
    <path d="M10.5 6a3 3 0 0 1 0 4M12.25 4.25a5.5 5.5 0 0 1 0 7.5" />
  </Icon>
)
export const MuteIcon = (p: IconProps) => (
  <Icon name="mute" {...p}>
    <path d="M2.5 6.25h2.25L8 3.5v9L4.75 9.75H2.5v-3.5Z" />
    <path d="m10.5 6 3 4M13.5 6l-3 4" />
  </Icon>
)
export const RepeatIcon = (p: IconProps) => (
  <Icon name="repeat" {...p}>
    <path d="M3 7.5V7a2.5 2.5 0 0 1 2.5-2.5H12M10 2.5l2 2-2 2" />
    <path d="M13 8.5V9a2.5 2.5 0 0 1-2.5 2.5H4M6 9.5l-2 2 2 2" />
  </Icon>
)
export const FullscreenIcon = (p: IconProps) => (
  <Icon name="fullscreen" {...p}>
    <path d="M2.75 6V2.75H6M10 2.75h3.25V6M13.25 10v3.25H10M6 13.25H2.75V10" />
  </Icon>
)
export const ExitFullscreenIcon = (p: IconProps) => (
  <Icon name="exit-fullscreen" {...p}>
    <path d="M6 2.75V6H2.75M13.25 6H10V2.75M10 13.25V10h3.25M2.75 10H6v3.25" />
  </Icon>
)

/** The video glyph of tiles without a poster (24px grid). */
export function VideoGlyph({ size }: { size: number }) {
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
