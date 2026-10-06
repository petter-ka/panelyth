import type { Crumb, EntryKind, SortDirection, SortField, Tag } from "@fastview/contracts"
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react"
import { SEARCH_INPUT_ID } from "../app/shortcuts"
import { bridge } from "../bridge"
import {
  canGoBack,
  canGoForward,
  canGoUp,
  clearFilters,
  goBack,
  goForward,
  goUp,
  hasFilters,
  openFolder,
  openFolderDialog,
  refresh,
  setExts,
  setFavoriteFilter,
  setMinRating,
  setRecursive,
  setSearch,
  setSecondarySort,
  setSort,
  setTagFilter,
  toggleKind,
  useFolderStore,
} from "../features/folder/folderStore"
import { useSidecarStore } from "../features/system/sidecarStore"
import type { ActionId } from "../features/shortcuts/keymap"
import { useShortcutHint } from "../features/shortcuts/shortcutStore"
import { togglePane } from "../features/workspace/paneControls"
import { formatCount } from "../lib/format"
import { TileSizeControl } from "./tiles/TileSizeControl"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  FilterIcon,
  HeartIcon,
  PanelLeftIcon,
  PanelRightIcon,
  RefreshIcon,
  SearchIcon,
  SortIcon,
  TagIcon,
} from "./ui/icons"
import {
  DropdownCheckboxItem,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownRadioGroup,
  DropdownRadioItem,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
} from "./ui/menu"

export const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  modified: "Date modified",
  created: "Date created",
  size: "Size",
  type: "Type",
  dimensions: "Dimensions",
  duration: "Duration",
  favorite: "Favorite",
  rating: "Rating",
  tags: "Tags",
  attrs: "Attributes",
}

/** Direction names that say what the order means for the field. */
export function directionLabel(field: SortField, direction: SortDirection): string {
  const asc = direction === "asc"
  switch (field) {
    case "modified":
    case "created":
      return asc ? "Oldest first" : "Newest first"
    case "size":
    case "dimensions":
      return asc ? "Smallest first" : "Largest first"
    case "duration":
      return asc ? "Shortest first" : "Longest first"
    case "favorite":
      return asc ? "Favorites last" : "Favorites first"
    case "rating":
      return asc ? "Lowest first" : "Highest first"
    default:
      return asc ? "A to Z" : "Z to A"
  }
}

const SEARCH_DEBOUNCE_MS = 200

const iconButton =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted enabled:hover:bg-raised enabled:hover:text-text disabled:opacity-40"
const control =
  "flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-raised px-2.5 text-xs enabled:hover:border-muted disabled:cursor-not-allowed disabled:text-muted"

function IconButton(props: {
  label: string
  /** The keymap action this button runs; its current chord is shown in the tooltip. */
  action?: ActionId
  disabled?: boolean
  onClick(): void
  children: ReactNode
}) {
  const shortcut = useShortcutHint(props.action)
  return (
    <button
      type="button"
      className={iconButton}
      aria-label={props.label}
      title={shortcut ? `${props.label} (${shortcut})` : props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

/** Breadcrumb: the last few ancestors, earlier ones behind "…". */
function Breadcrumb({ crumbs }: { crumbs: Crumb[] }) {
  const SHOWN = 4
  const hidden = crumbs.slice(0, Math.max(0, crumbs.length - SHOWN))
  const shown = crumbs.slice(hidden.length)
  return (
    <nav
      aria-label="Folder path"
      className="flex min-w-0 flex-1 items-center"
      data-testid="breadcrumb"
    >
      <ol className="flex min-w-0 items-center">
        {hidden.length > 0 && (
          <li className="flex shrink-0 items-center">
            <DropdownRoot>
              <DropdownTrigger
                className="rounded px-1.5 py-0.5 text-xs text-muted hover:bg-raised hover:text-text"
                aria-label="Show parent folders"
              >
                …
              </DropdownTrigger>
              <DropdownContent>
                {hidden.map((c) => (
                  <DropdownItem key={c.path} onSelect={() => void openFolder(c.path)}>
                    {c.name}
                  </DropdownItem>
                ))}
              </DropdownContent>
            </DropdownRoot>
            <ChevronRightIcon size={12} className="shrink-0 text-muted" />
          </li>
        )}
        {shown.map((c, i) => {
          const last = i === shown.length - 1
          return (
            <li key={c.path} className={`flex items-center ${last ? "min-w-0" : "min-w-0 shrink"}`}>
              <button
                type="button"
                title={c.path}
                aria-current={last ? "page" : undefined}
                data-testid={last ? "folder-name" : undefined}
                disabled={last}
                onClick={() => void openFolder(c.path)}
                className={`truncate rounded px-1.5 py-0.5 text-xs ${last ? "font-medium text-text" : "text-muted hover:bg-raised hover:text-text"}`}
              >
                {c.name}
              </button>
              {!last && <ChevronRightIcon size={12} className="shrink-0 text-muted" />}
            </li>
          )
        })}
      </ol>
    </nav>
  )
}

/** Debounced search; Esc clears. Ctrl+F focuses it (app/shortcuts). */
function SearchBox({ disabled }: { disabled: boolean }) {
  const committed = useFolderStore((s) => s.search)
  const recursive = useFolderStore((s) => s.recursive)
  const [text, setText] = useState(committed)
  // Follow the store when it changes elsewhere (new folder clears the search).
  const [seen, setSeen] = useState(committed)
  if (committed !== seen) {
    setSeen(committed)
    setText(committed)
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), [])

  const commit = (value: string, delay: number): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setSearch(value.trim()), delay)
  }

  return (
    <div className="relative flex h-7 w-56 shrink items-center">
      <SearchIcon size={14} className="pointer-events-none absolute left-2 text-muted" />
      <input
        id={SEARCH_INPUT_ID}
        type="search"
        aria-label="Search file names"
        placeholder={recursive ? "Search this folder and subfolders" : "Search this folder"}
        disabled={disabled}
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          commit(e.target.value, SEARCH_DEBOUNCE_MS)
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape" && text) {
            e.preventDefault()
            setText("")
            commit("", 0)
          } else if (e.key === "Enter") commit(text, 0)
        }}
        className="h-full w-full rounded-md border border-border bg-raised pr-7 pl-7 text-xs placeholder:text-muted focus:border-accent focus:outline-none disabled:opacity-50 [&::-webkit-search-cancel-button]:hidden"
      />
      {text && (
        <button
          type="button"
          aria-label="Clear search"
          className="absolute right-1 grid size-5 place-items-center rounded text-muted hover:text-text"
          onClick={() => {
            setText("")
            commit("", 0)
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </div>
  )
}

function NavBar() {
  const ready = useSidecarStore((s) => s.status?.state === "ready")
  const opening = useFolderStore((s) => s.opening)
  const folder = useFolderStore((s) => s.folder)
  const back = useFolderStore(canGoBack)
  const forward = useFolderStore(canGoForward)
  const up = useFolderStore(canGoUp)
  return (
    <div
      role="toolbar"
      aria-label="Navigation"
      className="flex h-11 shrink-0 items-center gap-1 border-b border-border bg-chrome px-2"
    >
      <IconButton label="Show or hide sidebar" onClick={() => togglePane("sidebar")}>
        <PanelLeftIcon />
      </IconButton>
      <IconButton label="Back" action="nav.back" disabled={!back} onClick={() => void goBack()}>
        <ArrowLeftIcon />
      </IconButton>
      <IconButton
        label="Forward"
        action="nav.forward"
        disabled={!forward}
        onClick={() => void goForward()}
      >
        <ArrowRightIcon />
      </IconButton>
      <IconButton label="Up" action="nav.up" disabled={!up} onClick={() => void goUp()}>
        <ArrowUpIcon />
      </IconButton>
      <IconButton
        label="Refresh"
        action="view.refresh"
        disabled={!folder}
        onClick={() => void refresh()}
      >
        <RefreshIcon />
      </IconButton>
      <div className="mx-1 flex min-w-0 flex-1 items-center">
        {folder && <Breadcrumb crumbs={folder.crumbs} />}
      </div>
      <SearchBox disabled={!folder} />
      <button
        type="button"
        className={`${control} ml-1`}
        disabled={!ready || opening}
        onClick={() => void openFolderDialog()}
      >
        Open folder…
      </button>
      <IconButton label="Show or hide preview" onClick={() => togglePane("preview")}>
        <PanelRightIcon />
      </IconButton>
    </div>
  )
}

const KIND_CHIPS: { kind: EntryKind; label: string; facet: "folders" | "images" | "videos" }[] = [
  { kind: "dir", label: "Folders", facet: "folders" },
  { kind: "image", label: "Images", facet: "images" },
  { kind: "video", label: "Videos", facet: "videos" },
]

function Filters({ disabled }: { disabled: boolean }) {
  const kinds = useFolderStore((s) => s.kinds)
  const exts = useFolderStore((s) => s.exts)
  const facets = useFolderStore((s) => s.facets)
  const recursive = useFolderStore((s) => s.recursive)
  const filtered = useFolderStore(hasFilters)
  return (
    <div role="group" aria-label="Filters" className="flex min-w-0 items-center gap-1">
      {KIND_CHIPS.filter((c) => !(recursive && c.kind === "dir")).map((c) => {
        const on = kinds.includes(c.kind)
        const count = facets?.[c.facet]
        return (
          <button
            key={c.kind}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggleKind(c.kind)}
            className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[0.6875rem] disabled:opacity-50 ${on ? "border-accent bg-accent text-accent-foreground" : "border-border text-text enabled:hover:border-muted"}`}
          >
            {c.label}
            {count !== undefined && (
              <span className={`tabular-nums ${on ? "" : "text-muted"}`}>{formatCount(count)}</span>
            )}
          </button>
        )
      })}
      <DropdownRoot>
        <DropdownTrigger
          disabled={disabled || !facets || facets.exts.length === 0}
          className={`flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[0.6875rem] disabled:opacity-50 ${exts.length > 0 ? "border-accent bg-accent text-accent-foreground" : "border-border enabled:hover:border-muted"}`}
        >
          <FilterIcon size={12} />
          {exts.length > 0 ? exts.map((e) => e.toUpperCase()).join(", ") : "File types"}
          <ChevronDownIcon size={12} />
        </DropdownTrigger>
        <DropdownContent>
          <DropdownLabel>Show only</DropdownLabel>
          {facets?.exts.map((e) => (
            <DropdownCheckboxItem
              key={e.ext}
              checked={exts.includes(e.ext)}
              onSelect={(ev) => ev.preventDefault()}
              onCheckedChange={(checked) =>
                setExts(checked ? [...exts, e.ext] : exts.filter((x) => x !== e.ext))
              }
            >
              {e.ext.toUpperCase()}
              <span className="ml-auto pl-6 text-[0.6875rem] tabular-nums opacity-70">
                {formatCount(e.count)}
              </span>
            </DropdownCheckboxItem>
          ))}
          {exts.length > 0 && (
            <>
              <DropdownSeparator />
              <DropdownItem onSelect={() => setExts([])}>All file types</DropdownItem>
            </>
          )}
        </DropdownContent>
      </DropdownRoot>
      <UserFilters disabled={disabled} />
      {filtered && (
        <button
          type="button"
          className="shrink-0 rounded px-1.5 text-[0.6875rem] text-muted hover:text-text"
          onClick={clearFilters}
        >
          Clear
        </button>
      )}
    </div>
  )
}

const chip = (on: boolean) =>
  `flex h-6 shrink-0 items-center gap-1 rounded-full border px-2.5 text-[0.6875rem] disabled:opacity-50 ${on ? "border-accent bg-accent text-accent-foreground" : "border-border text-text enabled:hover:border-muted"}`

/** Favorites, minimum rating and tags (library.db, ADR-0021). */
function UserFilters({ disabled }: { disabled: boolean }) {
  const favorite = useFolderStore((s) => s.favorite)
  const minRating = useFolderStore((s) => s.minRating)
  const tags = useFolderStore((s) => s.tags)
  const [known, setKnown] = useState<Tag[] | null>(null)
  return (
    <>
      <button
        type="button"
        aria-pressed={favorite}
        disabled={disabled}
        onClick={() => setFavoriteFilter(!favorite)}
        className={chip(favorite)}
      >
        <HeartIcon size={12} />
        Favorites
      </button>
      <DropdownRoot>
        <DropdownTrigger disabled={disabled} className={chip(minRating > 0)} aria-label="Rating">
          {minRating > 0 ? `★${minRating}+` : "Rating"}
          <ChevronDownIcon size={12} />
        </DropdownTrigger>
        <DropdownContent>
          <DropdownRadioGroup
            aria-label="Minimum rating"
            value={String(minRating)}
            onValueChange={(v) => setMinRating(Number(v))}
          >
            <DropdownRadioItem value="0">Any rating</DropdownRadioItem>
            {[1, 2, 3, 4, 5].map((r) => (
              <DropdownRadioItem key={r} value={String(r)}>
                {"★".repeat(r)}
                {r < 5 ? " or more" : ""}
              </DropdownRadioItem>
            ))}
          </DropdownRadioGroup>
        </DropdownContent>
      </DropdownRoot>
      <DropdownRoot
        onOpenChange={(open) => {
          if (open) bridge.tags().then(setKnown, () => setKnown([]))
        }}
      >
        <DropdownTrigger disabled={disabled} className={chip(tags.length > 0)} aria-label="Tags">
          <TagIcon size={12} />
          {tags.length > 0 ? tags.join(", ") : "Tags"}
          <ChevronDownIcon size={12} />
        </DropdownTrigger>
        <DropdownContent>
          <DropdownLabel>Files with all of</DropdownLabel>
          {known === null && <DropdownLabel>Loading…</DropdownLabel>}
          {known?.length === 0 && <DropdownLabel>No tags yet</DropdownLabel>}
          {known?.map((t) => {
            const on = tags.some((x) => x.toLowerCase() === t.name.toLowerCase())
            return (
              <DropdownCheckboxItem
                key={t.id}
                checked={on}
                onSelect={(ev) => ev.preventDefault()}
                onCheckedChange={(checked) =>
                  setTagFilter(
                    checked
                      ? [...tags, t.name]
                      : tags.filter((x) => x.toLowerCase() !== t.name.toLowerCase()),
                  )
                }
              >
                {t.name}
                <span className="ml-auto pl-6 text-[0.6875rem] tabular-nums opacity-70">
                  {formatCount(t.count)}
                </span>
              </DropdownCheckboxItem>
            )
          })}
          {tags.length > 0 && (
            <>
              <DropdownSeparator />
              <DropdownItem onSelect={() => setTagFilter([])}>Any tags</DropdownItem>
            </>
          )}
        </DropdownContent>
      </DropdownRoot>
    </>
  )
}

/** Menu slots, so the same sort items serve the dropdown and the context menu. */
export interface SortMenuSlots {
  Group: ComponentType<{
    value: string
    onValueChange(value: string): void
    "aria-label": string
    children: ReactNode
  }>
  Item: ComponentType<{ value: string; children: ReactNode }>
  Label: ComponentType<{ children: ReactNode }>
  Separator: ComponentType
}

export function SortMenuItems({ Group, Item, Label, Separator }: SortMenuSlots) {
  const sort = useFolderStore((s) => s.sort)
  const primary = sort[0] ?? { field: "name" as const, direction: "asc" as const }
  const secondary = sort[1] ?? null
  // Attributes are a commander column (ADR-0026); the viewer doesn't offer them.
  const fields = (Object.keys(SORT_LABELS) as SortField[]).filter((f) => f !== "attrs")
  return (
    <>
      <Label>Sort by (folders first)</Label>
      <Group
        aria-label="Sort by"
        value={primary.field}
        onValueChange={(v) => setSort(v as SortField, primary.direction)}
      >
        {fields.map((f) => (
          <Item key={f} value={f}>
            {SORT_LABELS[f]}
          </Item>
        ))}
      </Group>
      <Separator />
      <Group
        aria-label="Order"
        value={primary.direction}
        onValueChange={(v) => setSort(primary.field, v as SortDirection)}
      >
        <Item value="asc">{directionLabel(primary.field, "asc")}</Item>
        <Item value="desc">{directionLabel(primary.field, "desc")}</Item>
      </Group>
      <Separator />
      <Label>Then by</Label>
      <Group
        aria-label="Then by"
        value={secondary?.field ?? "none"}
        onValueChange={(v) =>
          setSecondarySort(v === "none" ? null : (v as SortField), secondary?.direction ?? "asc")
        }
      >
        <Item value="none">Nothing</Item>
        {fields
          .filter((f) => f !== primary.field)
          .map((f) => (
            <Item key={f} value={f}>
              {SORT_LABELS[f]}
            </Item>
          ))}
      </Group>
      {secondary && (
        <>
          <Separator />
          <Group
            aria-label="Then order"
            value={secondary.direction}
            onValueChange={(v) => setSecondarySort(secondary.field, v as SortDirection)}
          >
            <Item value="asc">{directionLabel(secondary.field, "asc")}</Item>
            <Item value="desc">{directionLabel(secondary.field, "desc")}</Item>
          </Group>
        </>
      )}
    </>
  )
}

function SortMenu({ disabled }: { disabled: boolean }) {
  const sort = useFolderStore((s) => s.sort)
  const primary = sort[0] ?? { field: "name" as const, direction: "asc" as const }
  return (
    <DropdownRoot>
      <DropdownTrigger
        className={control}
        disabled={disabled}
        aria-label="Sort"
        data-testid="sort-menu"
      >
        <SortIcon size={14} className="text-muted" />
        {SORT_LABELS[primary.field]}
        <span className="text-muted">{primary.direction === "asc" ? "↑" : "↓"}</span>
        {sort[1] && <span className="text-muted">+ {SORT_LABELS[sort[1].field]}</span>}
        <ChevronDownIcon size={12} className="text-muted" />
      </DropdownTrigger>
      <DropdownContent align="end">
        <SortMenuItems
          Group={DropdownRadioGroup}
          Item={DropdownRadioItem}
          Label={DropdownLabel}
          Separator={DropdownSeparator}
        />
      </DropdownContent>
    </DropdownRoot>
  )
}

function ViewBar() {
  const ready = useSidecarStore((s) => s.status?.state === "ready")
  const folder = useFolderStore((s) => s.folder)
  const recursive = useFolderStore((s) => s.recursive)
  return (
    <div
      role="toolbar"
      aria-label="View"
      className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-chrome px-3"
    >
      <Filters disabled={!folder} />
      <span className="flex-1" />
      <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted">
        <input
          type="checkbox"
          className="accent-accent"
          checked={recursive}
          disabled={!ready}
          onChange={(e) => setRecursive(e.target.checked)}
        />
        Include subfolders
      </label>
      <SortMenu disabled={!folder} />
      <TileSizeControl />
    </div>
  )
}

export function FolderToolbar() {
  return (
    <>
      <NavBar />
      <ViewBar />
    </>
  )
}
