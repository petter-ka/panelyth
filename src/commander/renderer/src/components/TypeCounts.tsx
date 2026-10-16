import type { QueryFacets } from "@panelyth/contracts"
import { t } from "@panelyth/i18n"
import {
  DropdownCheckboxItem,
  DropdownContent,
  DropdownItem,
  DropdownLabel,
  DropdownRoot,
  DropdownSeparator,
  DropdownTrigger,
  Spinner,
} from "@panelyth/ui"
import { useState } from "react"
import { bridge } from "../bridge"
import { setFilter, useListingStore } from "../features/listing"
import type { Side } from "../features/panels"

/** Three bars, longest first: entries counted by type. */
const GroupGlyph = () => (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3 4h10M3 8h7M3 12h4" />
  </svg>
)

type Counted =
  | { key: string; status: "counting" }
  | { key: string; status: "done"; facets: QueryFacets }
  | { key: string; status: "failed" }

const number = (n: number): string => n.toLocaleString()

/** How many types can be shown at once. */
export const MAX_TYPES = 3

/**
 * The extensions of a quick filter this menu made ("*.jpg;*.png"), lowercase;
 * [] for none, null for any other filter (typed text, another mask).
 */
export function typesOf(filter: string): string[] | null {
  if (filter === "") return []
  const terms = filter.split(";")
  if (terms.length > MAX_TYPES) return null
  const exts = terms.map((term) => /^\*\.([^*?;|\s]+)$/.exec(term.trim())?.[1]?.toLowerCase())
  return exts.every((ext) => ext !== undefined) ? (exts as string[]) : null
}

/** The quick filter showing these extensions; "" shows everything. */
export const typesFilter = (exts: readonly string[]): string =>
  exts.map((ext) => `*.${ext}`).join(";")

/**
 * The path bar's count by type: the panel's folders, then each extension's
 * files, the most common first. Counted only when opened (a branch view or a
 * large archive takes a while), and again only once the listing has changed.
 * The counts leave the quick filter out, so every type stays to choose from:
 * ticking up to three extensions filters the panel to them, and the menu
 * stays open meanwhile.
 */
export function TypeCounts({ side, className }: { side: Side; className: string }) {
  const query = useListingStore((s) => s[side].query)
  const [counted, setCounted] = useState<Counted | null>(null)
  const key = query ? `${query.queryId}:${query.version}` : ""

  const count = (): void => {
    if (!query || counted?.key === key) return
    setCounted({ key, status: "counting" })
    const settle = (next: Counted): void =>
      setCounted((current) => (current?.key === key ? next : current))
    bridge.facets(query.queryId).then(
      (facets) => settle({ key, status: "done", facets }),
      () => settle({ key, status: "failed" }),
    )
  }

  const label = t("Count by type")
  return (
    <DropdownRoot onOpenChange={(open) => open && count()}>
      <DropdownTrigger
        tabIndex={-1}
        disabled={!query}
        aria-label={label}
        data-tooltip-content={label}
        data-testid={`types-${side}`}
        className={`${className} inline-grid place-items-center`}
      >
        <GroupGlyph />
      </DropdownTrigger>
      <DropdownContent align="end" data-testid={`types-menu-${side}`} aria-label={label}>
        {/* Still right after a tick: the counts leave the quick filter out. */}
        {counted && <Counts side={side} counted={counted} />}
      </DropdownContent>
    </DropdownRoot>
  )
}

function Row({ name, count }: { name: string; count: number }) {
  return (
    <DropdownLabel>
      <span className="flex gap-6 text-xs text-text">
        {name}
        <span className="ml-auto text-muted prose-nums">{number(count)}</span>
      </span>
    </DropdownLabel>
  )
}

function Counts({ side, counted }: { side: Side; counted: Counted }) {
  const filter = useListingStore((s) => s[side].filter)
  // Another filter (typed text) is replaced by the first type ticked.
  const chosen = typesOf(filter) ?? []
  const toggle = (ext: string): void =>
    setFilter(
      side,
      typesFilter(chosen.includes(ext) ? chosen.filter((e) => e !== ext) : [...chosen, ext]),
    )
  if (counted.status === "counting") {
    return (
      <DropdownLabel>
        <span className="flex items-center gap-2" role="status">
          <Spinner size={12} />
          {t("Counting…")}
        </span>
      </DropdownLabel>
    )
  }
  if (counted.status === "failed") {
    return <DropdownLabel>{t("Couldn't count the entries.")}</DropdownLabel>
  }
  const { folders, images, videos, files = 0, exts } = counted.facets
  const allFiles = images + videos + files
  // At most 50 extensions come back: the rest are counted together.
  const others = allFiles - exts.reduce((sum, e) => sum + e.count, 0)
  return (
    <>
      <Row name={t("Folders")} count={folders} />
      {allFiles === 0 ? (
        <DropdownLabel>{t("No files")}</DropdownLabel>
      ) : (
        <>
          <DropdownSeparator />
          <DropdownLabel>{t("Show up to {count} types", { count: MAX_TYPES })}</DropdownLabel>
          {exts.map((e) => {
            if (e.ext === "") return <Row key="" name={t("No extension")} count={e.count} />
            const checked = chosen.includes(e.ext)
            return (
              <DropdownCheckboxItem
                key={e.ext}
                data-ext={e.ext}
                checked={checked}
                // The fourth waits until one is unticked.
                disabled={!checked && chosen.length >= MAX_TYPES}
                onSelect={(event) => {
                  // Open while choosing: one type after the other.
                  event.preventDefault()
                  toggle(e.ext)
                }}
              >
                {e.ext}
                <span className="ml-auto pl-6 text-2xs opacity-70 prose-nums group-data-[highlighted]:opacity-100">
                  {number(e.count)}
                </span>
              </DropdownCheckboxItem>
            )
          })}
          {others > 0 && <Row name={t("Other types")} count={others} />}
          {chosen.length > 0 && (
            <>
              <DropdownSeparator />
              <DropdownItem onSelect={() => setFilter(side, "")}>
                {t("Show all types")}
              </DropdownItem>
            </>
          )}
        </>
      )}
    </>
  )
}
