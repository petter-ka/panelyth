import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search"
import { runScopeHandlers, type EditorView, type Panel, type ViewUpdate } from "@codemirror/view"
import { t } from "@panelyth/i18n"
import type { EditorState } from "@codemirror/state"

// The find and replace panel (Ctrl+F, Ctrl+H): @codemirror/search's commands
// and state, with a panel of our own for the app's look, translated labels and
// the match count. Plain DOM: it lives inside the editor, outside React.

/** Matches counted at most; more shows as "More than 9,999 matches". */
export const MATCH_COUNT_CAP = 9_999

export interface MatchCount {
  /** Matches found, up to MATCH_COUNT_CAP. */
  total: number
  /** More matches than the cap. */
  capped: boolean
  /** 1-based index of the match the selection is on; 0 when it is on none. */
  current: number
}

export interface CountMatchesOptions {
  sliceMs?: number
  yieldTo?: (next: () => void) => void
  now?: () => number
  cancelled?: () => boolean
}

/**
 * Counts the query's matches in slices of a few milliseconds, so a short
 * query in a large document never holds up typing. Resolves null when
 * cancelled or when the query is empty or invalid.
 */
export function countMatches(
  state: EditorState,
  query: SearchQuery,
  options: CountMatchesOptions = {},
): Promise<MatchCount | null> {
  if (!query.valid || query.search === "") return Promise.resolve(null)
  const sliceMs = options.sliceMs ?? 6
  const yieldTo = options.yieldTo ?? ((next) => setTimeout(next, 0))
  const now = options.now ?? (() => performance.now())
  const cancelled = options.cancelled ?? (() => false)
  const main = state.selection.main
  const cursor = query.getCursor(state)
  let total = 0
  let current = 0
  return new Promise((resolve) => {
    const run = (): void => {
      if (cancelled()) return resolve(null)
      const deadline = now() + sliceMs
      for (let n = 0; ; n++) {
        const next = cursor.next()
        if (next.done) return resolve({ total, capped: false, current })
        if (total === MATCH_COUNT_CAP) return resolve({ total, capped: true, current })
        total++
        const { from, to } = next.value
        if (current === 0 && from === main.from && to === main.to) current = total
        if ((n & 63) === 63 && now() >= deadline) return yieldTo(run)
      }
    }
    run()
  })
}

/** The count's words: "3 of 12", "12 matches", "No matches". */
export function matchCountLabel(count: MatchCount | null, query: SearchQuery): string {
  if (query.search === "") return ""
  if (!query.valid) return t("Invalid regular expression")
  if (!count) return ""
  if (count.total === 0) return t("No matches")
  if (count.capped) return t("More than {count} matches", { count: count.total })
  if (count.current > 0)
    return t("{current} of {total}", { current: count.current, total: count.total })
  return t("{count, plural, one {# match} other {# matches}}", { count: count.total })
}

const panels = new WeakMap<EditorView, FindPanel>()

/** Ctrl+H: the panel with its replace row, the replace field focused. */
export function openReplacePanel(view: EditorView): boolean {
  openSearchPanel(view)
  // A read-only document has find only.
  if (!view.state.readOnly) panels.get(view)?.showReplace(true)
  return true
}

/** The panel's labels in the current language (after a language change). */
export function relabelSearchPanel(view: EditorView): void {
  panels.get(view)?.relabel()
}

const COUNT_DELAY_MS = 120

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  attrs: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value)
  return node
}

const FIELD =
  "h-7 min-w-0 flex-1 rounded-md border font-mono border-border bg-raised px-2 text-xs text-text outline-none placeholder:text-muted focus:border-accent"
const BUTTON =
  "h-7 shrink-0 rounded-md border border-border bg-raised px-2.5 text-xs text-text hover:border-muted focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-50"
const TOGGLE =
  "grid h-7 min-w-7 shrink-0 place-items-center rounded-md border border-transparent px-1.5 font-mono text-2xs text-muted hover:text-text aria-pressed:border-accent aria-pressed:text-accent focus-visible:outline-2 focus-visible:outline-accent"
const ICON =
  "grid size-7 shrink-0 place-items-center rounded-md text-muted hover:bg-raised hover:text-text focus-visible:outline-2 focus-visible:outline-accent"

class FindPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private query: SearchQuery
  private readonly view: EditorView
  private readonly searchField: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly caseToggle: HTMLButtonElement
  private readonly wordToggle: HTMLButtonElement
  private readonly regexpToggle: HTMLButtonElement
  private readonly expand: HTMLButtonElement
  private readonly prev: HTMLButtonElement
  private readonly next: HTMLButtonElement
  private readonly close: HTMLButtonElement
  private readonly replaceOne: HTMLButtonElement
  private readonly replaceEvery: HTMLButtonElement
  private readonly countLabel: HTMLElement
  private readonly replaceRow: HTMLElement
  private countTimer: ReturnType<typeof setTimeout> | null = null
  private countRun = 0

  constructor(view: EditorView) {
    this.view = view
    this.query = getSearchQuery(view.state)
    const q = this.query

    this.dom = el("div", "flex flex-col gap-1.5 px-2 py-1.5 font-sans text-xs", { role: "search" })
    this.dom.addEventListener("keydown", (e) => this.keydown(e))

    const findRow = el("div", "flex items-center gap-1.5")
    this.expand = el("button", ICON, { type: "button", "aria-expanded": "false" })
    this.expand.textContent = "›"
    this.expand.addEventListener("click", () => {
      if (this.replaceRow.hidden) this.showReplace(true)
      else this.hideReplace()
    })
    this.searchField = el("input", FIELD, {
      type: "text",
      "main-field": "true",
      spellcheck: "false",
    })
    this.searchField.value = q.search
    this.searchField.addEventListener("input", () => this.commit())
    this.countLabel = el("span", "min-w-20 shrink-0 text-right text-2xs text-muted prose-nums")
    this.caseToggle = this.toggle(q.caseSensitive, "Aa")
    this.wordToggle = this.toggle(q.wholeWord, "W")
    this.regexpToggle = this.toggle(q.regexp, ".*")
    this.prev = el("button", ICON, { type: "button" })
    this.prev.textContent = "↑"
    this.prev.addEventListener("click", () => findPrevious(this.view))
    this.next = el("button", ICON, { type: "button" })
    this.next.textContent = "↓"
    this.next.addEventListener("click", () => findNext(this.view))
    this.close = el("button", ICON, { type: "button" })
    this.close.textContent = "×"
    this.close.addEventListener("click", () => closeSearchPanel(this.view))
    findRow.append(
      this.expand,
      this.searchField,
      this.countLabel,
      this.caseToggle,
      this.wordToggle,
      this.regexpToggle,
      this.prev,
      this.next,
      this.close,
    )

    this.replaceRow = el("div", "flex items-center gap-1.5 pl-[2.125rem]")
    this.replaceRow.hidden = true
    this.replaceField = el("input", FIELD, { type: "text", spellcheck: "false" })
    this.replaceField.value = q.replace
    this.replaceField.addEventListener("input", () => this.commit())
    this.replaceOne = el("button", BUTTON, { type: "button" })
    this.replaceOne.addEventListener("click", () => replaceNext(this.view))
    this.replaceEvery = el("button", BUTTON, { type: "button" })
    this.replaceEvery.addEventListener("click", () => replaceAll(this.view))
    this.replaceRow.append(this.replaceField, this.replaceOne, this.replaceEvery)

    this.dom.append(findRow, this.replaceRow)
    this.relabel()
    if (q.replace !== "") this.showReplace(false)
    this.expand.hidden = view.state.readOnly
    panels.set(view, this)
  }

  private toggle(pressed: boolean, text: string): HTMLButtonElement {
    const button = el("button", TOGGLE, { type: "button", "aria-pressed": String(pressed) })
    button.textContent = text
    button.addEventListener("click", () => {
      button.setAttribute("aria-pressed", String(button.getAttribute("aria-pressed") !== "true"))
      this.commit()
    })
    return button
  }

  /** Writes the labels in the current language. */
  relabel(): void {
    const label = (node: HTMLElement, text: string): void => {
      node.setAttribute("aria-label", text)
      node.title = text
    }
    this.dom.setAttribute("aria-label", t("Find and replace"))
    label(this.expand, t("Show replace"))
    this.searchField.placeholder = t("Find")
    this.searchField.setAttribute("aria-label", t("Find"))
    this.replaceField.placeholder = t("Replace with")
    this.replaceField.setAttribute("aria-label", t("Replace with"))
    label(this.caseToggle, t("Match case"))
    label(this.wordToggle, t("Whole word"))
    label(this.regexpToggle, t("Regular expression"))
    label(this.prev, t("Previous match (Shift+Enter)"))
    label(this.next, t("Next match (Enter)"))
    label(this.close, t("Close (Esc)"))
    this.replaceOne.textContent = t("Replace")
    this.replaceEvery.textContent = t("Replace all")
    this.scheduleCount(0)
  }

  showReplace(focus: boolean): void {
    if (this.view.state.readOnly) return
    this.replaceRow.hidden = false
    this.expand.setAttribute("aria-expanded", "true")
    this.expand.textContent = "⌄"
    if (focus) {
      this.replaceField.focus()
      this.replaceField.select()
    }
  }

  private hideReplace(): void {
    this.replaceRow.hidden = true
    this.expand.setAttribute("aria-expanded", "false")
    this.expand.textContent = "›"
    this.searchField.focus()
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseToggle.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordToggle.getAttribute("aria-pressed") === "true",
      regexp: this.regexpToggle.getAttribute("aria-pressed") === "true",
    })
    if (query.eq(this.query)) return
    this.query = query
    this.view.dispatch({ effects: setSearchQuery.of(query) })
  }

  private keydown(e: KeyboardEvent): void {
    if (runScopeHandlers(this.view, e, "search-panel")) {
      e.preventDefault()
    } else if (e.key === "Enter" && e.target === this.searchField) {
      e.preventDefault()
      ;(e.shiftKey ? findPrevious : findNext)(this.view)
    } else if (e.key === "Enter" && e.target === this.replaceField) {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) replaceAll(this.view)
      else replaceNext(this.view)
    }
  }

  update(update: ViewUpdate): void {
    if (update.startState.readOnly !== update.state.readOnly) {
      // Editing started (or a read-only state came in): replace follows.
      this.expand.hidden = update.state.readOnly
      if (update.state.readOnly) {
        this.replaceRow.hidden = true
        this.expand.setAttribute("aria-expanded", "false")
      }
    }
    let queryChanged = false
    for (const tr of update.transactions) {
      for (const effect of tr.effects) {
        if (effect.is(setSearchQuery)) {
          queryChanged = true
          if (!effect.value.eq(this.query)) this.setQuery(effect.value)
        }
      }
    }
    if (queryChanged) this.scheduleCount(0)
    else if (update.docChanged || update.selectionSet) this.scheduleCount(COUNT_DELAY_MS)
  }

  private setQuery(query: SearchQuery): void {
    this.query = query
    this.searchField.value = query.search
    this.replaceField.value = query.replace
    this.caseToggle.setAttribute("aria-pressed", String(query.caseSensitive))
    this.wordToggle.setAttribute("aria-pressed", String(query.wholeWord))
    this.regexpToggle.setAttribute("aria-pressed", String(query.regexp))
    if (query.replace !== "") this.showReplace(false)
  }

  /** Counts after a short pause; a newer edit or query cancels the older count. */
  private scheduleCount(delay: number): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer)
    const run = ++this.countRun
    this.countTimer = setTimeout(() => {
      this.countTimer = null
      const query = this.query
      if (query.search === "" || !query.valid) {
        this.countLabel.textContent = matchCountLabel(null, query)
        return
      }
      void countMatches(this.view.state, query, { cancelled: () => run !== this.countRun }).then(
        (count) => {
          if (run === this.countRun && count)
            this.countLabel.textContent = matchCountLabel(count, query)
        },
      )
    }, delay)
  }

  mount(): void {
    this.searchField.focus()
    this.searchField.select()
  }

  destroy(): void {
    this.countRun++
    if (this.countTimer !== null) clearTimeout(this.countTimer)
    panels.delete(this.view)
  }
}

export const createFindPanel = (view: EditorView): Panel => new FindPanel(view)
