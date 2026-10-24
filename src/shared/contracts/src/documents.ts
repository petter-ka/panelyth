// Which files open in the document window (ADR-0033). The commander decides
// whether to ask for a window from the name; main decides again from the
// resolved path, so a renderer cannot ask for a window to show anything else.

export type DocumentKind = "pdf" | "text"

/** Extensions shown as text. Everything else (and anything binary) stays with the lister's hex view. */
const TEXT_EXTS: ReadonlySet<string> = new Set([
  "txt",
  "text",
  "md",
  "markdown",
  "rst",
  "log",
  "nfo",
  "diz",
  "readme",
  "json",
  "jsonc",
  "json5",
  "ndjson",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "config",
  "properties",
  "env",
  "xml",
  "xsd",
  "xsl",
  "xslt",
  "svg",
  "html",
  "htm",
  "xhtml",
  "css",
  "scss",
  "sass",
  "less",
  "csv",
  "tsv",
  "sql",
  "js",
  "mjs",
  "cjs",
  "jsx",
  "ts",
  "mts",
  "cts",
  "tsx",
  "vue",
  "svelte",
  "py",
  "pyw",
  "rb",
  "php",
  "pl",
  "pm",
  "lua",
  "r",
  "jl",
  "swift",
  "kt",
  "kts",
  "scala",
  "groovy",
  "dart",
  "c",
  "h",
  "cc",
  "cpp",
  "cxx",
  "hpp",
  "hh",
  "hxx",
  "cs",
  "java",
  "go",
  "rs",
  "m",
  "mm",
  "zig",
  "nim",
  "sh",
  "bash",
  "zsh",
  "fish",
  "bat",
  "cmd",
  "ps1",
  "psm1",
  "gradle",
  "cmake",
  "mk",
  "makefile",
  "dockerfile",
  "gitignore",
  "gitattributes",
  "editorconfig",
  "tex",
  "bib",
  "srt",
  "vtt",
  "ass",
  "diff",
  "patch",
  "lock",
  "csproj",
  "sln",
  "plist",
])

/** Names without an extension that are text by convention. */
const TEXT_NAMES: ReadonlySet<string> = new Set([
  "readme",
  "license",
  "licence",
  "changelog",
  "authors",
  "contributors",
  "notice",
  "copying",
  "makefile",
  "dockerfile",
  "gemfile",
  "rakefile",
  "procfile",
  "cmakelists.txt",
])

/** The document kind of a file name or path (case-insensitive); null = not a document. */
export function documentKindOf(name: string): DocumentKind | null {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).toLowerCase()
  const dot = base.lastIndexOf(".")
  const ext = dot > 0 ? base.slice(dot + 1) : dot === 0 ? base.slice(1) : ""
  if (ext === "pdf") return "pdf"
  if (ext !== "" && TEXT_EXTS.has(ext)) return "text"
  if (TEXT_NAMES.has(base)) return "text"
  return null
}

/**
 * Markdown files (ADR-0046, owner request 2026-10-24): F3 and Enter show them in
 * the text editor window in Live, read-only, instead of the document window;
 * F4 edits them there in Live. The editor's mode switch is for these only.
 */
export const MARKDOWN_EXTS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "mdown",
  "mkd",
  "mkdn",
])

export function isMarkdownName(name: string): boolean {
  const base = name.slice(Math.max(name.lastIndexOf("/"), name.lastIndexOf("\\")) + 1).toLowerCase()
  const dot = base.lastIndexOf(".")
  return dot > 0 && MARKDOWN_EXTS.has(base.slice(dot + 1))
}
