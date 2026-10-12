# Stage 15 — Image Editor: Draw and Retouch

Status: **Implementation done** (2026-10-12). Track: viewer. Depends on: 12 (the shell, stack and overlays of 13 and
14 are reused). Unblocks: 16. Open items are listed under "Open".

<!-- File: docs/viewer/stages/15-editor-draw-retouch.md -->

## Objective

Add the tools where the user points at pixels: draw, clone and heal, and red-eye remover. These are interactive by
nature, so the stage is about pointer handling, stroke latency and replayable operations, not about batch.

## Decisions applied

- ADR-0035 ("Decided in Stage 15" added): strokes are operations with normalized coordinates, so they replay at any
  resolution and undo is a list snapshot; no pixel history.
- ADR-0036 (proposed): draw, clone and heal are **not batchable**. **Red-eye Auto stays interactive-only** (decision
  below); Stage 16 omits it.
- ADR-0027 (amended): `edit.eyes` joins the viewer's profile.
- ADR-0014: motion and cursors; ADR-0034: strings. Pure Go (ADR-0019).
- `docs/viewer/IMAGE-EDITOR.md` §3.4.

## Scope as built

| Tool | Operation id | What it does |
|---|---|---|
| Draw | `draw` | one operation is one drawing: a list of strokes. Brush and eraser (size, hardness, opacity, pen pressure), line, arrow, rectangle and ellipse (outlined or filled), text (the Stage 14 fonts and tokens), flood fill (tolerance). Color by well or by eyedropper |
| Clone | `clone` | one operation per stroke: copies from a source that keeps its distance to the brush; size, hardness, opacity |
| Heal | `heal` | one operation per stroke: **spot** finds its own source nearby, **brush** copies from a chosen one; both correct the copy's tone to the stroke's surroundings |
| Red-eye | `redeye` | one operation per eye: the red of the pupil inside a box falls to its green and blue, a little darker; the catchlight stays. Strength and pupil-size settings. **Auto** finds pairs of pupils and adds an operation for each |

### Operation model

- Points are `[x, y]` or `[x, y, pressure]`, 0..1 of the picture at that step, with four decimals; sizes are
  percentages of the shorter edge. A finished stroke is thinned (Ramer–Douglas–Peucker at a quarter of a proxy
  pixel), so a straight drag is two points.
- **A drawing is one operation with a list of strokes** (the plan had one operation per stroke). The strokes are
  painted in order onto a transparent layer that is laid over the picture, so the **eraser removes drawn ink and
  never the picture**, with no pixel history. Each stroke is still one undo step (undo is a list snapshot), and
  the stack shows one "Draw" entry with its stroke count.
- A brush stroke is the set of capsules between its points: every pixel takes the most any capsule covers it, so a
  stroke does not darken where it crosses itself and its opacity is the stroke's. Hardness is the solid part of the
  radius; pressure scales the radius between half and one and a half.
- Clone and heal read their input, the picture before the stroke, so a stroke over its own source does not smear.
- Limits: 2,000 strokes per drawing, 20,000 points per stroke, and an edit list of at most 1 MB as it travels
  (about 60,000 points; the plan said 100,000). The editor refuses a new stroke at 0.9 MB with a message.
- None of the four is `Batchable`.

### Live feedback (measured decision)

The plan was an incremental protocol (`edit.render { live: { opId, appendedPoints } }`, dabs rendered into the
cached frame). Built instead, with no new render parameter:

- **The ink is the renderer's.** The stroke in progress is drawn at once as a path on a canvas over the picture
  (color, width and opacity of the brush), in the task of the pointer event; so is the brush ring. This is a path,
  not picture data. 26 ms at most from the event's timestamp to ink on a 24 MP picture (budget 33 ms).
- **Go's frames follow.** Once per animation frame the stroke as it is goes to Go as an ordinary live edit (the
  newest only); a draft frame comes back every 51 ms at p95 and the full one on release, which replaces the ink.
- **The layer of the strokes before the last is kept** (two layers, proxy sizes only), so a frame paints one
  stroke, not all: a drawing of 50 strokes went from 330 ms to 11 ms for the stroke being drawn. A fill looks at
  the picture and a text token at the file, so nothing is kept from such a stroke on.

### Heal: the method (spike result)

Tone-corrected copy. The difference between the picture and the copied source is taken *around* the stroke
(weighted by how far outside the mask a pixel is), spread smoothly across the stroke by a normalized blur, and
added to the copy: the texture is the source's, the light is the surroundings'. It is linear in the pixels of the
stroke's box, deterministic, and needs no solver. For a spot the source is the best of 48 offsets (16 directions,
three distances): the one whose ring around the stroke looks most like the stroke's own ring.

Fixtures (generated in the test: soft light, grain, a dark blemish; five sizes and places) and bound:

| | Mean error in the blemish, levels of 255 |
|---|---|
| Before | 29.1 |
| Spot heal | 3.6 |
| Heal brush, source in differently lit skin | 3.5 |
| Clone from the same source | 25.6 |

The gate in the test: each fixture ends within 8 levels (the grain is ±6), heal removes at least four fifths of
the error, and the heal brush is at least twice as good as a clone from the same source. A scratch healed by a
stroke along it loses five sixths of its error. A gradient-domain solver and patch search were not needed to
reach this; they remain the options if photographs show seams.

One stroke heals at most 2,048 × 2,048 pixels; a larger one is refused with a message (the plan said split).

### Red-eye: detection and the gate

- Fix: inside the box's ellipse, a pixel counts as retina-red when its red is well above its green and blue
  (from 1.75 times, fully at 2.25) and not dark; pixels bright in every channel (the catchlight) are left alone,
  also after the mask is softened.
- Auto: candidates are pixels with `R > 1.8 × max(G, B)` and `R ≥ 80`; connected blobs are kept when they are
  0.4–8 % of the shorter edge, about as wide as high, and fill their box like a disc; two blobs are a pair of eyes
  when they are of similar size (within 1.7×), 4–18 pupil widths apart and level within about 20°. A single red
  blob is never touched.
- `edit.eyes` returns the pupils of the picture as it is edited; the editor adds an ordinary `redeye` step per
  pupil (one undo for all), so what was found can be seen and removed. The operation also has an `auto` variant
  that detects when it is applied.
- **Gate result:** on the test set the detection finds 138 of 138 pupils in 60 scenes with no extra detection, and
  none of ten negatives (a single light, lips, red clothing, a sunset, two sizes, one above the other, far apart,
  berries, a bar, far red squares). **The set is synthetic** (discs on skin tones): it shows that the rules do what
  they say, not how they fare on photographs. The gate asked for evidence on real pictures, which this stage does
  not have. **Decision: Auto is interactive-only; `redeye` is not batchable and Stage 16 omits it.**

### UX as built

- A seventh group in the rail, **Draw and retouch** (key R): Draw, Clone, Heal, Red-eye.
- The brush is a ring of the brush's size on the picture (white with a black outline), whatever the zoom; `[` and
  `]` change the size in steps that grow with it, `{` and `}` the hardness. Text, fill and red-eye use a
  crosshair.
- Draw: eight tools as a radio grid; Shift keeps a line to 45° steps and a rectangle or ellipse square on screen;
  text and fill by a click; "Remove the last stroke"; a note that strokes become pixels only when saved.
- Clone and the heal brush: Alt (or Ctrl) and a click choose the source, shown by a marker until the first stroke.
- **Keyboard:** the overlay takes the focus; arrow keys move a cross, Enter does what a click does there (a dot, a
  text, a fill, a healed spot, a fixed eye), Alt+Enter sets the source. Every panel has a "By numbers" section:
  shapes by two points, text and fill by one, a clone stamp, a heal, an eye. Free-hand strokes need a pointer, and
  the panel says so.
- 63 new strings, translated into the seven other languages.

## Non-goals

- Layers, masks, smart objects, liquify, perspective/warp transforms, healing via AI, pressure curves editor,
  stroke stabilization beyond a simple smoothing slider, shape editing after commit beyond delete/re-draw.
- Batch for draw/clone/heal.

## Implementation tasks

- [x] Spike: heal method; decision and numbers above.
- [x] Go: brush engine (capsules with hardness, stroke opacity, eraser on the drawing's layer), shapes, flood fill
  (scanline, tolerance), text (Stage 14 fonts), stroke simplification.
- [x] Go: the kept layer for the stroke in progress; clone and heal read the step's input.
- [x] Go: clone, heal (tone-corrected copy, spot source search), region limit.
- [x] Go: red-eye fix and detection; `edit.eyes`.
- [x] Contracts, validation, golden fixtures.
- [x] Renderer: pointer pipeline (coalesced events, one message per frame, no React render per point), brush
  ring, tool options, keyboard and numeric paths.
- [x] Stack: one entry per drawing with its stroke count; the list-size guard.
- [x] Tests, benchmarks, docs, `t()` strings.

## APIs/contracts

One new method, `edit.eyes { sessionId, editList }` → `{ eyes: { x, y, w, h }[] }` (viewer profile). No render
parameter was added. Operations `draw { strokes }`, `clone`, `heal`, `redeye` as above.

## Tests

- Go, `internal/imaging/paint_test.go`: 12 golden cases; brush hardness, opacity, self-crossing, pressure, a dot;
  the eraser removes ink only, within its drawing; shapes, text, fill and its tolerance; **the proxy shows what
  the save writes** (8 lists); the kept layer never changes a result (strokes added one at a time against fresh
  renders); clone copies from before the stroke; the heal fixtures and their bound; a scratch; the region limit;
  red-eye fix (pupil, catchlight, skin, lips, dull red); the detection set; path simplification within its
  tolerance; 29 invalid parameter sets; cancellation. `internal/editor`: eyes found in the edited picture.
- Contracts and desktop: the four operations, list size, `edit.eyes` for the viewer only.
- Renderer, `features/editor/paint.test.ts` and `components/editor/retouch.test.tsx` (24 tests): a drag becomes a
  thinned stroke and one history step; strokes join a drawing; pen pressure; shapes with Shift and by numbers;
  text and fill; the keyboard cross and the size keys; **sixty pointer events in one task ask Go for at most one
  frame**; the list-size guard; the clone source and its offset; heal modes; red-eye by click, box and Auto.
- E2E, `specs/viewer/editor-retouch.spec.ts`: a stroke whose ink is on screen before Go answers, a text, a cloned
  patch, a healed blemish, Auto on a pair of pupils and a click on a single one; undo and redo through all six
  steps; the saved BMP has the brush's color along the stroke, the cloned pixels, skin where the blemish was and
  dark pupils; the rest is untouched. On 24 MP: ink latency, frame pace, no long task.

## Benchmarks

`BENCH_LARGE=1 go test ./internal/imaging -bench DrawAndRetouch` (`imaging-bench.txt` before the kept layer,
`imaging-bench-2.txt` after) and the e2e spec. Results: `src/shared/bench/results/stage-15-*`.

| Case | Budget | Measured |
|---|---|---|
| Pointer move → ink visible, 24 MP in the app | p95 < 33 ms | at most 26 ms (drawn in the event's task) |
| Brush ring | one frame | moved in the pointer handler |
| Go frame while a stroke is drawn, 24 MP in the app | — | 51 ms between frames at p95, no long task |
| Brush stroke 50 px, 2 MP (the operation) | — | 1.6–4.2 ms; the 50th stroke of a drawing 11–12 ms (330 ms before the kept layer) |
| Clone stroke, 2 MP | < 8 ms | 7.5–7.9 ms (8.4–8.7 ms before copies were made in parallel) |
| Heal brush, region 256 × 256 | < 120 ms | 8–10 ms |
| Spot heal, region 128 × 128 | < 250 ms | 7–7.5 ms |
| Red-eye click, 24 MP | < 150 ms | 21–22 ms |
| Red-eye Auto scan, 2 MP | < 600 ms | 9.5–10 ms |
| Replay of a 5,000-point stroke at 24 MP | < 800 ms | 630–650 ms |

Not measured: heap growth per 1,000 strokes (a drawing is bounded by the 1 MB list; the kept layers are two
proxy-size pictures).

## Acceptance criteria

- [x] Strokes feel immediate (ring and ink) at any zoom; undo and redo are exact; a replay at save equals the
  preview within the resampling bound (tested on eight lists).
- [x] Heal and spot heal meet the recorded fixture bound; red-eye Auto stays interactive-only (recorded above).
- [x] Every result that is not a free-hand stroke has a keyboard path; the limitation is stated in the panel.

## Open

- Not built from the plan: a fixed (non-moving) clone source; text edited in place on the canvas with a floating
  toolbar (it is typed in the panel); a color picker with swatches, recent colors and HSB (the color well and the
  eyedropper); number keys for opacity; the size and hardness keys in the keymap (they are fixed keys of the
  overlay); deleting a stroke other than the last; a smoothing slider.
- While a paint tool is open a drag on the picture paints: the picture is moved with the wheel (zoom) but not
  panned by dragging. Space+drag to pan is not built.
- The eraser reaches the strokes of its own drawing only; ink of an earlier Draw entry is pixels to it.
- A spot heal picks its source at the working size, so the proxy and the save may choose differently; both heal.
- Red-eye Auto needs both eyes, level; one eye, or a picture on its side, needs a click.
- Pen pressure is unit-tested; the e2e test uses a mouse.
- The NVDA pass over the new panels and the overlay; the Linux and macOS runs and the race detector (CI).

## Risks (as they turned out)

| Risk | Outcome |
|---|---|
| Stroke latency through IPC + Go | the ink is drawn in the renderer at once; Go follows at 51 ms |
| Heal quality in pure Go | the fixture bound is met by a tone-corrected copy; Clone remains the fallback |
| Large stroke lists bloat messages | simplification, four decimals, the 1 MB list and a guard before it |
| Auto red-eye false positives | pairs only; interactive-only; each found eye is an edit the user sees |
| Accessibility gap for free-hand tools | a keyboard cross with Enter, and numbers for everything but free-hand strokes |

## Exit checklist

- [x] implementation complete (see Open)
- [x] tests complete
- [x] benchmark complete
- [x] performance regression reviewed (viewer and commander unit suites; the four editor e2e specs)
- [x] docs/ADR updated
