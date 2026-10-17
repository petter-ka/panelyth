import { t } from "@panelyth/i18n"
import { SwitchRow } from "@panelyth/ui"
import { setAutoHide, setAutoHideImage, setConfirmDelete, useVideoPrefs } from "./video"

/**
 * Settings → Appearance → Full screen: whether a full-screen video hides its
 * controls, and a full-screen picture its header, while the mouse rests, and
 * whether Delete asks before a file shown full screen goes to the trash.
 * Stored with the player preferences ("player"), so they are the same in both
 * apps and the media window.
 */
export function FullScreenSettings() {
  const autoHide = useVideoPrefs((s) => s.autoHide)
  const autoHideImage = useVideoPrefs((s) => s.autoHideImage)
  const confirmDelete = useVideoPrefs((s) => s.confirmDelete)
  return (
    <>
      <SwitchRow
        label={t("Hide the video controls")}
        description={t(
          "While a video plays, the bars and the pointer hide after 3 seconds without moving the mouse.",
        )}
        checked={autoHide}
        disabled={false}
        onChange={setAutoHide}
      />
      <SwitchRow
        label={t("Hide the picture header")}
        description={t(
          "On a picture, the header and the pointer hide after 3 seconds without moving the mouse.",
        )}
        checked={autoHideImage}
        disabled={false}
        onChange={setAutoHideImage}
      />
      <SwitchRow
        label={t("Ask before moving to the trash")}
        description={t(
          "Delete on a picture or video shown full screen asks first. Shift+Delete always asks.",
        )}
        checked={confirmDelete}
        disabled={false}
        onChange={setConfirmDelete}
      />
    </>
  )
}
