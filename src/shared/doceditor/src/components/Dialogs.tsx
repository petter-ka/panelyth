import { t } from "@panelyth/i18n"
import { Button, DialogWindow } from "@panelyth/ui"
import type { ReactNode } from "react"
import { encodingLabel } from "../text/decode"
import { useStore } from "../store"
import type { Workspace } from "../workspace"

// The save's questions (ADR-0046): a file changed on disk, a character the
// file's encoding cannot hold, closing with unsaved changes. Radix dialogs:
// focus is trapped, Esc cancels, focus returns to the editor.

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-4 flex justify-end gap-2">{children}</div>
}

export function Dialogs({ workspace }: { workspace: Workspace }) {
  const { controller } = workspace
  const dialog = useStore(controller.store, (s) => s.dialog)
  const saving = useStore(controller.store, (s) => s.saving)
  const encoding = useStore(controller.store, (s) => s.encoding)
  const bom = useStore(controller.store, (s) => s.bom)

  if (dialog?.kind === "conflict") {
    const cancel = (): void => void controller.resolveConflict("cancel")
    return (
      <DialogWindow
        open
        onOpenChange={(open) => !open && cancel()}
        title={dialog.gone ? t("The file was deleted") : t("The file changed on disk")}
        description={
          dialog.gone
            ? t(
                "It was deleted or moved after you opened it. Save your text to write the file again.",
              )
            : t(
                "Another program changed it after you opened it. Overwrite it with your text, or reload it and lose your changes.",
              )
        }
      >
        <Actions>
          {!dialog.gone && (
            <Button disabled={saving} onClick={() => void controller.resolveConflict("reload")}>
              {t("Reload")}
            </Button>
          )}
          <Button
            variant={dialog.gone ? "primary" : "danger"}
            disabled={saving}
            onClick={() => void controller.resolveConflict("overwrite")}
          >
            {dialog.gone ? t("Save anyway") : t("Overwrite")}
          </Button>
          <Button autoFocus onClick={cancel}>
            {t("Cancel")}
          </Button>
        </Actions>
      </DialogWindow>
    )
  }

  if (dialog?.kind === "unencodable") {
    const label = encodingLabel(encoding, bom)
    const cancel = (): void => void controller.resolveUnencodable("cancel")
    return (
      <DialogWindow
        open
        onOpenChange={(open) => !open && cancel()}
        title={t("This text can't be saved in {encoding}", { encoding: label })}
        description={t(
          "Line {line} has a character {encoding} doesn't have. Save the file as UTF-8 instead?",
          {
            line: dialog.line,
            encoding: label,
          },
        )}
      >
        <Actions>
          <Button
            variant="primary"
            autoFocus
            disabled={saving}
            onClick={() => void controller.resolveUnencodable("utf8")}
          >
            {t("Save as UTF-8")}
          </Button>
          <Button onClick={cancel}>{t("Cancel")}</Button>
        </Actions>
      </DialogWindow>
    )
  }

  if (dialog?.kind === "close") {
    const cancel = (): void => void controller.resolveClose("cancel")
    return (
      <DialogWindow
        open
        onOpenChange={(open) => !open && cancel()}
        title={t("Save the changes to {name}?", { name: workspace.session.name })}
        description={t("Your changes are lost if you don't save them.")}
      >
        <Actions>
          <Button variant="primary" autoFocus onClick={() => void controller.resolveClose("save")}>
            {t("Save")}
          </Button>
          <Button onClick={() => void controller.resolveClose("discard")}>{t("Don't save")}</Button>
          <Button onClick={cancel}>{t("Cancel")}</Button>
        </Actions>
      </DialogWindow>
    )
  }

  return null
}
