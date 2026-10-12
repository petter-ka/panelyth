# Stage 14 — Image Editor: Effects

Status: **Implementation done** (2026-10-12). Track: viewer. Depends on: 13. Unblocks: 15, 16. Open items are listed
under "Open".

<!-- File: docs/viewer/stages/14-editor-effects.md -->

## Objective

Add the creative and finishing tools: border effects, frame mask, watermark, bump map, sketch, oil painting, lens and
obscure (blur). Watermark and borders are the most common batch jobs, so they get the most care for relative sizing and
tokens.

## Decisions applied

- ADR-0035 ("Decided in Stage 14" added): registered operations, draft/final, asset handles for user files (logos,
  textures, masks), resources of a run.
- ADR-0036 (proposed): batch rules; watermark tokens; relative regions.
- ADR-0027 (amended): asset files come from a main-owned native dialog; the sidecar never gets a renderer path.
- ADR-0019: pure Go; text drawing with `golang.org/x/image/font` and `opentype` (already a dependency).
- ADR-0034: the tools' strings are translated; user text is never translated.
- `docs/viewer/IMAGE-EDITOR.md` §3.2.

## Scope as built

| Tool | Operation id | Parameters | Batch |
|---|---|---|---|
| Border | `border` | style (plain, double line, bevel, rounded corners, drop shadow, instant photo); width in % of the shorter edge or in px of the full picture; frame color, second color, opacity; inside (covers the edge) or outside (grows the canvas); corner radius; shadow softness, distance and color; what shows around the picture | yes |
| Frame mask | `frameMask` | shape (rounded rectangle, ellipse, circle, soft edge, vignette, or the brightness of a picked picture); inset, feather, radius, vignette strength; invert; outside color or transparent | yes |
| Watermark | `watermark` | text with tokens or a picked picture; font family, bold, italic; size in % of the shorter edge; color, opacity; outline with color; shadow; one of nine positions with a margin; rotation; repeat with spacing and stagger; blend normal, multiply, screen | yes |
| Obscure | `obscure` | blur, pixelate or mosaic; strength; region as rectangle, ellipse or polygon (3–256 points), all 0..1 of the picture; soft edge beyond the region; invert | yes (the region is relative) |
| Lens | `lens` | magnify (bulge), pinch, barrel, pincushion; amount; centre (0..1); radius in % and soft rim for the round ones | yes (the centre is relative) |
| Bump map | `bump` | relief from the picture's brightness or a picked texture (repeated or stretched); depth; light direction and height; smoothness; gray relief to lit colors | yes |
| Sketch | `sketch` | pencil, ink, colored pencil; detail; line strength; paper tone; color amount | yes |
| Oil painting | `oil` | brush radius 1–12 px of the full picture; 4–64 shades | yes |

### Engine (Go)

- `internal/imaging/effects.go` (border, frame mask, shapes by signed distance, compositing helpers),
  `watermark.go`, `artistic.go` (bump, sketch, oil), `distort.go` (lens, obscure), `resources.go` (resources, tokens,
  text drawing, a cache of built marks).
- **Sizes are relative.** Widths, radii, margins, feathers and text sizes are percentages of the picture's shorter
  edge (a border may also be given in pixels of the full picture), so one list gives the same look on 800 × 600 and
  on 4,000 × 3,000. A step learns its input's full size (`Env.InW`, `InH`); `border` outside grows the output size.
- **Shapes are analytic:** rounded rectangles and ellipses are signed-distance functions evaluated per pixel, with
  one-pixel anti-aliasing or a feather. A frame-mask feather lies inside the outline (nothing at the outline,
  everything a feather's width in); an obscured region's soft edge lies outside it, so what was drawn stays fully
  hidden. A drop shadow falls off with the distance from the frame's outline (the integral of a Gaussian from a
  table) instead of blurring a plane of its own.
- **Text:** laid out left to right with the font's kerning, up to 20 lines and 1,000 characters, drawn with
  `opentype` into a mask; outline by a disc maximum (up to 16 px) or a boosted blur beyond; shadow by a blurred,
  shifted copy. The built mark (text or image, turned) is cached by its parameters, so dragging its position or
  opacity does not lay the text out again. Scripts that need shaping (Arabic, Indic) are not shaped.
- **Tokens:** `{name}`, `{filename}`, `{ext}`, `{folder}`, `{date}`, `{time}`, `{year}`, `{month}`, `{day}`,
  `{width}`, `{height}` and `{exif.<tag>}` for the tags the picture carries (`imaging.ExpandTokens`; an unknown
  token stays as written). Stage 16 uses the same expander for file name templates.
- **Oil painting** slides its window along each row (a column leaves, one enters), so the cost grows with the
  radius, not its square. **Lens** maps each output pixel back and samples bicubically (bilinearly in a draft).
  **Obscure** processes only the region's box; pixel blocks are aligned to the picture.
- **Fonts** (`internal/fonts`): two families are built in (Go, Go Mono: Latin, Greek, Cyrillic), so a watermark
  looks the same everywhere; the system's font folders are scanned once for names (the name table only, through a
  bounded reader: at most 4,000 files, 64 MB each, three folder levels, regular files only), and a font file is
  read when it is used (four stay loaded). An unknown family draws with the built-in default.
- **Assets** (`internal/editor/assets.go`): a picked picture must be a regular file, PNG, JPEG, WebP or GIF by its
  first bytes (the name is not believed), at most 16 MB and 8,000 px a side, not animated. Its id is a hash of its
  content. At most 32 are remembered and 32 MP stay decoded; decoded pixels are dropped when the last session
  closes. A file that changed is refused with its name when it has to be read again.
- A run gets its assets, fonts and tokens through `imaging.Resources` (`RunOptions.Res`); a save job keeps the
  session's resources, so it finishes after the editor is closed.

### API

- Renderer (viewer profile only): `edit.fonts { sessionId }` → `{ families }` (names); `asset.pick { sessionId }` →
  `{ asset: { assetId, name, width, height, thumbUrl } | null }` and `asset.release { sessionId, assetId }`, both
  answered in Electron main. `asset.pick` takes a session (the plan had `kind`): the dialog opens in the edited
  picture's folder and an asset is picked for a picture that is being edited.
- Main only: `edit.assetAdd { sessionId, path }` (the path is the one main's dialog returned) and
  `edit.assetDrop`. No renderer method takes a path; an edit list names an asset by its 32-character id.
- New error code `EDIT_ASSET_INVALID`, with one translated message that names the accepted types and limits.

### UX as built

- A sixth group in the tool rail, **Effects** (key E), with the eight tools. Border, Lens and Bump map start
  neutral; Frame mask, Watermark, Obscure, Sketch and Oil painting are there once opened.
- **Watermark:** a text field with chips that insert tokens at the caret; the canvas shows the result for this
  picture. Font by name, bold, italic, color, a nine-point position grid, size, opacity, margin, rotation, outline,
  shadow, repeat with spacing and stagger, blend. "Picture" asks main for a file and shows its name, size and
  thumbnail.
- **Obscure:** the region is on the canvas with eight handles: drag, or move and size with the arrow keys (one
  picture pixel, ten with Shift); numbers in the panel; ellipse inside the same box; a polygon by its points
  (drag, arrow keys, Delete, "Add a point"). A note says that what is obscured cannot be brought back from the
  saved file.
- **Lens:** the centre is a handle on the canvas (drag or arrow keys) with a ring for the round lenses.
- **Border** styles bring what makes them that style (a radius, a shadow, a width). **Frame mask** "From a
  picture…" asks for the mask at once.
- Overlays are white on black strokes, without motion.
- Four effects joined the looks (vignette, instant photo, pencil sketch, oil painting): 16 looks, still one request.
- **Two keyboard fixes in the shell** found by the end-to-end test: what is behind the editor cannot take the
  focus (a menu that opened the editor handed it back to its tile), and a key pressed while the focus is on the
  page itself (the Save button is disabled while it saves) still reaches the editor.
- 130 new strings, translated into the seven other languages.

## Non-goals

- Layered compositing, brush-painted masks, blend-mode stacks beyond the three listed, text on a path, emoji color
  fonts, SVG logos, animated watermarks, face/plate auto-detection for obscure (AI is out of scope, BRS §10).
- Complex-script text shaping (documented limit).
- Batch UI (Stage 16); this stage specifies and tests the batch behavior.

## Implementation tasks

- [x] Go: border and frame painters (anti-aliased shapes, shadow), mask rendering, output size for outside borders.
- [x] Go: font loading and text drawing, watermark compositor with opacity, outline, shadow, rotation, tiling and
  blend modes; token expander (shared with Stage 16's name templates).
- [x] Go: bump, sketch, oil, lens (inverse mapping), obscure (masked blur, pixelate, mosaic; polygon rasterizer).
- [x] Go: metadata thumbnail when `obscure` is present: every save blanks the EXIF thumbnail (Stage 12), so no
  special case is needed; the existing test covers it.
- [x] Main: asset handles (dialog, validation in the sidecar, thumbnail token), font list.
- [x] Contracts, validation (polygons ≤ 256 points, text ≤ 1,000 characters), golden fixtures.
- [x] Renderer: panels, canvas overlays (region, lens centre and ring), token chips, font picker, asset picker.
- [x] Every operation `Batchable`, relative units and tokens.
- [x] Tests, benchmarks, docs, `t()` strings.

## Tests

- Go, `internal/imaging/effects_test.go`: 35 golden cases (every tool and style, text with tokens in Latin and
  Cyrillic, image marks, a chain); nothing-to-do parameters return the picture; border sizes on 800 × 600 and
  4,000 × 3,000; **the proxy shows what the save writes** (21 cases rendered at a quarter size against the full
  result scaled down); token expansion; text (bold, sizes, Cyrillic, lines, a refused huge text, the fallback
  font, mono widths); watermark position, tiling, rotation, opacity, outline, blend modes; frame-mask falloff and
  custom masks; lens outside its circle and with centres outside the picture; obscure changes only its region
  (rectangle, ellipse, polygon, half outside, inverted, feathered); bump light symmetry; sketch and oil on flat
  areas and edges; 42 invalid parameter sets; cancellation; the worker-count check covers the new cases.
- Go, `internal/fonts`: built-in styles, the scan (names only; broken, empty, truncated, too deep and linked files
  skipped), a cancelled scan, the machine's own list.
- Go, `internal/editor/assets_test.go`: validation (wrong type under a picture name, a header claiming 9,000 px,
  more than 16 MB, a folder, a truncated file, an animation, a link, a missing file), the id as content hash, the
  cap of 32, a session drawing text with its tokens and a picked logo, a save after the session closed, a changed
  asset file.
- Contracts and desktop: the eight operations in the structural check, the three methods in the viewer's profile
  and none in the commander's, `asset.pick` (dialog cancelled, relative path, an unexpected thumbnail file, the
  sidecar's refusal), no renderer method with a path.
- Renderer, `components/editor/effects.test.tsx` (12 tests): each tool's edit list and undo, picked pictures as
  ids, the refusal message, regions and the lens centre by keyboard, the focus guard and keys from the page.
- E2E, `specs/viewer/editor-effects.spec.ts`: a region obscured by numbers and keys, a logo picked through main's
  dialog (canned) with its thumbnail and no path in the page, a text watermark with a token, a frame; the saved BMP
  has the frame's color, the source's exact pixels outside the region, blocks inside it, the logo's red at its
  place and white text at the bottom right; the saved picture opens again; a file that is not a picture is
  refused; eight effect sliders dragged on 24 MP.

## Benchmarks

`BENCH_LARGE=1 go test ./internal/imaging -bench Effects` and the e2e spec. Reference machine. Results:
`src/shared/bench/results/stage-14-*` (`imaging-bench.txt` before the shadow change, `imaging-bench-2.txt` after).

| Case | Budget | Measured |
|---|---|---|
| Border / frame mask / watermark, 2 MP | < 30 ms | 10.5 ms (with drop shadow 24.5 ms) / 14–15 ms / 1–3.5 ms |
| Bump / sketch, 2 MP | < 100 ms | 21 ms / 19–21 ms |
| Oil painting r=4, 2 MP, final / draft | < 800 ms / < 120 ms | 31 ms / 31 ms (r=12: 62 ms) |
| Lens, 2 MP | < 60 ms | 34 ms (draft 26 ms) |
| Obscure by blur, a quarter of 2 MP | < 40 ms | 8–21 ms (pixelate 11 ms) |
| Watermark text layout and drawing | < 5 ms | 0.3 ms |
| Full resolution, 24 MP: watermark + border / oil / sketch | < 400 ms / < 4 s / < 1.5 s | 88 ms / 0.31 s (r=12: 0.66 s) / 0.15 s |

The drop shadow first blurred a plane of its own: 48–52 ms at 2 MP, over budget, and 455 ms at 24 MP. With the
analytic falloff it is 24.5 ms and 220 ms.

In the app (24 MP, eight operations in the list): 40–61 ms between frames at p95 while the sliders of obscure,
watermark, lens, bump, sketch, oil, frame mask and border are dragged (budget 80 ms), no long task. The Stage 12
and 13 editor specs were run again and pass unchanged.

## Acceptance criteria

- [x] All eight tools render within budget and match between proxy and saved output.
- [x] Watermark and border are resolution independent; tokens expand per picture.
- [x] Obscure does not leak the original through metadata thumbnails.
- [x] Asset files never reach the sidecar from the renderer; the commander cannot use the asset methods.

## Open

- Not built from the plan: dragging the watermark on the canvas (the nine-point grid and the margin place it); a
  light handle on the canvas for the bump map (two sliders); drawing a polygon by clicking on the picture (points
  are added in the panel and dragged); the value of each token on its chip (the canvas shows the result); a
  virtualized font picker (a native select); raising "Strip metadata" when Obscure is in the list (the thumbnail
  is blanked on every save, the other tags are the user's choice); presets per tool (four effects are looks).
- `asset.release` exists but the interface does not call it: assets are forgotten oldest first (32) and their
  pixels when the editor closes.
- Text in a CJK script needs a system font that has it; there is no automated test for it (it depends on the
  machine's fonts). Complex scripts are not shaped.
- The golden hashes were recorded on amd64; the first arm64 run (macOS, CI) has to confirm them for the
  floating-point shapes.
- The NVDA pass over the new panels and overlays; the Linux and macOS runs and the race detector (CI).

## Risks (as they turned out)

| Risk | Outcome |
|---|---|
| Pure-Go text shaping limits for complex scripts | documented limit; the built-in family covers Latin, Greek and Cyrillic |
| Oil painting cost | a sliding window: 31 ms for a 2 MP frame, 0.31 s for 24 MP |
| EXIF thumbnail leak after obscure | the thumbnail is blanked on every save (Stage 12 test) |
| Fonts differ per OS | two families are built in; a list names a family and falls back to the default |
| Asset handle misuse | main's dialog, content sniffing, size caps, a content-hash id, no path in any renderer method |

## Exit checklist

- [x] implementation complete (see Open)
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed (viewer and commander unit suites; the three editor e2e specs)
- [x] docs/ADR updated
