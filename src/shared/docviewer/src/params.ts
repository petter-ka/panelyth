import { documentKindOf, type DocumentKind } from "@panelyth/contracts"

/** What main puts in the window's URL fragment (documentWindow.ts); the page has nothing else. */
export interface DocumentParams {
  kind: DocumentKind
  name: string
  sizeBytes: number
  /** The read-only panelyth-media token URL. */
  src: string
  theme: string | null
  /** The interface language, a locale code; null = English. */
  lang: string | null
}

const TOKEN_URL = /^panelyth-media:\/\/m\/[0-9a-f]{32}$/

export function parseParams(hash: string): DocumentParams | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""))
  const src = p.get("src") ?? ""
  const name = p.get("name") ?? ""
  const kind = p.get("kind")
  if (!TOKEN_URL.test(src) || name === "") return null
  if (kind !== "pdf" && kind !== "text") return null
  // The kind must agree with the name main resolved.
  if (documentKindOf(name) !== kind) return null
  const size = Number(p.get("size"))
  return {
    kind,
    name,
    sizeBytes: Number.isFinite(size) && size >= 0 ? size : 0,
    src,
    theme: p.get("theme"),
    lang: p.get("lang"),
  }
}

/** Applies the commander's theme name (shared tokens, ui/styles.css). */
export function applyTheme(
  theme: string | null,
  root: HTMLElement = document.documentElement,
): void {
  const name = theme && /^[a-z-]{1,32}$/.test(theme) ? theme : "dark"
  const dark =
    name === "system"
      ? (window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true)
      : name.startsWith("dark")
  root.classList.toggle("dark", dark)
  root.dataset.theme = name === "system" ? (dark ? "dark" : "light") : name
}
