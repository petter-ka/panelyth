import { TILE_SIZE_ORDER, type TileSize } from "../../features/tiles/layout"
import { useLayoutStore } from "../../features/tiles/layoutStore"
import { Tooltip } from "@panelyth/ui"
import { msg, t } from "@panelyth/i18n"

const LABEL: Record<TileSize, { short: string; long: string }> = {
  small: { short: "S", long: msg("Small tiles") },
  medium: { short: "M", long: msg("Medium tiles") },
  large: { short: "L", long: msg("Large tiles") },
}

/** Segmented S / M / L control. Ctrl/Cmd + wheel in the tile view steps it too. */
export function TileSizeControl() {
  const size = useLayoutStore((s) => s.tileSize)
  const setSize = useLayoutStore((s) => s.setTileSize)
  return (
    <div
      role="group"
      aria-label={t("Tile size")}
      className="flex h-7 overflow-hidden rounded-md border border-border"
    >
      {TILE_SIZE_ORDER.map((s) => (
        <Tooltip
          key={s}
          content={t("{size} (Ctrl + scroll to change)", { size: t(LABEL[s].long) })}
        >
          <button
            type="button"
            aria-label={t(LABEL[s].long)}
            aria-pressed={size === s}
            onClick={() => setSize(s)}
            className={`w-7 text-xs ${size === s ? "bg-raised font-medium text-text" : "text-muted hover:text-text"}`}
          >
            {LABEL[s].short}
          </button>
        </Tooltip>
      ))}
    </div>
  )
}
