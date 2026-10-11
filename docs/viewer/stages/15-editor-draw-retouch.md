# Stage 15 — Image Editor: Draw and Retouch

Status: **Planned** (2026-10-11). Track: viewer. Depends on: 12 (13 and 14 are not required, but the shell, stack and
overlays they mature are reused). Unblocks: 16 (red-eye auto mode only). Not active.

<!-- File: docs/viewer/stages/15-editor-draw-retouch.md -->

## Objective

Add the tools where the user points at pixels: draw, clone and heal, and red-eye remover. These are interactive by
nature, so the stage is about pointer handling, stroke latency and replayable operations, not about batch.

## Decisions applied

- ADR-0035: strokes are operations with normalized coordinates, so they replay at any resolution and undo is a list
  snapshot; no pixel history.
- ADR-0036 (proposed): draw, clone and heal are **not batchable**; red-eye is batchable only through auto-detect, and
  only if the detector meets its quality gate in this stage.
- ADR-0014: motion and cursors; ADR-0034: strings. Pure Go (ADR-0019).
- `docs/viewer/IMAGE-EDITOR.md` §3.4.

## Scope

| Tool | Operation id | What it does |
|---|---|---|
| Draw | `draw` | brush, eraser, line, arrow, rectangle, ellipse, text, flood fill; color (with eyedropper), size, hardness, opacity; shift constrains lines/shapes; each finished stroke or shape is one stack entry (grouped under one "Draw" header) |
| Clone | `clone` | clone stamp: Alt/Ctrl+click sets the source, painting copies from the moving source; aligned or fixed source; size, hardness, opacity; source cross-hair overlay |
| Heal | `heal` | heal brush (clone with tone and texture blending at the edges) and **spot heal** (click or paint a blemish, source chosen automatically from nearby clean texture) |
| Red-eye | `redeye` | click an eye or drag a box/ellipse; pupil detected inside, red replaced by a darkened, slightly desaturated tone keeping the catchlight; strength and pupil-size sliders; **Auto** finds red pupils in the picture and applies them |

### Operation model

- A stroke is `{ tool, params, points: [x, y, pressure?][] }` with points normalized to the image at that step and
  simplified (Ramer–Douglas–Peucker at ¼ proxy pixel) so a long stroke stays small (≤ 100k points per edit list).
- Rendering a stroke list is deterministic: brush dabs are stamped at fixed spacing along the polyline, in order.
- **Live feedback:** while the pointer is down, strokes are drawn by Go into the proxy incrementally (only the dab
  bounding boxes are re-rendered; the rest of the cached frame is reused), batched at the frame rate, with the cursor
  circle drawn by the renderer (so the cursor never waits for Go). The final stroke is committed on pointer up as one
  operation.
- Clone/heal read from the pixels *as they were before the stroke began* (snapshot of the prefix result), so
  overlapping strokes do not smear themselves.

### Heal algorithm

- Stage spike decides between (a) gradient-domain (Poisson/seamless clone with a multigrid or FFT-free Gauss–Seidel
  solver on the masked region) and (b) patch-based fill (PatchMatch) for spot heal. Proposed default: (a) for the heal
  brush (bounded region, cheap, predictable), PatchMatch-lite for spot heal with a bounded patch search window and a
  fixed seed. Both deterministic. Quality is judged on a committed set of blemish/dust/scratch fixtures with a
  reference result and a perceptual-difference bound; the chosen method and its numbers are recorded in this stage
  document.
- The healing region is limited to 2,048×2,048 px per stroke at final quality (larger strokes are split), to bound
  time and memory.

### Red-eye

- Detection inside the user's box: candidate pixels where `R > 1.8 × max(G, B)` and `R` above a level threshold in
  linear light, grown to a connected region, filtered by size, circularity and fill ratio, then the most plausible
  blob per eye. Replacement lowers the red channel toward `(G + B) / 2` with a smooth falloff and a slight darkening,
  preserving specular highlights (pixels brighter than a threshold in all channels are untouched).
- **Auto mode:** scans the picture at proxy resolution for pairs of near-equal red blobs satisfying the same tests;
  reports "N eyes fixed" or "No red eyes found". Ships to batch only if the committed test set (positives, negatives
  such as red lips, red clothing, taillights, sunsets) shows ≥ 90 % true positives and ≤ 2 % false positives per
  picture; otherwise Auto remains interactive-only and Stage 16 omits it.

### UX

- Cursor: a size/hardness circle that scales with zoom; dual-color outline; `[` and `]` change size, `Shift+[`/`]`
  hardness, number keys opacity (as in common editors, remappable).
- Canvas zoom stays fully usable while a tool is active (wheel, space+drag to pan, `Ctrl/Cmd+wheel` zoom). Minimum
  tool precision stays one screen pixel at any zoom.
- Pressure from pen/touch is supported when the pointer reports it (`PointerEvent.pressure`); mouse uses constant 0.5.
- Color picker: swatches, recent colors, hex, HSB, eyedropper with loupe; shared with watermark and border colors.
- Text: placed on the canvas, edited in place with a floating toolbar (font, size, color, bold-weight where the family
  has it); rendering by the Stage 14 font stack.
- Draw/clone/heal show an `Undo` affordance (the whole stack's undo applies per stroke), an `Eraser` that removes
  parts of **draw** strokes only (non-destructive for the rest), and a clear "Flatten" explanation (strokes become
  pixels on save, never before).
- Keyboard: draw and clone are pointer tools; the keyboard path offers shape tools by numeric entry (position, size),
  a "Heal at cursor"/"Fix red eye at cursor" command driven by arrow-key cursor movement over the canvas, and
  undo/redo/clear. This covers the accessibility baseline: every result achievable by pointer is achievable with
  numeric input for shapes, fills, text and red-eye; free-hand strokes are explicitly pointer-only, and said so in
  the tool's help.

## Non-goals

- Layers, masks, smart objects, liquify, perspective/warp transforms, healing via AI, pressure curves editor,
  stroke stabilization beyond a simple smoothing slider, shape editing after commit beyond delete/re-draw.
- Batch for draw/clone/heal.

## Implementation tasks

- [ ] Spike: heal method comparison on the fixture set; record the decision here.
- [ ] Go: brush engine (dab stamping with hardness falloff, opacity accumulation rules, eraser), shapes (anti-aliased
  line/arrow/rect/ellipse), flood fill (scanline, tolerance), text (Stage 14 font stack), stroke simplification.
- [ ] Go: incremental stroke rendering into the cached frame; snapshot-before-stroke for clone/heal.
- [ ] Go: clone, heal (solver + masks), spot-heal source selection, region limits.
- [ ] Go: red-eye detection and replacement; Auto scanner; fixtures and metrics tool in `src/shared/bench`.
- [ ] Contracts, validation (point caps, region sizes), golden fixtures.
- [ ] Renderer: pointer pipeline (coalesced events via `getCoalescedEvents`, rAF batching, no React render per
  point), cursor overlay, tool options, color picker, text editing overlay, keyboard-numeric paths.
- [ ] Stack: grouping of strokes under one header, per-stroke delete, memory guard on huge lists.
- [ ] Tests, benchmarks, docs, `t()` strings.

## APIs/contracts

No new methods. A new optional render parameter `edit.render { …, live?: { opId, appendedPoints } }` lets the renderer
send only the points added since the last frame while a stroke is in progress (the committed list is sent on pointer
up). The result is a normal frame. Operation schemas as above; limits: ≤ 100k points per list, ≤ 512 operations.

## Tests

- Go: brush dab spacing/hardness golden images, determinism of replays on proxy and full size (difference bound),
  eraser only affects draw strokes, flood fill tolerance, clone aligned/fixed offsets, clone of overlapping strokes
  does not self-smear, heal fixtures within the perceptual bound, spot-heal on dust/scratch fixtures, red-eye
  detection metrics (precision/recall on the committed set), highlight preservation, region limit splitting,
  cancellation, stroke simplification error bound.
- Renderer: pointer batching (N pointer events → ≤ 1 render per frame), cursor never waits on Go, undo per stroke,
  keyboard-numeric shape path, color picker accessibility, strings via `t()`.
- E2E: draw a line and a text, clone a patch, heal a blemish fixture, red-eye click and Auto, save and compare probe
  pixels; undo/redo through all of them; pen pressure simulated through synthetic pointer events.

## Benchmarks

`BENCH_STAGE=15`. Proposed budgets:

| Case | Budget |
|---|---|
| Pointer move → stroke visible (brush 50 px, 2 MP proxy) | p95 < 33 ms |
| Cursor overlay latency (renderer only) | one frame |
| Clone dab batch (per frame) | < 8 ms |
| Heal brush region 256×256 | < 120 ms |
| Spot heal region 128×128 | < 250 ms |
| Red-eye click, 24 MP source | < 150 ms |
| Red-eye Auto scan, 2 MP proxy | < 600 ms |
| Replay of 5,000-point stroke list at full resolution 24 MP | < 800 ms |

Plus renderer long-task count during continuous drawing (none > 50 ms) and heap growth per 1,000 strokes.

## Acceptance criteria

- Strokes feel immediate (cursor and ink) at any zoom; undo/redo is exact; replay at save equals the preview within
  the documented resampling bound.
- Heal and spot heal meet the recorded fixture quality bound; red-eye meets its detection gate or Auto stays
  interactive-only (recorded decision).
- Every non-freehand result has a keyboard path; free-hand limitations are stated in the UI.

## Risks

| Risk | Mitigation |
|---|---|
| Stroke latency through IPC + Go | incremental dab rendering, cursor in renderer, appended-points protocol, coalescing |
| Heal quality in pure Go | spike, fixture bound, region cap, "Clone" remains the fallback tool |
| Large stroke lists bloat messages | simplification, caps, send deltas while drawing |
| Auto red-eye false positives | quality gate, interactive-only fallback, report of what was changed |
| Accessibility gap for free-hand tools | numeric/shape alternatives, explicit documentation |

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed (both apps when platform code changed)
- [ ] docs/ADR updated
