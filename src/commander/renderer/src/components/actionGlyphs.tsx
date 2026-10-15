import type { IconName } from "@panelyth/ui"
import type { ReactNode } from "react"

// More commander action icons: every action that can go on the toolbar has
// one (none falls back to the general "tool" one). Drawn like the others on a
// 16 px grid with a 1.5 stroke for the built-in set; the selectable icon
// libraries show the closest icon they have (LIBRARY).

/** A tab, its upper left corner raised; the tab icons add a mark on the right. */
const tab = <path d="M2 13V4.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1V6h5a1 1 0 0 1 1 1v6M1.5 13h13" />
const doc = (
  <path d="M9 1.75H4a.75.75 0 0 0-.75.75v11c0 .41.34.75.75.75h8c.41 0 .75-.34.75-.75V5.5L9 1.75ZM9 1.75V5.5h3.75" />
)
const box = <rect x="2.25" y="2.25" width="11.5" height="11.5" rx="1.5" />
const frame = <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
const crate = (
  <>
    <rect x="1.75" y="2.5" width="12.5" height="3.25" rx=".75" />
    <path d="M2.75 5.75v7a.75.75 0 0 0 .75.75h9a.75.75 0 0 0 .75-.75v-7" />
  </>
)

export const GLYPHS = {
  switchApp: (
    <>
      <rect x="1.75" y="1.75" width="7.5" height="7.5" rx="1.25" />
      <path d="M11.5 6.75h1.5a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H7.75a1 1 0 0 1-1-1v-1.5" />
    </>
  ),
  panelOther: (
    <>
      {frame}
      <path d="M8 2.75v3M8 10.25v3M4 8h8m-2-2 2 2-2 2" />
    </>
  ),
  queue: <path d="M2.5 4h8M2.5 8h11M2.5 12h5M11 11.25l1.25 1.25L14.5 10" />,
  up: (
    <>
      <path d="M1.75 4.25c0-.41.34-.75.75-.75h3.1L7 5h5.5c.41 0 .75.34.75.75v6c0 .41-.34.75-.75.75h-10a.75.75 0 0 1-.75-.75v-7.5Z" />
      <path d="M8 11V7.5M6.5 9 8 7.5 9.5 9" />
    </>
  ),
  root: <path d="M3 2.75h10M8 13.25V5.5m-3 3L8 5.5l3 3" />,
  back: <path d="M13 8H3.5M7 4 3 8l4 4" />,
  forward: <path d="M3 8h9.5M9 4l4 4-4 4" />,
  openLeft: (
    <>
      {frame}
      <path d="M8 2.75v10.5M13 8H9.75m1.5-1.5L9.75 8l1.5 1.5" />
    </>
  ),
  openRight: (
    <>
      {frame}
      <path d="M8 2.75v10.5M3 8h3.25m-1.5-1.5L6.25 8l-1.5 1.5" />
    </>
  ),
  swap: <path d="M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13" />,
  pathEdit: (
    <>
      <rect x="1.5" y="4.25" width="13" height="7.5" rx="1.25" />
      <path d="M5 6v4M4 6h2M4 10h2M8 8h4" />
    </>
  ),
  history: <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.8M2.5 2.25V4.5h2.25M8 5.25V8l2 1.25" />,
  drive: (
    <>
      <rect x="1.75" y="4.5" width="12.5" height="7" rx="1.5" />
      <path d="M4.25 8h4M11.25 8h.5" />
    </>
  ),
  tabAdd: (
    <>
      {tab}
      <path d="M11 8.5v3M9.5 10h3" />
    </>
  ),
  tabClose: (
    <>
      {tab}
      <path d="m9.75 8.75 2.5 2.5m0-2.5-2.5 2.5" />
    </>
  ),
  tabNext: (
    <>
      {tab}
      <path d="M9.25 10h3.25m-1.25-1.25L12.5 10l-1.25 1.25" />
    </>
  ),
  tabPrev: (
    <>
      {tab}
      <path d="M12.5 10H9.25m1.25-1.25L9.25 10l1.25 1.25" />
    </>
  ),
  tabCloseOthers: (
    <>
      {tab}
      <path d="m8.75 9 1.75 1.75m0-1.75-1.75 1.75M11.5 9l1.75 1.75m0-1.75-1.75 1.75" />
    </>
  ),
  tabReopen: (
    <>
      {tab}
      <path d="M12.75 10.25a1.75 1.75 0 1 1-.5-1.25M12.4 8.15v.95h-.95" />
    </>
  ),
  tabCloseRight: (
    <>
      {tab}
      <path d="M8.75 10h2.5m-1-1 1 1-1 1M12.75 8.5v3" />
    </>
  ),
  tabSets: (
    <>
      {tab}
      <path d="M4 1.75h3.5" />
    </>
  ),
  save: (
    <path d="M2.5 3.25a.75.75 0 0 1 .75-.75h7.5l2.75 2.75v7.5a.75.75 0 0 1-.75.75H3.25a.75.75 0 0 1-.75-.75v-9.5ZM5 2.5v3h5v-3M5 13.5V9.5h6v4" />
  ),
  lock: (
    <>
      <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.25" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  newFile: (
    <>
      {doc}
      <path d="M8 7.5v4M6 9.5h4" />
    </>
  ),
  cut: (
    <>
      <circle cx="4.5" cy="11.5" r="1.75" />
      <circle cx="11.5" cy="11.5" r="1.75" />
      <path d="M5.6 10.1 12 2.5M10.4 10.1 4 2.5" />
    </>
  ),
  paste: (
    <>
      <rect x="3" y="3" width="10" height="11" rx="1.25" />
      <path d="M6 2h4v2H6zM5.75 7.25h4.5M5.75 10h4.5" />
    </>
  ),
  copyText: (
    <>
      {doc}
      <path d="M5.5 8h5M5.5 10.5h5" />
    </>
  ),
  archive: (
    <>
      {crate}
      <path d="M6.5 8.5h3" />
    </>
  ),
  archivePack: (
    <>
      {crate}
      <path d="M8 7v4.5m-1.75-1.75L8 11.5l1.75-1.75" />
    </>
  ),
  archiveUnpack: (
    <>
      {crate}
      <path d="M8 11.5V7M6.25 8.75 8 7l1.75 1.75" />
    </>
  ),
  archiveTest: (
    <>
      {crate}
      <path d="m5.75 9.25 1.5 1.5 3-3" />
    </>
  ),
  hash: <path d="M6 2.5 5 13.5M11.5 2.5l-1 11M2.5 5.75h11M2 10.25h11" />,
  hashCheck: (
    <path d="M5 2.5 4.25 9.5M9.5 2.5l-.75 7M2.25 4.75h8.5M2 7.5h8.5M9.5 12l1.75 1.75 3-3.5" />
  ),
  undo: <path d="M3 6.5h6.5a3.5 3.5 0 0 1 0 7H6M5.5 4 3 6.5 5.5 9" />,
  attrs: (
    <>
      <path d="M2.5 4.5h4M9.5 4.5h4M2.5 11.5h7M12.5 11.5h1" />
      <circle cx="8" cy="4.5" r="1.5" />
      <circle cx="11" cy="11.5" r="1.5" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M8 7.25v4M8 4.75v.25" />
    </>
  ),
  sort: <path d="M2.5 4h7M2.5 8h5M2.5 12h3M12.5 3.5v9m-1.75-1.75 1.75 1.75 1.75-1.75" />,
  mark: (
    <>
      {box}
      <path d="m5 8.25 2 2 4-4.5" />
    </>
  ),
  markDown: (
    <>
      <rect x="2.25" y="2.25" width="8" height="8" rx="1.25" />
      <path d="m4.25 6.25 1.5 1.5 2.5-3M12.75 6.5v7m-1.75-1.75 1.75 1.75 1.75-1.75" />
    </>
  ),
  markAll: (
    <>
      <rect x="4.25" y="4.25" width="9.5" height="9.5" rx="1.25" />
      <path d="M2.25 11V3.5c0-.69.56-1.25 1.25-1.25H11M6.5 9l1.75 1.75 3-3.5" />
    </>
  ),
  markNone: (
    <>
      {box}
      <path d="m5.5 5.5 5 5m0-5-5 5" />
    </>
  ),
  markInvert: (
    <>
      {box}
      <path d="M5 6.25h6M9.5 4.75 11 6.25 9.5 7.75M11 9.75H5M6.5 8.25 5 9.75l1.5 1.5" />
    </>
  ),
  markMask: (
    <>
      {box}
      <path d="M8 5v6M5.4 6.5l5.2 3M10.6 6.5l-5.2 3" />
    </>
  ),
  size: (
    <path d="M2 11.5 11.5 2 14 4.5 4.5 14 2 11.5ZM5 8.5l1.25 1.25M7 6.5l1.25 1.25M9 4.5l1.25 1.25" />
  ),
  layoutTop: (
    <>
      {frame}
      <path d="M1.75 5.75h12.5" />
    </>
  ),
  layoutCmd: (
    <>
      {frame}
      <path d="M1.75 10.25h12.5M4 11.75h1.25" />
    </>
  ),
  layoutKeys: (
    <>
      {frame}
      <path d="M1.75 10.25h12.5M5 10.25v3M8 10.25v3M11 10.25v3" />
    </>
  ),
  tree: (
    <>
      <path d="M3.5 2.5V12a1 1 0 0 0 1 1H7M3.5 6.5H7" />
      <rect x="7" y="4.75" width="6.5" height="3.5" rx=".75" />
      <rect x="7" y="11.25" width="6.5" height="3.5" rx=".75" />
    </>
  ),
  globe: (
    <>
      <circle cx="8" cy="8" r="6.25" />
      <path d="M1.75 8h12.5M8 1.75c-2.2 2.6-2.2 9.9 0 12.5M8 1.75c2.2 2.6 2.2 9.9 0 12.5" />
    </>
  ),
  connect: <path d="M9 1.75 3.5 9h4l-1 5.25L12.5 7h-4L9 1.75Z" />,
  disconnect: <path d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5v2.75M2 14 14 2" />,
  gear: (
    <>
      <circle cx="8" cy="8" r="2.25" />
      <path d="m8 1.75 1 1.6 1.85-.45.45 1.85 1.6 1-1 1.6 1 1.6-1.6 1-.45 1.85-1.85-.45-1 1.6-1-1.6-1.85.45-.45-1.85-1.6-1 1-1.6-1-1.6 1.6-1 .45-1.85 1.85.45L8 1.75Z" />
    </>
  ),
  list: <path d="M2.5 4h3.5M2.5 8h3.5M2.5 12h3.5M9 4h4.5M9 8h4.5M9 12h4.5" />,
  table: (
    <>
      {frame}
      <path d="M1.75 6h12.5M1.75 9.5h12.5M6 6v7.25" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type GlyphName = keyof typeof GLYPHS

/** The closest icon of the selectable icon libraries (Fluent, Material). */
export const LIBRARY: Record<GlyphName, IconName> = {
  switchApp: "flip",
  panelOther: "panel-right",
  queue: "sort",
  up: "arrow-up",
  root: "arrow-up",
  back: "arrow-left",
  forward: "arrow-right",
  openLeft: "panel-left",
  openRight: "panel-right",
  swap: "flip",
  pathEdit: "pencil",
  history: "rotate-ccw",
  drive: "panel-bottom-left",
  tabAdd: "mkdir",
  tabClose: "close",
  tabNext: "chevron-right",
  tabPrev: "arrow-left",
  tabCloseOthers: "close",
  tabReopen: "rotate-ccw",
  tabCloseRight: "close",
  tabSets: "copy",
  save: "star",
  lock: "check",
  newFile: "mkdir",
  cut: "move",
  paste: "copy",
  copyText: "copy",
  archive: "preview",
  archivePack: "move",
  archiveUnpack: "move",
  archiveTest: "check",
  hash: "tag",
  hashCheck: "check",
  undo: "rotate-ccw",
  attrs: "settings",
  info: "eye",
  sort: "sort",
  mark: "check",
  markDown: "check",
  markAll: "check",
  markNone: "close",
  markInvert: "flip",
  markMask: "filter",
  size: "sort",
  layoutTop: "panel-bottom-left",
  layoutCmd: "panel-bottom-left",
  layoutKeys: "panel-bottom-left",
  tree: "branch",
  globe: "preview",
  connect: "play",
  disconnect: "close",
  gear: "settings",
  list: "sort",
  table: "preview",
}
