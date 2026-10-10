# ADR-0014 — Design System Adoption (Tailwind CSS + shadcn/ui)

## Status

Accepted (Stage 00). Amended after Stage 00: theme design (neutral surround, dark default).

Amended 2026-10-05: the system applies to both apps (ADR-0025). Its specification moved to
`docs/shared/DESIGN-SYSTEM.md`, and Stage P01 moves the tokens and primitives into `src/shared/ui`.

Amended 2026-10-06: local Inter and JetBrains Mono fonts replace the system-only typography stack.

## Context

FR-20 (`docs/shared/REQUIREMENTS.md`, formerly in the BRS) mandates Tailwind CSS and shadcn/ui, and CLAUDE.md
requires an ADR for UI libraries. Stage 08 ("product polish") lists them, but Stage 00 needs a theme shell and
Stage 05 needs resizable panes, context menus and dialogs, so waiting until Stage 08 is not workable.

## Decision

- **Tailwind CSS v4** (Vite plugin) is in from Stage 00. Colors are **CSS-variable tokens** on `:root` and
  `:root.dark`, exposed through `@theme inline` (`bg-canvas`, `bg-chrome`, `bg-raised`, `text-muted`,
  `border-border` …), and components never use raw colors. Dark mode is class-based and driven by the theme
  store.
- **Theme design** (spec: `docs/shared/DESIGN-SYSTEM.md`, "Theme and color"):
  - All grays are exactly neutral, so the UI never tints perceived photo color.
  - Media sits on the darker `canvas` and controls on `chrome`.
  - The single accent is safelight amber, used for focus, selection and the primary action.
  - **Dark is the default theme**; light and system are user choices, persisted.
  - Neutrality and WCAG AA contrast are enforced by `src/viewer/renderer/src/styles/tokens.test.ts`.
- **shadcn/ui primitives are added by the stage that first needs them** (for example Resizable, ContextMenu and
  AlertDialog in Stage 05, and Slider in Stage 06). They are copied into `src/viewer/renderer/src/components/ui` as
  shadcn intends and restyled only through tokens. Their variables are mapped onto ours: `background` →
  `canvas` or `chrome` by placement, `card`/`popover` → `raised`, `primary`/`ring` → `accent`,
  `muted-foreground` → `muted`, `destructive` → `danger`.
- shadcn `Resizable` brings in `react-resizable-panels`. Its per-frame resize work must not re-render the tile view
  (ADR-0007). That gets verified with a trace when Stage 05 introduces it.
- **Stage 05 implementation:** the Radix packages shadcn/ui builds on (`@radix-ui/react-context-menu`,
  `-dropdown-menu`, `-dialog`) and `react-resizable-panels` are used directly. Thin token-styled wrappers live in
  `src/viewer/renderer/src/components/ui/` (`menu.tsx`, `dialog.tsx`, `icons.tsx`), without the shadcn CLI. Menus are
  portalled and mounted only while open. The ADR-0007 resize trace was run: 0 long tasks. Cost: about 100 KB minified
  JS; the idle renderer's JS heap stays at 3.7 MB.
- Stage 08 refines tokens, motion and accessibility. It does not introduce the system or the themes.
- Typography uses locally bundled Inter and JetBrains Mono WOFF2 files in `src/shared/ui/src/fonts`. Inter is the UI
  sans family; JetBrains Mono is used for paths, IDs, code and numeric values. Their SIL Open Font Licenses are
  included with the assets, and the renderers make no external font requests.

## Rules

- No animations, `backdrop-filter` or per-tile transitions on the scrolling surface without a measured trace.
- Fonts must remain locally bundled; do not fetch fonts from a remote service at runtime (local-first, strict CSP).
