import { ShortcutsDialog as SharedShortcutsDialog } from "@panelyth/ui"
import { useMemo } from "react"
import { canSwitchApps } from "../bridge"
import { ACTIONS, type ActionDef, type ActionId } from "../features/shortcuts/keymap"
import {
  resetAllBindings,
  resetBinding,
  setBinding,
  setShortcutHelpOpen,
  useShortcutStore,
} from "../features/shortcuts/shortcutStore"

/** The app switch is listed only while the commander is enabled (ADR-0031). */
const listed = (): readonly ActionDef[] =>
  canSwitchApps() ? ACTIONS : ACTIONS.filter((a) => a.id !== "app.switch")

/**
 * Keyboard shortcut reference and customization (Stage 08, ADR-0022), on the
 * dialog shared with the commander (src/shared/ui).
 */
export function ShortcutsDialog() {
  const open = useShortcutStore((s) => s.helpOpen)
  const chords = useShortcutStore((s) => s.keymap.chords)
  const overrides = useShortcutStore((s) => s.overrides.bindings)
  const customized = useMemo(() => new Set(Object.keys(overrides)), [overrides])
  return (
    <SharedShortcutsDialog
      open={open}
      onOpenChange={setShortcutHelpOpen}
      actions={listed()}
      chords={chords}
      customized={customized}
      onSet={(id, list) => setBinding(id as ActionId, list)}
      onReset={(id) => resetBinding(id as ActionId)}
      onResetAll={resetAllBindings}
    />
  )
}
