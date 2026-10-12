# Stage 13 — Image Editor: Color Tools

Status: **Implementation done** (2026-10-12). Track: viewer. Depends on: 12. Unblocks: 14, 16 (their batch wiring uses
these operations). Open items are listed under "Open".

<!-- File: docs/viewer/stages/13-editor-color.md -->

## Objective

Add every "color changing" tool to the editor shell with a UX that makes photographic corrections quick: lighting,
colors, levels, curves, sharpen/blur, noise reduction, swap color, reduce colors, count colors, grayscale, sepia and
negative. All run through the Stage 12 session and render pipeline and are written batch-ready.

## Decisions applied

- ADR-0035 (accepted in Stage 12; "Decided in Stage 13" added): registered operations, fusion, draft/final,
  determinism, prefix cache.
- ADR-0036 (proposed, Stage 16): operations are flagged `Batchable` and use relative units, auto variants where the result
  depends on the picture.
- ADR-0027 (amended): the three new renderer methods are in the viewer's profile only.
- ADR-0019: pure Go. ADR-0014: controls and motion. ADR-0034: strings.
- `docs/viewer/IMAGE-EDITOR.md` §3.1.

## Scope as built

| Tool | Operation id | Parameters | Class |
|---|---|---|---|
| Lighting | `lighting` | exposure (EV ±3), brightness, contrast, gamma, highlights, shadows, whites, blacks; **Auto enhance** button | point (fused) |
| Colors | `colors` | saturation, vibrance, hue, temperature, tint, color balance (shadows, midtones, highlights × RGB) | point (fused) |
| Levels | `levels` | per channel (all, R, G, B): input black, white, gamma, output black, white; eyedroppers (black, gray, white); **Auto** with a clip percentage, per channel or by brightness; an `auto` variant for batch | point (table) |
| Curves | `curves` | per channel (all, R, G, B): 2–16 control points → monotone cubic (PCHIP) → 256 values; six presets | point (table) |
| Sharpen | `sharpen` | unsharp mask: amount (0–500 %), radius (0.1–20 px of the full picture), threshold | neighborhood |
| Blur | `blur` | Gaussian, box, motion (angle, length); radius 0–100 px of the full picture | neighborhood |
| Reduce noise | `denoise` | luminance, color, keep detail; fast (edge-preserving bilateral) or high quality (non-local means) | neighborhood, heavy |
| Replace color | `replaceColor` | from (eyedropper), to, tolerance, softness, keep the shading | point + mask |
| Swap channels | `swapChannels` | the order red, green and blue are taken from (five permutations) | point |
| Reduce colors | `reduceColors` | 2–256 colors; palette: fitted (median cut, octree), web (216), gray levels; dithering: none, Floyd–Steinberg, ordered 4×4 and 8×8; keep transparency | global |
| Count colors | *(read-only, `edit.colors`)* | exact number of distinct colors; the 32 most common with their share; copy one or the list | analysis |
| Grayscale | `grayscale` | luminance (Rec. 709), average, desaturate, channel mixer | point |
| Sepia | `sepia` | strength, tone (cool to warm) | point |
| Negative | `negative` | any of the three channels; alpha untouched | point |
| Looks | *(ordinary operations)* | twelve presets, each shown on the current picture | — |

### Pipeline (Go, `src/shared/sidecar/internal/imaging`)

- `point.go`: a point operation yields stages (a table per channel, a 3×3 matrix with offsets, or a function);
  consecutive point operations run as **one pass** over the picture, and adjacent tables are folded into one. A
  folded stage that changes nothing is dropped, so identity parameters leave the pixels byte-identical.
- `color.go`: the nine point operations, PCHIP curves, levels and `AutoLevels` (percentile clipping per channel or
  for all together, optional midtone centring).
- `filters.go`: Gaussian blur as three box passes with running sums (cost independent of the radius), box and
  motion blur, unsharp mask, bilateral filter (5×5; 7×7 above luminance 50 in a final frame) and non-local means
  (a smaller search window in a draft). Radii are in pixels of the full picture and scaled to the working size, so
  the preview and the saved file agree.
- `quantize.go`: median cut, octree, web and gray palettes; Floyd–Steinberg and ordered dithering; the exact color
  count (a 2²⁴-bit set: 2 MB, one pass); the dominant palette. A picture of at most 256 colors is written as an
  **indexed** PNG or GIF.
- Every operation is `Batchable`, deterministic for any worker count and cancellable between row bands.
- Pixels stay `image.RGBA` (premultiplied) as in Stage 12; a point pass un-multiplies only pixels that are partly
  transparent. Fused and sequential results are identical for opaque pixels; partly transparent ones may differ by
  rounding (the test allows 8 levels of 255 at low alpha).

### Session and API

- `edit.render` takes `histogramAt: n`: the histogram of the picture after `n` active operations comes back as
  `before`. Levels and Curves draw it, so the user sees what the tool is given, not its own result.
- **New methods** (the stage plan named only `edit.colors`; two more were needed to keep pixels out of the renderer):
  - `edit.colors { sessionId, editList, scope: "preview" | "edited" | "original", maxColors }` →
    `{ distinct, palette: { hex, share }[], hasAlpha, width, height }`. `preview` counts the proxy as rendered
    (fast, for the Reduce colors palette); `edited` and `original` decode the source again and are exact.
  - `edit.probe { sessionId, editList, view, x, y, radius }` → `{ rgba, hex }`: the average color around a point.
    The eyedroppers and the loupe use it; the renderer never reads a pixel.
  - `edit.thumbs { sessionId, editLists (≤ 16), edge (≤ 256) }` → token URLs of small renderings, one request for
    all looks. Main answers it through the main-only sidecar method `edit.thumbFrames`.
- All three are in the viewer's profile only; main validates the edit lists like those of `edit.render`.

### UX as built

- **Tool rail = groups:** Adjust, Color, Detail, Geometry, Looks (roving focus; keys A, C, D, G, L in the editor
  scope of the keymap). The right panel lists the group's tools as headers; one tool is open at a time, with its
  options under its header and the same on/off switch its entry has in the edit stack. `/` still finds any tool.
- A tool with a neutral state (Lighting, Levels, Sharpen, …) adds its operation with the first change. A tool
  without one (Grayscale, Sepia, Negative, Swap channels, Reduce colors) is chosen by opening it.
- **Levels:** the histogram of the incoming picture with the black and white points marked, sliders with number
  fields for the five values, a channel selector, three eyedroppers, Auto with a clip percentage and a choice
  between "each channel" (also removes a cast) and "brightness".
- **Curves:** a canvas with the grid, the incoming histogram and the curve; the control points are buttons over
  it. Click adds a point (and drags it), drag moves, arrow keys nudge (Shift: by ten), Delete removes, Tab walks
  the points, Input and Output number fields edit the selected point; channel tabs, a preset select, reset. A drag
  is coalesced to one store update per frame and is one undo step.
- **Auto enhance** (in Lighting) adds a Levels step fitted to the picture: ordinary values that can be tuned.
- **Eyedroppers** put a crosshair over the picture and a loupe beside the pointer: 11 × 11 pixels of the frame on
  screen at 8×, and the hex and RGB values Go reads (a 5 × 5 average of what the tool is given). Arrow keys move
  the point, Enter takes the color, Esc cancels; the focus returns to the button that started it.
- **Looks:** twelve presets (black and white, sepia, negative, vivid, warm, cool, faded, …) as thumbnails of the
  current picture from one batched request; a click adds the look's operations as one undo step.
- **Reduce colors** switches the save format to PNG (with a notice), shows the palette of the preview on request
  and says whether the chosen save format keeps the palette.
- **Count colors** is the third Info tab: edited picture or original, a button, a progress line, the count and the
  most common colors. It never runs by itself; an answer for the edited picture is marked old after an edit.
- Undo and redo: when a redo brings back the operation an open panel was editing, the panel edits it again.
- 159 new strings, translated into the seven other languages.

### Batch behavior (hand-off to Stage 16)

| Operation | In batch |
|---|---|
| `lighting`, `colors`, `curves`, `grayscale`, `sepia`, `negative`, `swapChannels`, `replaceColor` | the same parameters for every picture |
| `levels` | numeric values, or `auto { clip, mode, gamma }`: Go fits the range to each picture |
| `sharpen`, `blur`, `denoise` | radii are in pixels of each full picture; no proxy involved |
| `reduceColors` | the palette is fitted per picture (median cut, octree) or fixed (web, gray) |
| Count colors | a report (`edit.colors` per picture), not a changed file |

## Non-goals

- Curves/levels in 16-bit, ICC conversion, camera profiles, HSL targeted adjustments (per-hue sliders) and masks
  painted by brush (possible later), HDR tone mapping, LUT (.cube) import.
- Batch UI (Stage 16) — but each operation's batch behavior is specified and tested here.

## Implementation tasks

- [x] Go: table builders and fusion (`internal/imaging/point.go`), PCHIP curves, levels, lighting, colors,
  grayscale/sepia/negative; unit tests for exact table values.
- [x] Go: Gaussian by box passes, box, motion, unsharp mask, bilateral, non-local means, median-cut/octree
  quantizers, dithering, color replace with a soft mask.
- [x] Go: `edit.colors` (exact count with a 2²⁴ bitset, dominant palette), `edit.probe`, `edit.thumbFrames`,
  the before-histogram, cancellation.
- [x] Go: auto levels (percentile clipping, per channel), tested with known histograms; mirrored in TypeScript
  (`features/editor/tone.ts`) so the Auto buttons write ordinary values.
- [x] Contracts + main validation for each operation's parameters, golden fixtures.
- [x] Renderer: tool groups, a panel per tool, curves and levels widgets, looks, eyedropper + loupe, Count colors
  tab, edit-stack integration.
- [x] Every operation `Batchable`; the hand-off table above.
- [x] `t()` strings in eight languages; keymap actions for the five tool groups.
- [x] Docs: IMAGE-EDITOR.md, FEATURE-MATRIX, PERFORMANCE, UX-DESIGN, DOMAIN-API, DESIGN-SYSTEM, ADR-0035, ADR-0027.

## Tests

- Go (`internal/imaging/color_test.go`, `internal/editor/analysis_test.go`, `internal/app/editor_test.go`): about
  28 golden cases (SHA-256 of the pixels) across the tools; identity parameters leave the picture byte-identical;
  fused equals sequential; exact table values; PCHIP monotone and through its points; auto levels on known
  histograms; replace color with tolerance; denoise improves PSNR on a noisy fixture; quantizer palette size and
  error; dithering deterministic; the exact count against a map on random pictures; invalid parameters refused;
  cancellation; the same result for 1 and 8 workers; probe, thumbnails, the before-histogram and the three count
  scopes over RPC.
- Contracts and desktop: parameter validation of every operation and of the three methods; the capability profile.
- Renderer (`components/editor/color.test.tsx`, `features/editor/tone.test.ts`, 45 tests): each tool writes one
  operation and undoes and redoes; the group rail and its keys; levels (incoming histogram, limits, Auto);
  eyedropper by pointer and by keyboard with the loupe's values; curves by pointer and by keyboard alone; looks
  from one batched request; Reduce colors and the PNG suggestion; Count colors and its stale state; no pixel data
  in state.
- E2E (`src/shared/e2e/specs/viewer/editor-color.spec.ts`): on a gray ramp written by the test, levels and a curve
  edited by keyboard change the histogram's clipping and the pixels of the saved BMP match the formula at nine
  columns; the loupe reads the ramp; 16,384 colors are counted exactly, reduced, counted again and saved as an
  indexed PNG whose palette and used entries match the count; a 24 MP picture follows six color sliders.

## Benchmarks

`BENCH_STAGE=13 pnpm bench:edit` (now with a `color` block per size) and
`BENCH_LARGE=1 go test ./internal/imaging -bench ColorTools`. Reference machine (i9-13900K, 8 workers). Results:
`src/shared/bench/results/stage-13-*`.

| Case | Budget | Measured |
|---|---|---|
| Fused point chain, 2 MP | < 12 ms | 9.9–10.8 ms (one table: 2.2–2.7 ms) |
| Gaussian blur r=10 / unsharp, 2 MP | < 60 ms | 19–23 ms / 22–26 ms |
| Bilateral denoise, 2 MP, final / draft | < 400 ms / < 80 ms | 52–105 ms / 68–73 ms |
| Non-local means, 2 MP, final / draft | < 1.5 s / < 150 ms | 254 ms / 130 ms |
| Median cut to 256 colors + dither, 2 MP | < 400 ms | 55–132 ms |
| Exact color count, 24 MP | < 400 ms | 155–174 ms |
| Full-resolution fused chain / unsharp / bilateral, 24 MP | < 250 ms / < 1.2 s / < 5 s | 101 ms / 210 ms / 1.06 s |

The 2 MP cases vary between runs on this hybrid CPU (two result files); every run is within budget.

In a session (24 MP source, 1,600 px canvas; 50 and 100 MP are within 3 % because the session works on its proxy):

| Case | p95 |
|---|---|
| Dragged control, draft frame: point chain / levels with the incoming histogram / sharpen / blur / denoise | 29 / 30 / 36 / 42 / 65 ms |
| Dragged control, denoise in high quality | 110 ms |
| Full frame at rest: point chain / sharpen / denoise / denoise high / 256 colors with dither | 52 / 55 / 98 / 281 / 137 ms |
| Color under the pointer (`edit.probe`) | 1 ms |
| Twelve look thumbnails | 16 ms |
| Count colors: preview / full picture (decodes the source) | 63 ms / 0.56 s (1.2 s at 50 MP, 2.3 s at 100 MP) |
| Save 24 MP: tone + curves + unsharp (JPEG) / with denoise / 256 colors (indexed PNG) | 1.30 s / 1.78 s / 1.71 s |

In the app (e2e, 24 MP, six operations in the list): the time between frames while a slider is dragged is 37–51 ms
at p95 for contrast, saturation, levels, sharpen, blur and denoise (budget 80 ms), one frame per pointer move, no long
task over 50 ms; the twelve looks are painted 66 ms after the group is chosen. The Stage 12 measurements were run
again with the new rail and are unchanged (open 0.21 s, rotate drag 37–40 ms, save 0.88 s, session 72 MB).

Allocations: a point pass makes one output buffer (not in place: the input may be a cached checkpoint), a
neighborhood filter two.

Known, for Stage P05: with a neighborhood operation a 100 MP save peaks at 1.2 GB of heap (24 MP: 339 MB), and an
exact count of 100 MP at 972 MB; the high-quality noise filter's draft (110 ms) is over the 80 ms frame budget, which
is why "fast" is the default.

## Acceptance criteria

- [x] All tools behave as specified, live-preview within budget, and match between proxy and saved output
  (radius-based tools within the scaling of the proxy; see Open).
- [x] Identity parameters never change pixels; every tool is undoable; operations can be reordered in the stack.
- [x] Count colors is exact; Reduce colors gives an indexed save with the counted palette.
- [x] Every tool is keyboard-operable and has a documented batch behavior.

## Open

- **A full-resolution view of a region** (open since Stage 12): beyond the proxy's resolution the canvas still shows
  the proxy's pixels, so a fine sharpening radius on a large picture looks weaker in the preview than in the saved
  file. The Sharpen panel says so. It needs the source in memory or a region decode; decide with Stage P05.
- Not built from the plan: the zebra overlay and the before/after split (Reduce colors uses the Before button); the
  three-handle slider on the levels histogram (sliders with marks instead); the pixel under the pointer shown on the
  curve; the mask that highlights what Replace color matches; the order hint in the edit stack; Sharpen's
  "edge-only" option (the threshold does that job); Resize's "sharpen after" (add Sharpen after Resize).
- The eyedroppers sample what the tool is given (the operations before it), not the untouched source.
- "Swap color" was delivered in both meanings (Replace color, Swap channels); the wording was not confirmed with
  the owner beforehand.
- A key per tool: there are keys for the five groups and the tool search; single tools have none.
- The NVDA pass over the new panels; the Linux and macOS runs and the race detector (CI).

## Risks (as they turned out)

| Risk | Outcome |
|---|---|
| Non-local means too slow in pure Go | 254 ms for a 2 MP final frame, 2.7 s for 24 MP at save; offered as "High quality", bilateral is the default |
| Proxy and final disagree for radius-based tools | radii are scaled by the working size; the remaining gap is the missing full-resolution view (Open) |
| Curves/levels rounding visible as banding | adjacent tables are folded into one; no dithering added |
| UI churn from drag events | one store update per frame in the curves widget, the loupe moves without React state; no long task measured |

## Exit checklist

- [x] implementation complete (see Open)
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed (viewer and commander: unit suites, the Stage 12 editor e2e, the commander
  e2e suite: 39 of 44 pass; the three `viewers.spec.ts` tests failed before this stage, and two scroll tests in
  `tools.spec.ts` assert a scrolled distance that depends on the display's refresh rate, 59 Hz during this run,
  while their budgets held: 77–80 tiles mounted, no long task)
- [x] docs/ADR updated
