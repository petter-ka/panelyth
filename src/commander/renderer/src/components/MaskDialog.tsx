import { Button, DialogWindow } from "@panelyth/ui"
import { useState } from "react"
import { useUiStore } from "../features/commands"
import { markByMask } from "../features/marks"
import { t } from "@panelyth/i18n"

/**
 * Num+ / Num−: mark or unmark the files matching a mask (the nameMask syntax:
 * "*.jpg;*.png", "|" before exclusions). Folders are never marked by mask.
 */
export function MaskDialog() {
  const target = useUiStore((s) => s.mask)
  const lastMask = useUiStore((s) => s.lastMask)
  return target ? (
    // Remounted per opening, so the field starts with the last mask.
    <MaskForm key={`${target.side}-${String(target.mark)}`} {...target} initial={lastMask} />
  ) : null
}

function MaskForm({
  side,
  mark,
  initial,
}: {
  side: "left" | "right"
  mark: boolean
  initial: string
}) {
  const [mask, setMask] = useState(initial)
  const close = (): void => useUiStore.setState({ mask: null })
  const apply = (): void => {
    const value = mask.trim()
    if (value === "") return
    useUiStore.setState({ mask: null, lastMask: value })
    void markByMask(side, value, mark).catch(() => undefined)
  }
  return (
    <DialogWindow
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
      title={mark ? t("Mark files") : t("Unmark files")}
      description={t("Masks separated by ; — put exclusions after |, e.g. *.jpg;*.png|*_small.*")}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          apply()
        }}
        className="flex flex-col gap-3"
      >
        <input
          aria-label={t("Mask")}
          value={mask}
          spellCheck={false}
          onChange={(e) => setMask(e.target.value)}
          onFocus={(e) => e.target.select()}
          className="h-8 rounded-md border border-border bg-canvas px-2 text-xs text-text outline-none focus:border-accent"
        />
        <div className="flex justify-end gap-2">
          <Button onClick={close}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary">
            {mark ? t("Mark") : t("Unmark")}
          </Button>
        </div>
      </form>
    </DialogWindow>
  )
}
