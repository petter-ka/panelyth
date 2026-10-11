# Stage 14 — Image Editor: Effects

Status: **Planned** (2026-10-11). Track: viewer. Depends on: 13. Unblocks: 15, 16. Not active.

<!-- File: docs/viewer/stages/14-editor-effects.md -->

## Objective

Add the creative and finishing tools: border effects, frame mask, watermark, bump map, sketch, oil painting, lens and
obscure (blur). Watermark and borders are the most common batch jobs, so they get the most care for relative sizing and
tokens.

## Decisions applied

- ADR-0035: registered operations, draft/final, asset handles for user files (logos, textures, masks).
- ADR-0036 (proposed): batch rules; watermark tokens; relative regions.
- ADR-0027: asset files come from a main-owned native dialog; the sidecar never gets a renderer path.
- ADR-0019: pure Go; text drawing with `golang.org/x/image/font` and `opentype`; fonts embedded or read from the OS font
  folders by main's list (names only to the renderer).
- ADR-0034: watermark defaults and token help text are translated; user text is never translated.
- `docs/viewer/IMAGE-EDITOR.md` §3.2.

## Scope

| Tool | Operation id | Parameters | Class / batch |
|---|---|---|---|
| Border effects | `border` | style (solid, double, inner, outer, bevel, rounded corners, drop shadow, polaroid), width (px or % of the short edge), color(s), opacity, shadow blur/offset, inside/outside (outside grows the canvas) | structural + paint · yes |
| Frame mask | `frameMask` | shape (rounded rectangle, ellipse, circle, vignette, feathered edge, custom PNG mask `assetId`), size/inset %, feather %, invert, background (color / transparent) | per pixel with mask · yes |
| Watermark | `watermark` | kind (text/image `assetId`), text with tokens, font, size (% of short edge), color, opacity, outline/shadow, position (9 points) + margin %, rotation, tiling (spacing, stagger), blend (normal, multiply, screen) | overlay · yes |
| Bump map | `bump` | source (picture luminance / texture `assetId` tiled or stretched), light angle and elevation, height, smoothness, color mix (grayscale relief ↔ colored) | neighborhood · yes |
| Sketch | `sketch` | style (pencil, ink, color pencil), detail, line strength, paper tone, color amount | neighborhood · yes |
| Oil painting | `oil` | brush radius, detail (levels), smoothness | neighborhood, heavy · yes |
| Lens | `lens` | mode (magnify/bulge, pinch, barrel/pincushion), amount, center (normalized), radius (%), edge softness | remap · param (center relative) |
| Obscure | `obscure` | method (gaussian blur, pixelate, mosaic), strength, shape (rectangle/ellipse/freehand polygon, normalized), feather | masked neighborhood · param (fixed relative region only) |

### Behavior details

- **Border:** all sizes are percentages of the shortest edge when batched (px allowed interactively and converted when
  a recipe is saved, with a visible note). `outside` styles grow the canvas and update `OutputSize`.
- **Frame mask:** the mask is computed analytically at the working resolution (no mask bitmap for built-in shapes);
  custom masks are resampled and thresholded/feathered. Transparent backgrounds switch the save suggestion to PNG.
- **Watermark:** text is laid out by the pure-Go font stack. Simple left-to-right scripts, Cyrillic and CJK (with a
  bundled or system CJK font) are supported; complex shaping (Arabic, Indic) is **not** guaranteed and the font picker
  shows a note — the app's eight interface languages do not require it, user text might. Position and size are
  relative so the same recipe fits any picture. Tokens (`{name}`, `{date}`, `{exif.model}`, …) expand per picture; in
  the single-image editor they expand for this picture and show their value.
- **Bump map:** a height field from the luminance (or a texture) and a Lambertian light, written as a blend over the
  picture; light direction handle on the canvas, also operable with arrows.
- **Sketch / oil:** deterministic algorithms (no random seed unless fixed). Oil uses an intensity-bin (Kuwahara-family)
  filter with a summed-table per bin so cost does not grow with radius quadratically; draft mode at ¼ pixels.
- **Lens:** inverse mapping with bicubic sampling; the center is placed by clicking the canvas; radius as a ring
  overlay.
- **Obscure:** region drawn as a rectangle, ellipse or polygon on the canvas, several regions as separate stack
  entries. The result is irreversible once saved. A first-use hint says so, and the Save popover's "Strip metadata"
  suggestion is raised when obscure is in the stack (embedded thumbnails in EXIF can still contain the unblurred
  picture, so metadata thumbnails are always regenerated or dropped when obscure is used; tested).
- All overlays (ring, region, light handle) use non-animated, theme-aware strokes with high contrast against any
  image (a dual-color stroke).
- The tools reuse the Stage 12–13 shell, presets row with live thumbnails, edit stack and keyboard model.

### Asset handles

- A "Choose image…" button asks main for a native file dialog; main validates the file (PNG/JPEG/WebP/GIF, ≤ 16 MB,
  ≤ 8,000 px), registers an `assetId` and gives the renderer name, size and a thumbnail token. The edit list refers to
  `assetId` only. When a recipe is saved the asset is copied to the recipe asset store (Stage 16).

## Non-goals

- Layered compositing, brush-painted masks, blend-mode stacks beyond the three listed, text on a path, emoji color
  fonts, SVG logos, animated watermarks, face/plate auto-detection for obscure (AI is out of scope, BRS §10).
- Complex-script text shaping (documented limit).
- Batch UI (Stage 16); this stage specifies and tests the batch behavior.

## Implementation tasks

- [ ] Go: border/frame painters (anti-aliased shapes, shadow via separable blur), mask rendering, `OutputSize` for
  structural borders.
- [ ] Go: font loading and text rendering (`opentype` faces, cache by font+size), watermark compositor with opacity,
  outline, shadow, rotation, tiling, blend modes; token expander (shared with Stage 16's name templates).
- [ ] Go: bump, sketch, oil, lens (inverse mapping), obscure (masked blur/pixelate/mosaic, region polygon rasterizer).
- [ ] Go: metadata thumbnail handling when `obscure` is present.
- [ ] Main: asset handles (dialog, validation, thumbnail token, lifetime), font list provider.
- [ ] Contracts, validation (regions/polygons ≤ 256 points, text ≤ 1,000 chars), golden fixtures.
- [ ] Renderer: panels, on-canvas overlays (region, ring, light handle, watermark position drag + 9-point grid),
  token chips and live token preview, font picker (virtualized), asset picker, presets.
- [ ] Mark `Batchable`, relative-unit conversion, and token support; list in the Stage 16 hand-off table.
- [ ] Tests, benchmarks, docs, `t()` strings.

## APIs/contracts

New main method `asset.pick { kind: "image" }` → `{ assetId, name, width, height, thumbUrl }` (viewer profile) and
`asset.release { assetId }`. `edit.fonts` → `{ families: string[] }` (names only). Operation schemas as above.

## Tests

- Go golden images per tool and style, relative-size determinism (the same recipe on 800×600 and 4000×3000 gives
  proportional output within 1 px), token expansion table tests, text rendering fixtures (Latin, Cyrillic, CJK, with
  and without outline), mask/feather monotonicity, lens center/radius edge cases (center outside the picture), obscure
  region fully outside/partial, thumbnail-leak test (output EXIF thumbnail contains no unblurred data), bump light
  angle symmetry, oil/sketch determinism across worker counts, cancel.
- Main: asset validation (wrong type, huge, symlink, missing), lifetime, commander cannot call `asset.*`.
- Renderer: overlay keyboard control, watermark drag, token preview, undo/redo, strings via `t()`.
- E2E: add watermark with a token and a logo, set border + frame, obscure a region and verify those pixels differ from
  the source and the region outside is unchanged, save and reopen.

## Benchmarks

`BENCH_STAGE=14`. Proposed budgets:

| Case | Budget |
|---|---|
| Border / frame mask / watermark on 2 MP proxy | < 30 ms |
| Bump / sketch on 2 MP proxy | < 100 ms |
| Oil painting r=4, 2 MP proxy, final / draft | < 800 ms / < 120 ms |
| Lens, 2 MP proxy | < 60 ms |
| Obscure gaussian, region 25 % of 2 MP | < 40 ms |
| Watermark text layout + draw (cached face) | < 5 ms |
| Full-res 24 MP: watermark + border / oil / sketch | < 400 ms / < 4 s / < 1.5 s |

Allocation counts per op and font-cache hit rate are recorded.

## Acceptance criteria

- All eight tools render within budget and match between proxy and saved output.
- Watermark and border recipes are resolution independent; tokens expand correctly.
- Obscure does not leak the original through metadata thumbnails.
- Asset files never reach the sidecar from the renderer; the commander cannot use the asset methods.

## Risks

| Risk | Mitigation |
|---|---|
| Pure-Go text shaping limits for complex scripts | documented limit; font note; revisit by ADR if users need it |
| Oil painting cost | integral-histogram bins, draft mode, tile parallelism, benchmark gate |
| EXIF thumbnail leak after obscure | always drop/regenerate thumbnails; regression test |
| Fonts differ per OS (previews vs. batch machine) | bundle two default families; recipe stores family name + fallback |
| Asset handle misuse | main-owned dialog, type sniffing, size cap, release on session close |

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed (both apps when platform code changed)
- [ ] docs/ADR updated
