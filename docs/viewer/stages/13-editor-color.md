# Stage 13 — Image Editor: Color Tools

Status: **Planned** (2026-10-11). Track: viewer. Depends on: 12. Unblocks: 14, 16 (their batch wiring uses these
operations). Not active.

<!-- File: docs/viewer/stages/13-editor-color.md -->

## Objective

Add every "color changing" tool to the editor shell with a UX that makes photographic corrections quick: lighting,
colors, levels, curves, sharpen/blur, noise reduction, swap color, reduce colors, count colors, grayscale, sepia and
negative. All run through the Stage 12 session and render pipeline and are written batch-ready.

## Decisions applied

- ADR-0035 (accepted in Stage 12): registered operations, fusion, draft/final, determinism, prefix cache.
- ADR-0036 (proposed, Stage 16): operations are flagged `Batchable` and use relative units, auto variants where the result
  depends on the picture.
- ADR-0019: pure Go. ADR-0014: controls and motion. ADR-0034: strings.
- `docs/viewer/IMAGE-EDITOR.md` §3.1.

## Scope

| Tool | Operation id | Parameters (all with defaults that change nothing) | Class |
|---|---|---|---|
| Lighting | `lighting` | exposure (EV ±3), brightness, contrast, gamma, highlights, shadows, whites, blacks; **Auto enhance** button | point (fused LUT) |
| Colors | `colors` | saturation, vibrance, hue shift, temperature, tint, color balance (shadows/mids/highlights, 3×RGB) | point (LUT/matrix) |
| Levels | `levels` | per channel (L, R, G, B): in-black, in-white, gamma, out-black, out-white; eyedroppers (black, gray, white); **Auto levels** (per channel or luminosity, clip %) | point (LUT) |
| Curves | `curves` | per channel (L, R, G, B): control points (2–16) → monotone cubic (PCHIP) → 256-entry LUT; presets (contrast, lighten, darken, cross-process, …) | point (LUT) |
| Sharpen | `sharpen` | unsharp mask: amount, radius (0.1–20 px, proxy-scaled), threshold; edge-only option | neighborhood |
| Blur | `blur` | gaussian, box, motion (angle, length); radius | neighborhood |
| Reduce noise | `denoise` | luminance, color, detail preservation; algorithm: edge-preserving bilateral (fast) and non-local means (quality) | neighborhood, heavy |
| Swap color | `replaceColor` | source color (eyedropper), tolerance, softness, target color, keep-luminance; `swapChannels` permutation (RGB→BGR, …) | point + mask |
| Reduce colors | `reduceColors` | count 2–256, quantizer (median cut default, octree, fixed web, grayscale levels), dithering (none, Floyd–Steinberg, ordered 4×4/8×8), keep transparency | global |
| Count colors | *(read-only, `edit.colors`)* | exact distinct count; dominant palette up to 32 swatches with share; copy hex/list | analysis |
| Grayscale | `grayscale` | method: luminance (Rec. 709), average, desaturate, channel mixer (R/G/B weights) | point |
| Sepia | `sepia` | strength, tone (warm…cool) | point |
| Negative | `negative` | invert color, alpha untouched, optional per channel | point |

### Pipeline rules

- Consecutive point operations fuse into one pass (3 LUTs or one 3×3 + offset); the fusion-equivalence test compares
  fused with sequential output on the fixture set (max difference ≤ 1 level per channel, because of rounding order, and
  exact for LUT-only chains).
- Neighborhood operations scale their radius by the proxy/source ratio so the preview matches the final.
- Heavy tools (non-local means, bilateral at large radius, median-cut with dithering on 24 MP) have a draft mode
  (¼ pixels, fewer search windows) and a final mode; the draft is never saved.
- Operations work on non-premultiplied 8-bit RGBA; alpha is preserved unless the tool says otherwise.
- Histogram, clipping badge and the zebra overlay update with each render. The curves and levels widgets draw the
  histogram of the image **before** the tool (so the user sees what they are adjusting).
- 16-bit input already reduced in Stage 12; no float pipeline.

### UX

- **Adjust panel** groups Lighting, Colors, Levels, Curves as collapsible sections with live values; each section's
  header has an on/off eye and a reset. Sections map to edit-stack entries.
- **Curves widget:** 256×256 canvas with grid and histogram, click adds a point, drag moves, `Delete` removes,
  arrow keys nudge a focused point (`Shift` ×10), `Tab` cycles points, a numeric in/out pair edits the focused point,
  channel tabs (L/R/G/B), presets menu, reset. Cursor shows in/out values; hovering the canvas probes the pixel under
  the pointer and draws its position on the curve.
- **Levels widget:** three-handle slider on the histogram plus numeric fields, channel selector, eyedroppers that
  sample a 5×5 average from the **source** image, Auto button with a clip percentage.
- **Auto enhance** previews instantly and can be tuned afterwards (it writes ordinary Lighting/Levels values into the
  stack, not an opaque operation).
- **Presets with live thumbnails** (Grayscale, Sepia, Negative, a dozen looks) from a small proxy, ≤ 8 renders at a time,
  paused while any slider moves.
- **Reduce colors** shows a before/after split by default, the real palette as swatches, the resulting estimated file
  size (indexed PNG/GIF), and switches the save format suggestion to PNG/GIF.
- **Count colors** is a tab in the Info area: a button, a progress line, then count + palette; it does not run
  automatically. The result is cached for the edit-list revision it was computed for.
- **Swap color:** eyedropper on the canvas, the matched area is highlighted with a marching-ants-free translucent mask
  while the tool is open (no motion), tolerance and softness update live.
- Eyedroppers always show a magnified loupe with the exact RGB/hex under the pointer.

## Non-goals

- Curves/levels in 16-bit, ICC conversion, camera profiles, HSL targeted adjustments (per-hue sliders) and masks
  painted by brush (possible later), HDR tone mapping, LUT (.cube) import.
- Batch UI (Stage 16) — but each operation's batch behavior is specified and tested here.

## Implementation tasks

- [ ] Go: LUT builders and fusion planner (`internal/imaging/point.go`), PCHIP curves, levels, lighting, colors,
  grayscale/sepia/negative; unit tests for exact LUT values.
- [ ] Go: convolution kernels (gaussian separable, box via running sums, motion), unsharp mask, bilateral, non-local
  means (tile-parallel with halos), median-cut/octree quantizers, dithering, color replace with soft mask.
- [ ] Go: `edit.colors` (exact count with a 2²⁴ bitset, dominant palette via the quantizer), cancellation hooks.
- [ ] Go: auto levels/enhance algorithms (percentile clipping, per channel), unit-tested with known histograms.
- [ ] Contracts + main validation for each operation's parameters (ranges, point counts), golden fixtures.
- [ ] Renderer: panels for each tool, slider groups, curves and levels widgets (canvas-based, no per-frame React
  renders; pointer events update the store through `requestAnimationFrame`), presets, eyedropper + loupe, Count colors
  tab, edit-stack integration (enable/disable/reorder rules: point ops commute, neighborhood ops do not — the stack
  shows an order hint).
- [ ] Mark each operation `Batchable` with its auto variants; list them in the Stage 16 hand-off table.
- [ ] `t()` strings and eight languages; keymap actions for opening the tools.
- [ ] Docs: IMAGE-EDITOR.md status, FEATURE-MATRIX, PERFORMANCE results, UX-DESIGN widgets.

## APIs/contracts

No new methods except `edit.colors { sessionId, maxColors?, scope: "edited" | "original" }` →
`{ distinct, palette: { rgba, share }[], hasAlpha }`. Everything else is new operation schemas in the edit list.

## Tests

- Go golden images per tool at default, mid and extreme parameters; identity parameters leave the image byte-identical;
  fusion equivalence; PCHIP monotonicity and endpoint behavior; levels inverse round-trip; quantizer: palette size ≤ N,
  max error bound on the fixture set; dithering deterministic; denoise improves PSNR on noisy fixtures vs. the clean
  source and does not shift mean color; replaceColor tolerance 0 matches only exact; exact color count agrees with a
  naive map on random images; cancellation; deterministic across worker counts.
- Renderer: widget keyboard operation, undo/redo of each tool, presets throttling, loupe values, strings via `t()`.
- E2E: adjust levels and curves on a fixture, check histogram changes, save and verify pixels at probe points;
  Reduce colors to 16 + save PNG and verify indexed output; Count colors on a known image; keyboard-only curves edit.

## Benchmarks

`BENCH_STAGE=13`. Proposed budgets, fixed by the baseline:

| Case | Budget |
|---|---|
| Fused point chain, 2 MP proxy | < 12 ms |
| Gaussian blur r=10 / unsharp, 2 MP proxy | < 60 ms |
| Bilateral denoise, 2 MP proxy, final | < 400 ms; draft < 80 ms |
| Non-local means, 2 MP proxy, final | < 1.5 s; draft < 150 ms |
| Median-cut 256 colors + dither, 2 MP | < 400 ms |
| Exact color count, 24 MP | < 400 ms |
| Full-res fused chain / unsharp / bilateral, 24 MP | < 250 ms / < 1.2 s / < 5 s |

Plus ns/pixel micro-benchmarks, allocations per op (target: one output buffer per neighborhood stage, none for LUT
passes on an in-place working copy), and the Stage 12 interaction budgets re-run with these tools active.

## Acceptance criteria

- All twelve tools behave as specified, live-preview within budget, and match between proxy and saved output.
- Identity parameters never change pixels; every tool is undoable and reorderable per its rule.
- Count colors is exact; Reduce colors gives an indexed save with the displayed palette.
- Every tool is keyboard-operable and has a documented batch behavior.

## Risks

| Risk | Mitigation |
|---|---|
| Non-local means too slow in pure Go | bilateral default, NLM as "High quality" with draft, tile parallelism, escape hatch ADR |
| Proxy and final disagree for radius-based tools | radius scaled by ratio; proxy-vs-final difference test |
| Curves/levels rounding visible as banding | single fused LUT, optional dithering on save of heavy tone changes (measured) |
| "Swap color" ambiguity | both meanings delivered (replace color, swap channels); wording confirmed with the owner before the stage starts |
| UI churn from drag events | store-based updates, rAF coalescing, no React state per pointer move |

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed (both apps when platform code changed)
- [ ] docs/ADR updated
