import { t } from "@panelyth/i18n"
import { Button } from "@panelyth/ui"
import { useStore } from "../store"
import type { Workspace } from "../workspace"

/** Not modal: the file changed (or went) on disk while nothing was unsaved here. */
export function DiskBanner({ workspace }: { workspace: Workspace }) {
  const { controller } = workspace
  const banner = useStore(controller.store, (s) => s.banner)
  const reloading = useStore(controller.store, (s) => s.reloading)
  if (!banner) return null
  return (
    <div
      role="status"
      data-testid="disk-banner"
      className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-raised px-3 text-xs"
    >
      <span className="min-w-0 flex-1 truncate">
        {banner === "changed"
          ? t("The file changed on disk. Reload?")
          : t("The file was deleted or moved on disk. Save to write it again.")}
      </span>
      {banner === "changed" && (
        <Button
          size="sm"
          variant="primary"
          disabled={reloading}
          onClick={() => void controller.reload()}
        >
          {t("Reload")}
        </Button>
      )}
      <Button size="sm" onClick={() => controller.dismissBanner()}>
        {t("Dismiss")}
      </Button>
    </div>
  )
}
