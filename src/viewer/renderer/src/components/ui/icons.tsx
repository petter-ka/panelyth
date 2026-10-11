// Line icons for chrome controls: 16px grid, currentColor, 1.5 stroke. These are
// the built-in default set; the shared Icon swaps in the library chosen in
// Settings → Appearance (src/shared/ui).
import { Icon, type IconProps } from "@panelyth/ui"

// The player icons live with the shared VideoPlayer (Stage C05).
export {
  ExitFullscreenIcon,
  FullscreenIcon,
  MuteIcon,
  PauseIcon,
  PlayIcon,
  VolumeIcon,
} from "@panelyth/media-ui"

export const ArrowLeftIcon = (p: IconProps) => (
  <Icon name="arrow-left" {...p}>
    <path d="M13 8H3M7 4 3 8l4 4" />
  </Icon>
)
export const ArrowRightIcon = (p: IconProps) => (
  <Icon name="arrow-right" {...p}>
    <path d="M3 8h10M9 4l4 4-4 4" />
  </Icon>
)
export const ArrowUpIcon = (p: IconProps) => (
  <Icon name="arrow-up" {...p}>
    <path d="M8 13V3M4 7l4-4 4 4" />
  </Icon>
)
export const RefreshIcon = (p: IconProps) => (
  <Icon name="refresh" {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />
  </Icon>
)
export const SearchIcon = (p: IconProps) => (
  <Icon name="search" {...p}>
    <circle cx="7" cy="7" r="4.25" />
    <path d="m10.2 10.2 3.3 3.3" />
  </Icon>
)
export const CloseIcon = (p: IconProps) => (
  <Icon name="close" {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
)
export const SettingsIcon = (p: IconProps) => (
  <Icon name="settings" {...p}>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.8v1.1M8 13.1v1.1M1.8 8h1.1M13.1 8h1.1M3.6 3.6l.8.8m7.2 7.2.8.8m0-8.8-.8.8m-7.2 7.2-.8.8" />
    <circle cx="8" cy="8" r="5.5" />
  </Icon>
)
export const ChevronRightIcon = (p: IconProps) => (
  <Icon name="chevron-right" {...p}>
    <path d="m6 3.5 4.5 4.5L6 12.5" />
  </Icon>
)
export const ChevronDownIcon = (p: IconProps) => (
  <Icon name="chevron-down" {...p}>
    <path d="M3.5 6 8 10.5 12.5 6" />
  </Icon>
)
export const CheckIcon = (p: IconProps) => (
  <Icon name="check" {...p}>
    <path d="m3.5 8.5 3 3 6-7" />
  </Icon>
)
export const SortIcon = (p: IconProps) => (
  <Icon name="sort" {...p}>
    <path d="M5 3v10M2.5 10.5 5 13l2.5-2.5M11 13V3M8.5 5.5 11 3l2.5 2.5" />
  </Icon>
)
export const FilterIcon = (p: IconProps) => (
  <Icon name="filter" {...p}>
    <path d="M2.5 3.5h11L9.25 8.5v4L6.75 11V8.5L2.5 3.5Z" />
  </Icon>
)
export const PanelLeftIcon = (p: IconProps) => (
  <Icon name="panel-left" {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.25" />
    <path d="M6 3v10" />
  </Icon>
)
export const PanelBottomLeftIcon = (p: IconProps) => (
  <Icon name="panel-bottom-left" {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.25" />
    <path d="M6.5 3v10M2 8.5h4.5" />
  </Icon>
)
export const PanelRightIcon = (p: IconProps) => (
  <Icon name="panel-right" {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.25" />
    <path d="M10 3v10" />
  </Icon>
)
// Media controls (Stage 06). Play/pause are filled: they read as the
// primary control at 16 px.
export const HeartIcon = (p: IconProps) => (
  <Icon name="heart" {...p}>
    <path d="M8 13.25S2.5 10.1 2.5 6.2A2.7 2.7 0 0 1 8 4.9a2.7 2.7 0 0 1 5.5 1.3c0 3.9-5.5 7.05-5.5 7.05Z" />
  </Icon>
)
export const TrashIcon = (p: IconProps) => (
  <Icon name="trash" {...p}>
    <path d="M2.75 4.25h10.5M6.25 4.25V2.75h3.5v1.5M4 4.25l.6 9h6.8l.6-9M6.75 7v3.75M9.25 7v3.75" />
  </Icon>
)
export const CopyIcon = (p: IconProps) => (
  <Icon name="copy" {...p}>
    <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
    <path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" />
  </Icon>
)
export const MoveIcon = (p: IconProps) => (
  <Icon name="move" {...p}>
    <path d="M2.75 12.25v-8.5h3.5l1.5 1.5h5.5v7Z" />
    <path d="M6.5 9h4M9 7.5 10.5 9 9 10.5" />
  </Icon>
)
export const TagIcon = (p: IconProps) => (
  <Icon name="tag" {...p}>
    <path d="M2.75 2.75h5l5.5 5.5-5 5-5.5-5.5Z" />
    <path d="M5.5 5.5h.01" />
  </Icon>
)
export const PencilIcon = (p: IconProps) => (
  <Icon name="pencil" {...p}>
    <path d="m10.25 2.75 3 3-7.5 7.5h-3v-3Z" />
  </Icon>
)
export const RotateCwIcon = (p: IconProps) => (
  <Icon name="rotate-cw" {...p}>
    <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5V5h-2.5" />
  </Icon>
)
export const RotateCcwIcon = (p: IconProps) => (
  <Icon name="rotate-ccw" {...p}>
    <path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5V5h2.5" />
  </Icon>
)
export const FlipIcon = (p: IconProps) => (
  <Icon name="flip" {...p}>
    <path d="M8 2v12M6 4 2.5 12H6ZM10 4l3.5 8H10Z" />
  </Icon>
)
export const KeyboardIcon = (p: IconProps) => (
  <Icon name="keyboard" {...p}>
    <rect x="1.5" y="4" width="13" height="8" rx="1.5" />
    <path d="M4 6.5h.01M6.5 6.5h.01M9 6.5h.01M11.5 6.5h.01M5 9.5h6" />
  </Icon>
)
