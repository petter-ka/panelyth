const MAX_TILES = 24

interface GridPlaceholderProps {
  /** Number of skeleton tiles; capped so a placeholder never mounts a large DOM. */
  count?: number
}

/**
 * Static skeleton in the geometry the virtualized grid will use (fixed square
 * tiles plus a label row). No animation: the scrolling surface stays cheap.
 */
export function GridPlaceholder({ count = 18 }: GridPlaceholderProps) {
  const tiles = Math.max(0, Math.min(count, MAX_TILES))
  return (
    <div
      aria-hidden="true"
      data-testid="grid-placeholder"
      className="grid grid-cols-[repeat(auto-fill,minmax(148px,1fr))] content-start gap-3 p-4"
    >
      {Array.from({ length: tiles }, (_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <div className="aspect-square rounded-md bg-skeleton" />
          <div className="h-2.5 w-3/4 rounded bg-skeleton" />
        </div>
      ))}
    </div>
  )
}
