import {
  PanelBottomLeftIcon,
  PanelRightIcon,
  TileGridIcon,
  TitleBarSegment,
  type TitleBarOption,
} from "@panelyth/ui"
import { t } from "@panelyth/i18n"
import type { TileSize } from "../features/tiles/layout"
import { useLayoutStore } from "../features/tiles/layoutStore"
import type { PreviewPlace } from "../features/workspace/mirror"
import { setPreviewPlace, usePaneStore } from "../features/workspace/workspace"

/**
 * The viewer's view switchers in the title strip (ADR-0045): the tile size
 * and where the preview sits. The same as the view bar's size control and
 * the sidebar header's switch.
 */
export function ViewerTitleControls() {
  const tileSize = useLayoutStore((s) => s.tileSize)
  const setTileSize = useLayoutStore((s) => s.setTileSize)
  const previewPlace = usePaneStore((s) => s.previewPlace)
  const sizes: TitleBarOption<TileSize>[] = [
    { value: "small", label: t("Small tiles"), icon: <TileGridIcon size="small" /> },
    { value: "medium", label: t("Medium tiles"), icon: <TileGridIcon size="medium" /> },
    { value: "large", label: t("Large tiles"), icon: <TileGridIcon size="large" /> },
  ]
  const places: TitleBarOption<PreviewPlace>[] = [
    {
      value: "left",
      label: t("Preview under the folders"),
      icon: <PanelBottomLeftIcon size={16} />,
    },
    {
      value: "right",
      label: t("Preview in a column on the right"),
      icon: <PanelRightIcon size={16} />,
    },
  ]
  return (
    <>
      <TitleBarSegment
        label={t("Tile size")}
        value={tileSize}
        options={sizes}
        onChange={setTileSize}
        testId="title-tile-size"
      />
      <TitleBarSegment
        label={t("Preview position")}
        value={previewPlace}
        options={places}
        onChange={setPreviewPlace}
        testId="title-preview-place"
      />
    </>
  )
}
