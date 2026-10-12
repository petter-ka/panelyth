import { t } from "@panelyth/i18n"
import { Icon } from "./icons"

/**
 * The expand / collapse control of a folder-tree row, shared by the viewer's
 * sidebar and the commander's tree pane (Stage C10.5). It keeps its place
 * when the folder has no subfolders (invisible), so names stay aligned.
 * Never a tab stop: the tree's own keys expand and collapse.
 */
export function TreeTwisty({
  name,
  expanded,
  hasChildren,
  onToggle,
}: {
  /** The folder's name, for the control's label. */
  name: string
  expanded: boolean
  hasChildren: boolean
  onToggle(): void
}) {
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={expanded ? t("Collapse {name}", { name }) : t("Expand {name}", { name })}
      className={`grid size-4 shrink-0 place-items-center rounded text-muted hover:text-text ${hasChildren ? "" : "invisible"}`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <span
        className={`grid transition-transform duration-[var(--motion-fast)] ease-[var(--motion-ease)] motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`}
      >
        <Icon name="chevron-right" size={12}>
          <path d="m6 3.5 4.5 4.5L6 12.5" />
        </Icon>
      </span>
    </button>
  )
}
