# ADR-0034 — Localization

## Status

Accepted (2026-10-11), at the owner's request, outside the stage list (the active stage is P04). It adds a package and
one shared setting; it changes no other decision.

## Context

- The viewer, the commander and the document window (ADR-0033) show English text only. The owner wants the whole app in
  English (the default), Hungarian, Spanish, Italian, French, Polish, Russian and German.
- Text appears in React components, in stores that build notices and job labels, in constant tables (menus, columns,
  shortcut names) and in plural sentences ("1 item", "2 items", and the three-way plural of Polish and Russian).
- Both apps share one `library.db` and already share their appearance (ADR-0031); a language chosen in one app must
  reach the other.

## Decision

- **A package `@panelyth/i18n`** (`src/shared/i18n`), with no dependency but zustand, used by the viewer, the
  commander, the shared UI and media components, and the document window.
- **The English text is the key.** `t("Open folder")` returns the translation of that sentence, or the sentence itself
  (always in English, and for a message nobody translated yet). No key names to invent, a missing translation is
  never blank, and the source reads as it did. Placeholders and plurals are written in the message:
  `t("{count, plural, one {# item} other {# items}} selected", { count })`. The format is a small subset of ICU
  MessageFormat (`{name}`, `plural` with `=n`, `zero|one|two|few|many|other` and `#`), evaluated with
  `Intl.PluralRules`, so the Polish and Russian plural forms work.
- **Constants hold the source text and translate when shown:** `msg("Name")` marks a message without translating it, and
  the component calls `t(label)`. Nothing translates at import time.
- **Language data:** one file per language in `src/shared/i18n/src/messages/` (`hu`, `es`, `it`, `fr`, `pl`, `ru`,
  `de`), loaded on demand as a separate chunk (about 15 kB gzipped) when the language is chosen; English needs no file.
- **A language change remounts the app tree** (`LocaleBoundary` keys its children by language), so every `t()` call
  runs again; the stores live outside React, so the app's state stays. Components use no hook for it.
- **The setting** is part of the shared appearance value (`shared.appearance`, `{ theme, interfaceSize, language }`), so
  the other app applies it live and it is stored in `library.db`. Each app also mirrors it in `localStorage`
  (`panelyth.language`) and applies it before the first render (`await initLocale()`), so there is no flash of English.
  Settings → Appearance → Language lists each language in its own language. English is the default; the operating
  system's language is not consulted.
- **The document window** (no bridge) receives the language in its URL fragment (`lang`), like its theme; `document.open`
  takes an optional `lang` (a two or three letter code).
- **Numbers and dates** follow the language (`Intl` formatters created once per language: `perLocale`); the commander's
  relative dates use the matching `date-fns` locale.
- **Not by language:** the product and app names (Panelyth, Viewer, Commander), file names, key names (Ctrl, Esc, F5),
  technical names (UTF-8, ZIP) and the units B / KB / MB / GB.
- **A test keeps the catalogs whole:** `catalog.test.ts` finds every `t("…")` and `msg("…")` literal in the sources and
  fails when a language lacks a message, has a stale one, changes the placeholders, or lacks a plural form its language
  needs. `pnpm i18n` lists the messages and, with `--missing <lang>`, those still to translate. A new user-visible string
  therefore needs seven translations before the tests pass.
- **Elements are found by `data-*` attributes, not by translated labels** (the F6 pane cycling uses `data-pane`).

## Consequences

- Strings are written in English at the call site; a changed English sentence is a new message and needs new
  translations (the old one is reported stale).
- Messages must be whole sentences: a translated sentence is never assembled from translated pieces, apart from the
  list-style joins ("a, b") that are the same in every language here.
- Every renderer imports the package; the startup path loads one extra small chunk for a non-English language.

## Not covered

- Text produced by the Go sidecar (for example the `message` of an error the app has no text for) and by the operating
  system's own dialogs stays in English. The native "Open folder" dialog title is main's.
- The translations were written without a native-speaker review; they are plain UI language and meant to be corrected
  in the message files.
