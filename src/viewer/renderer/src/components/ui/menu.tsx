// Moved to the shared design system (src/shared/ui, ADR-0031); re-exported so
// the viewer's imports stay as they were. Only the keymap hint is the viewer's.
import { ContextMenuItem as SharedContextMenuItem } from "@panelyth/ui"
import type { ComponentProps } from "react"
import type { ActionId } from "../../features/shortcuts/keymap"
import { useShortcutHint } from "../../features/shortcuts/shortcutStore"

export {
  ContextMenuContent,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuTrigger,
  DropdownCheckboxItem,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownSub,
  DropdownTrigger,
} from "@panelyth/ui"

export function ContextMenuItem({
  shortcut,
  action,
  ...rest
}: ComponentProps<typeof SharedContextMenuItem> & {
  /** Keymap action: its current chord is shown instead of `shortcut`. */
  action?: ActionId
}) {
  const hint = useShortcutHint(action)
  return <SharedContextMenuItem shortcut={hint ?? shortcut} {...rest} />
}
