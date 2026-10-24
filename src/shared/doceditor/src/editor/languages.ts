import { LanguageDescription, LanguageSupport, StreamLanguage } from "@codemirror/language"
import { languages } from "@codemirror/language-data"
import type { StreamParser } from "@codemirror/language"
import { MARKDOWN_EXTENSIONS } from "./markdownName"

// The editor's languages (ADR-0046): @codemirror/language-data, which loads each
// language on first use, plus the config files it does not name. Ours come
// first, so they win for the extensions both list.

const legacy = <T>(parser: StreamParser<T>): LanguageSupport =>
  new LanguageSupport(StreamLanguage.define(parser))

const EXTRA: readonly LanguageDescription[] = [
  // Fenced code blocks stay one colour: parsing each in its own language
  // (codeLanguages) cost ~7 ms per keystroke at p95 on 1 MB of Markdown with
  // ~4,000 code blocks (p95 25-27 ms against 18-19 ms without, headless Chromium).
  // GFM (tables, task lists, strikethrough) for the live view and the preview.
  LanguageDescription.of({
    name: "Markdown",
    extensions: [...MARKDOWN_EXTENSIONS],
    load: () =>
      import("@codemirror/lang-markdown").then((m) => m.markdown({ base: m.markdownLanguage })),
  }),
  LanguageDescription.of({
    name: "INI",
    alias: ["ini", "cfg", "conf"],
    extensions: [
      "ini",
      "cfg",
      "conf",
      "editorconfig",
      "gitconfig",
      "npmrc",
      "desktop",
      "inf",
      "reg",
    ],
    filename: /^\.(env(\.[\w.-]+)?|gitmodules)$/i,
    load: () =>
      import("@codemirror/legacy-modes/mode/properties").then((m) => legacy(m.properties)),
  }),
  LanguageDescription.of({
    name: "Shell",
    alias: ["bash", "sh", "zsh"],
    extensions: [
      "sh",
      "bash",
      "zsh",
      "ksh",
      "bashrc",
      "zshrc",
      "bash_profile",
      "bash_aliases",
      "zprofile",
      "profile",
      "envrc",
    ],
    filename: /^PKGBUILD$/,
    load: () => import("@codemirror/legacy-modes/mode/shell").then((m) => legacy(m.shell)),
  }),
  LanguageDescription.of({
    name: "TOML",
    extensions: ["toml"],
    filename: /^(Cargo\.lock|Pipfile|poetry\.lock)$/,
    load: () => import("@codemirror/legacy-modes/mode/toml").then((m) => legacy(m.toml)),
  }),
  LanguageDescription.of({
    name: "JSON",
    extensions: [
      "json",
      "jsonc",
      "json5",
      "webmanifest",
      "map",
      "babelrc",
      "eslintrc",
      "prettierrc",
    ],
    load: () => import("@codemirror/lang-json").then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: "XML",
    extensions: [
      "xml",
      "xsl",
      "xsd",
      "svg",
      "xaml",
      "csproj",
      "fsproj",
      "vbproj",
      "props",
      "targets",
      "plist",
      "resx",
      "nuspec",
      "config",
    ],
    load: () => import("@codemirror/lang-xml").then((m) => m.xml()),
  }),
]

const ALL: readonly LanguageDescription[] = [...EXTRA, ...languages]

/**
 * The language of a file name, or null for plain text. Extensions match in
 * any case (README.MD, SETUP.CFG); file name patterns as they are written.
 */
export function languageFor(name: string): LanguageDescription | null {
  const base = name.replace(/^.*[\\/]/, "")
  return (
    LanguageDescription.matchFilename(ALL, base) ??
    LanguageDescription.matchFilename(
      ALL,
      base.replace(/\.[^.]+$/, (ext) => ext.toLowerCase()),
    )
  )
}
