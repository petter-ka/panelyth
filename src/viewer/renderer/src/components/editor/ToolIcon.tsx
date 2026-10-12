// Line drawings for the tool groups and the tools: 16 px grid, like the chrome icons.
import type { ReactNode } from "react"
import type { ToolGroup, ToolId } from "../../features/editor/tools"

const dot = { fill: "currentColor", stroke: "none" } as const

const PATHS: Record<ToolId | ToolGroup, ReactNode> = {
  // Groups
  adjust: (
    <>
      <path d="M2 4h6.5M12.5 4H14M2 8h1.5M7.5 8H14M2 12h7.5M13.5 12h.5" />
      <circle cx="10.5" cy="4" r="1.75" />
      <circle cx="5.5" cy="8" r="1.75" />
      <circle cx="11.5" cy="12" r="1.75" />
    </>
  ),
  color: <path d="M8 2c2.6 3 4 5.1 4 7.2a4 4 0 0 1-8 0C4 7.1 5.4 5 8 2z" />,
  detail: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.5" />
    </>
  ),
  effects: (
    <>
      <path d="M6 2.5 7 5l2.5 1L7 7 6 9.5 5 7 2.5 6 5 5z" />
      <path d="m11.5 8.5.8 1.7 1.7.8-1.7.8-.8 1.7-.8-1.7-1.7-.8 1.7-.8z" />
    </>
  ),
  retouch: <path d="m3 13 1-3.5 7-7 2.5 2.5-7 7zM10 3.5 12.5 6M2.5 13.5h3" />,
  geometry: <path d="M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3" />,
  looks: <path d="m8 2 1.7 3.9 4.3.5-3.2 2.9.9 4.2L8 11.4l-3.7 2.1.9-4.2L2 6.4l4.3-.5z" />,
  // Tone
  lighting: (
    <>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1" />
    </>
  ),
  colors: (
    <>
      <circle cx="6" cy="6" r="3.5" />
      <circle cx="10" cy="6" r="3.5" />
      <circle cx="8" cy="10" r="3.5" />
    </>
  ),
  levels: <path d="M2 14h12M4 14V9.5M7 14V4M10 14V7M13 14v-2.5" />,
  curves: <path d="M2 2v12h12M2 14C8 14 8 3 14 3" />,
  // Color
  grayscale: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 2.5a5.5 5.5 0 0 1 0 11z" {...dot} />
    </>
  ),
  sepia: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="1" />
      <path d="m2 11 3.5-3.5 3 3 2-2L14 12" />
    </>
  ),
  negative: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M14 2v12H2z" {...dot} />
    </>
  ),
  replaceColor: (
    <>
      <rect x="2" y="2" width="5" height="5" rx="1" />
      <rect x="9" y="9" width="5" height="5" rx="1" {...dot} />
      <path d="M9.5 4.5h1.5a1 1 0 0 1 1 1V7" />
    </>
  ),
  swapChannels: <path d="M3 5.5h10L10.5 3M13 10.5H3L5.5 13" />,
  reduceColors: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M8 2v12M2 8h12" />
    </>
  ),
  // Detail
  sharpen: <path d="M8 2.5 13.5 13h-11zM8 7v3" />,
  blur: <circle cx="8" cy="8" r="5.5" strokeDasharray="1.5 2.5" />,
  denoise: (
    <>
      <path d="M3.5 3.5h.01M8 3.5h.01M12.5 3.5h.01M3.5 8h.01M12.5 8h.01M3.5 12.5h.01M8 12.5h.01M12.5 12.5h.01" />
      <circle cx="8" cy="8" r="1.75" />
    </>
  ),
  // Effects
  border: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <rect x="5" y="5" width="6" height="6" />
    </>
  ),
  frameMask: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <ellipse cx="8" cy="8" rx="4" ry="3" />
    </>
  ),
  watermark: <path d="M3 4h10M8 4v8M5.5 12h5" />,
  obscure: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" />
      <path d="M5 5h2v2H5zM9 5h2v2H9zM7 9h2v2H7z" {...dot} />
    </>
  ),
  lens: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="m10.5 10.5 3.5 3.5" />
    </>
  ),
  bump: <path d="M2 11h3l1.5-5h3L11 11h3M2 13.5h12" />,
  sketch: <path d="m3 13 1-3.5 7-7 2.5 2.5-7 7zM10 3.5 12.5 6" />,
  oil: (
    <path d="M13.5 2.5 8 8M8 8c-1.5 0-2.5 1-2.5 2.5S4 13.5 2.5 13.5c2 1 6.5.5 6.5-3 0-1-.3-1.8-1-2.5z" />
  ),
  // Draw and retouch
  draw: <path d="M2.5 13.5c2-.5 2-2.5 3.5-3.5l6-6.5 1.5 1.5-6.5 6c-1 1.5-3 1.5-4.5 2.5z" />,
  clone: (
    <>
      <circle cx="5.5" cy="5.5" r="3" />
      <circle cx="10.5" cy="10.5" r="3" strokeDasharray="1.5 1.5" />
    </>
  ),
  heal: (
    <>
      <rect x="1.5" y="5.5" width="13" height="5" rx="2.5" transform="rotate(-45 8 8)" />
      <path d="M7 7h.01M9 9h.01M9 7h.01M7 9h.01" />
    </>
  ),
  redeye: (
    <>
      <path d="M1.5 8c2-3 4.2-4.5 6.5-4.5S12.5 5 14.5 8c-2 3-4.2 4.5-6.5 4.5S3.5 11 1.5 8z" />
      <circle cx="8" cy="8" r="2" {...dot} />
    </>
  ),
  // Geometry
  rotate: <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v3h-3" />,
  flip: <path d="M8 2v12M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5" />,
  crop: <path d="M4.5 1.5v10h10M1.5 4.5h10v10" />,
  resize: <path d="M2 14 14 2M9 2h5v5M2 9v5h5" />,
  canvas: (
    <>
      <rect x="2" y="2" width="12" height="12" rx="1" strokeDasharray="2 2" />
      <rect x="5" y="5" width="6" height="6" />
    </>
  ),
  dpi: (
    <>
      <rect x="1.5" y="5" width="13" height="6" rx="1" />
      <path d="M4.5 5v2.5M7 5v3.5M9.5 5v2.5M12 5v3.5" />
    </>
  ),
}

export function ToolIcon({ id }: { id: ToolId | ToolGroup }) {
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
    >
      {PATHS[id]}
    </svg>
  )
}
