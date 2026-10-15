import { Icon, type IconName } from "@panelyth/ui"
import { GLYPHS, LIBRARY, type GlyphName } from "./actionGlyphs"

type CommanderActionIconName =
  | GlyphName
  | "view"
  | "preview"
  | "edit"
  | "copy"
  | "move"
  | "mkdir"
  | "delete"
  | "search"
  | "filter"
  | "branch"
  | "refresh"
  | "star"
  | "compare"
  | "sync"
  // Stage C10: user commands, the command line, the Thumbnails view, the hidden-files toggle.
  | "tool"
  | "terminal"
  | "play"
  | "tiles"
  | "keys"

const ICON_NAMES: Record<CommanderActionIconName, IconName> = {
  ...LIBRARY,
  view: "eye",
  preview: "preview",
  edit: "pencil",
  copy: "copy",
  move: "move",
  mkdir: "mkdir",
  delete: "trash",
  search: "search",
  filter: "filter",
  branch: "branch",
  refresh: "refresh",
  star: "star",
  compare: "flip",
  sync: "sort",
  // The other icon libraries have no drawing of their own for these.
  tool: "settings",
  terminal: "keyboard",
  play: "play",
  tiles: "preview",
  keys: "keyboard",
}

/** Small, consistent line icons for commander actions. */
export function CommanderActionIcon({
  name,
  className,
}: {
  name: CommanderActionIconName
  className?: string
}) {
  return (
    <Icon name={ICON_NAMES[name]} className={className}>
      {name === "view" && (
        <>
          <path d="M1.75 8s2.25-4 6.25-4 6.25 4 6.25 4-2.25 4-6.25 4-6.25-4-6.25-4Z" />
          <circle cx="8" cy="8" r="1.75" />
        </>
      )}
      {name === "preview" && (
        <>
          <rect x="2" y="2.5" width="12" height="11" rx="1.25" />
          <path d="M7 2.75v10.5M8.5 8s.75-1.4 2.25-1.4S13 8 13 8s-.75 1.4-2.25 1.4S8.5 8 8.5 8Z" />
          <circle cx="10.75" cy="8" r=".35" />
        </>
      )}
      {name === "edit" && (
        <>
          <path d="m9.75 2.5 3.75 3.75-7.75 7.5H2v-3.75L9.75 2.5Z" />
          <path d="m8.5 3.75 3.75 3.75M2 13.75l3.75-.75" />
        </>
      )}
      {name === "copy" && (
        <>
          <rect x="5.25" y="5.25" width="8.25" height="8.25" rx="1.25" />
          <path d="M10.75 5.25v-1.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h1.5" />
        </>
      )}
      {name === "move" && (
        <>
          <path d="M2 4.25c0-.41.34-.75.75-.75h3.1l1.4 1.5h6c.41 0 .75.34.75.75v5.5c0 .41-.34.75-.75.75H2.75a.75.75 0 0 1-.75-.75v-7Z" />
          <path d="M5.5 8.5h5m-2-2 2 2-2 2" />
        </>
      )}
      {name === "mkdir" && (
        <>
          <path d="M1.75 4.25c0-.41.34-.75.75-.75h3.1L7 5h5.5c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75h-10a.75.75 0 0 1-.75-.75v-7.5Z" />
          <path d="M8 7.5v3m-1.5-1.5h3" />
        </>
      )}
      {name === "delete" && (
        <>
          <path d="M2.5 4.25h11m-7.75 0V2.75h4.5v1.5m-6.5 0 .6 9h5.8l.6-9" />
          <path d="M6.5 7v3.75M9.5 7v3.75" />
        </>
      )}
      {name === "search" && (
        <>
          <circle cx="7" cy="7" r="4.25" />
          <path d="m10.2 10.2 3.3 3.3" />
        </>
      )}
      {name === "filter" && <path d="M2 3h12L9.25 8.25v4.25l-2.5 1.5V8.25L2 3Z" />}
      {name === "branch" && (
        <>
          <path d="M4 3v10m0-7h3m-3 4h3" />
          <circle cx="10.5" cy="6" r="1.5" />
          <circle cx="10.5" cy="10" r="1.5" />
        </>
      )}
      {name === "refresh" && <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />}
      {name === "compare" && (
        <>
          <rect x="1.75" y="3" width="4.75" height="10" rx="1" />
          <rect x="9.5" y="3" width="4.75" height="10" rx="1" />
          <path d="M3.5 6h1.25M3.5 8.5h1.25M11.25 6h1.25M11.25 10.5h1.25" />
        </>
      )}
      {name === "sync" && (
        <>
          <path d="M2.5 5.5h10m-2.5-2.5 2.5 2.5-2.5 2.5" />
          <path d="M13.5 10.5h-10m2.5-2.5-2.5 2.5 2.5 2.5" />
        </>
      )}
      {/* A wrench: the user's own commands (it was a sun-like gear before). */}
      {name === "tool" && (
        <path d="M10.75 2.25a3 3 0 0 0-2.85 3.95L2.6 11.5a1.35 1.35 0 0 0 1.9 1.9l5.3-5.3a3 3 0 0 0 3.95-2.85l-1.65 1.15-1.55-.4-.4-1.55 1.15-1.65a3 3 0 0 0-.55-.05Z" />
      )}
      {name in GLYPHS && GLYPHS[name as GlyphName]}
      {name === "terminal" && (
        <>
          <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
          <path d="m4.5 6 2 2-2 2M8.5 10h3" />
        </>
      )}
      {name === "play" && <path d="M5 3.25v9.5L12.5 8 5 3.25Z" />}
      {name === "tiles" && (
        <>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </>
      )}
      {name === "keys" && (
        <>
          <rect x="1.5" y="4" width="13" height="8" rx="1.25" />
          <path d="M4 6.75h.5M7 6.75h.5M10 6.75h.5M4.5 9.5h7" />
        </>
      )}
      {name === "star" && (
        <path d="m8 2 1.8 3.7 4.1.6-3 2.9.7 4.1L8 11.4l-3.6 1.9.7-4.1-3-2.9 4.1-.6L8 2Z" />
      )}
    </Icon>
  )
}

export type { CommanderActionIconName }
