# Image Editor — Product Spec, Feature Catalogue and UX

Status: **Planned** (2026-10-11), at the owner's request. Stages 12–16 deliver it. It moves "image effects/adjustments",
"crop/resize" and "rotate/flip" out of BRS §9 (future) into FR-23. Architecture: ADR-0035 (editor engine) and ADR-0036
(batch editing), both **proposed** and decided in the stages that name them. Until then nothing here is built on.

This file is the single catalogue of what the editor does, what each tool is called, which stage delivers it and
whether it works in batch. The stage documents (`docs/viewer/stages/12-…` to `16-…`) hold the work breakdown.

## 1. Product statement

> Pressing **Edit** on a picture must feel like the picture is already open in a small, fast photo editor: the first
> frame is there at once, sliders answer while you drag, nothing you do can lose the original, and the same recipe can
> be run over a whole folder.

The editor is part of the viewer (Panelyth), not a new app. It adds no network, no accounts and no cloud.

## 2. Entry points

| Where | What |
|---|---|
| Focused viewer toolbar | **Edit** button (pencil icon, label "Edit"), shortcut `E` (remappable, ADR-0022 action `viewer.edit`) |
| Preview pane toolbar and tile context menu | "Edit…" for one image |
| Tile view with several images selected (batch bar, context menu) | "Edit N pictures…" opens the batch editor (Stage 16) |
| Commander's media overlay | Edit switches to the viewer app with the picture (`app.switch`, APP-SWITCHING) and opens the editor there. Commander's capability profile gains nothing (ADR-0027) |
| Videos, folders, unsupported formats | no Edit button; the tooltip of a disabled button says why |

Close: `Esc` or the Close button. With unsaved changes a three-way prompt appears: Save, Don't save, Cancel (Cancel
has the focus).

## 3. Feature catalogue

Stage column: 12 = foundation and geometry, 13 = color, 14 = effects, 15 = draw and retouch, 16 = batch.
Batch column: **yes** = fully, **param** = yes, but the interactive choice (a position) is replaced by a rule
(anchor, relative region, auto-detect), **report** = batch produces a table instead of changed pictures, **no** =
needs a human to point at pixels.

### 3.1 Color changing

| Feature | What it does | Stage | Batch |
|---|---|---|---|
| Adjust lighting | exposure, brightness, contrast, gamma, highlights, shadows, whites, blacks, auto-enhance | 13 | yes |
| Adjust colors | saturation, vibrance, hue, temperature, tint, color balance (shadows, midtones, highlights) | 13 | yes |
| Adjust levels | input black/white/gamma and output black/white, per channel or luminosity, eyedroppers, auto levels | 13 | yes (numeric or auto) |
| Adjust curves | spline curve per channel or luminosity, points by mouse, keyboard or number, presets, histogram behind the curve | 13 | yes (presets and stored curves) |
| Sharpen / blur | unsharp mask (amount, radius, threshold), gaussian blur, box blur, motion blur | 13 | yes |
| Reduce noise | luminance and color noise, detail preservation | 13 | yes |
| Swap color | **replace color** (pick a color, tolerance, softness, new color, keep luminance) and **swap channels** (R↔B etc.) | 13 | yes |
| Reduce colors | 2…256 colors, quantizer (median cut, octree, fixed web/grayscale palettes), dithering (none, Floyd–Steinberg, ordered); indexed PNG/GIF on save | 13 | yes |
| Count colors | number of distinct colors, dominant palette with shares, copy as hex | 13 | report (CSV) |
| Grayscale | luma weights or channel mixer | 13 | yes |
| Sepia | strength and tone | 13 | yes |
| Negative | invert color, alpha kept | 13 | yes |

### 3.2 Effects

| Feature | What it does | Stage | Batch |
|---|---|---|---|
| Border effects | solid, double, inner/outer, bevel, rounded corners, drop shadow, polaroid | 14 | yes |
| Frame mask | masks the picture to a shape (rounded rectangle, ellipse, vignette, feathered edge, a user PNG mask); background color or transparent | 14 | yes |
| Watermark | text (font, size, color, outline/shadow, tokens such as `{name}`, `{date}`, `{exif.model}`) or logo image; 9-point position, margin, opacity, scale relative to the picture, rotation, tiled | 14 | yes |
| Bump map | relief lighting from the picture's own luminance or from a texture image; light angle, height, smoothness | 14 | yes |
| Sketch | pencil/ink drawing from edges, with or without color | 14 | yes |
| Oil painting | brush size and detail (Kuwahara/intensity-bin family) | 14 | yes |
| Lens | spherical magnify/bulge, pinch, barrel/pincushion distortion, with center and radius | 14 | param (center = relative) |
| Obscure | blur, pixelate or mosaic of a region (rectangle, ellipse, freehand) for faces, plates, text; irreversible after save | 14 | param (fixed relative region only) |

### 3.3 Geometry and canvas

| Feature | What it does | Stage | Batch |
|---|---|---|---|
| Rotate | 90°/180°/270°, any angle, straighten tool (draw the horizon), expand or crop-to-fill, fill color | 12 | yes |
| Flip | horizontal, vertical | 12 | yes |
| Resize | by pixels, percent, fit within, fill, or print size at a DPI; Lanczos (default), bicubic, bilinear, nearest; never-enlarge option | 12 | yes |
| Canvas size | grow or shrink the canvas; 9-point anchor, fill color, transparent, edge extend | 12 | yes |
| Set DPI | writes the resolution (JPEG, PNG, TIFF, BMP); optional resample to keep the print size | 12 | yes |
| Crop | free, fixed ratios (original, 1:1, 4:3, 3:2, 16:9, custom), thirds/golden overlays, numeric box | 12 | param (ratio + anchor, or size + anchor) |

### 3.4 Draw and retouch

| Feature | What it does | Stage | Batch |
|---|---|---|---|
| Draw | brush, eraser, line, arrow, rectangle, ellipse, text, fill; color, size, hardness, opacity | 15 | no |
| Clone and heal | clone stamp from a source point; heal (clone with tone/texture blending); spot-heal brush | 15 | no |
| Red-eye remover | click an eye or drag a box; optional auto-detect of red pupils | 15 | param (auto-detect only, with a "nothing found" report; shipped only if the detector passes its test set) |

### 3.5 View (read-only panels)

| Feature | What it does | Stage | Batch |
|---|---|---|---|
| EXIF | grouped tags (camera, exposure, lens, GPS, date, software), copy value, "strip on save" switch | 12 | report (CSV) and "strip metadata" output option |
| Histogram | luminosity and R/G/B, updates with the edit, clipping warnings, log scale | 12 | — |
| File properties | the existing properties dialog, shown as a panel of the editor, with the edited size and estimated file size | 12 | — |

## 4. How it works (summary of ADR-0035 and ADR-0036)

- **Non-destructive until saved.** The editor holds an *edit list* (ADR-0022: an ordered list of operations with JSON
  parameters). Undo and redo are snapshots of that list, not of pixels. Draw and clone/heal strokes are operations
  with normalized coordinates, so they replay at any resolution.
- **Go renders, the renderer shows.** All pixel work is in the Go sidecar (pure Go, ADR-0019). The renderer sends the
  edit list (a few KB) and receives a frame as a token URL (ADR-0009), never pixels over IPC, never base64 in React
  state.
- **Two resolutions.** Interactive editing renders a *proxy* (at most the screen's pixels at the zoom shown). Save
  renders the full-resolution image through the same pipeline. A deterministic pipeline means what you saw is what is
  saved, up to resampling.
- **Latest wins, cancellable.** Every render carries a revision. A newer revision cancels the older one. Heavy tools
  show a draft while a slider moves and refine when it settles.
- **Original is safe.** Default save is "Save as copy" next to the original (`name (edited).jpg`). "Replace original"
  moves the original to the OS trash first, or refuses when there is no trash (ADR-0021 semantics).
- **Batch = recipe.** A recipe is an edit list made of batch-capable operations (relative units, rules instead of
  pointed positions) plus output settings. It runs as a job on the ADR-0029 queue (`kind: "edit"`), with a bounded
  worker count and a memory budget.

## 5. UX design

Principles: the picture is the hero, controls stay close to the thing they change, every control has a number and a
keyboard route, every change is reversible, and nothing blocks the picture while it works.

### 5.1 Layout

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ‹ Back   photo-0412.jpg  ·  6000×4000  ·  ● unsaved   ↶ ↷   ◐ Before   Zoom  Save ▾ │
├────┬─────────────────────────────────────────────────────────┬───────────────┤
│Tool│                                                         │ Histogram     │
│rail│                      canvas                              ├───────────────┤
│    │         (zoom, pan, before/after split)                 │ Tool options  │
│ ⌕  │                                                         │  sliders,     │
│    │                                                         │  presets      │
│    ├─────────────────────────────────────────────────────────┤  Info tabs:   │
│    │ edit stack:  Levels ▢ · Curves ▢ · Sharpen ▢ · + Add     │  EXIF · File  │
└────┴─────────────────────────────────────────────────────────┴───────────────┘
```

- **Tool rail** (left): Adjust, Color, Effects, Geometry, Retouch, Draw. Each opens its tools in the right panel. `/`
  or `Ctrl/Cmd+K` opens a **tool search** ("curv" → Curves) and is the fast path for keyboard users.
- **Canvas:** reuses the viewer's layered zoom and pan (fit, 1:1, wheel, drag). **Before/after:** hold `\` to peek the
  original, or drag a split handle. Crop, obscure, clone and red-eye draw their overlays on the canvas.
- **Right panel** (resizable, collapsible, state remembered): the histogram is always on top; below it the active
  tool's options; below that the **Info** tabs (EXIF, File properties, Colors).
- **Edit stack** (bottom strip): the operations in order, each with an eye (enable/disable), a drag handle (reorder
  where order is allowed) and a delete button. Clicking one reopens its panel to change its parameters. This is the
  "history" and also what becomes a recipe in batch mode.
- **Save split button:** *Save as copy* (default), *Save as…* (native dialog, owned by main), *Replace original*;
  format, quality, metadata (keep, strip, strip GPS only) and the DPI are in one small popover with the estimated file
  size.

### 5.2 Controls

- A slider is a track, a number field and a reset dot. Arrow keys step by 1, `Shift` by 10, `Home`/`End` jump, double
  click or `Ctrl/Cmd+0` resets, and the number field takes typed values and math-free units (`%`, `°`, `px`).
- Every tool has **Presets** with live thumbnails (rendered on a tiny proxy, at most 8 at a time, never while a
  slider is being dragged), **Reset** and **Apply** semantics that are explicit: tools with parameters apply
  live and sit in the edit stack. Tools with a gesture (crop, obscure, clone) show Apply/Cancel buttons and accept
  `Enter`/`Esc`.
- Eyedroppers, curve points and the crop box are fully operable by keyboard (arrows nudge, `Shift` ×10, `Tab` moves
  between points).
- Color-managed look: the canvas has a neutral surround so colors are judged fairly (a fixed 18 % gray in both
  themes), independent of the interface theme.

### 5.3 Feedback and states

- First frame is the viewer's cached large preview, shown at once; the editable proxy swaps in without a jump.
- A thin progress line under the toolbar appears for renders longer than 200 ms; the canvas never goes blank, the
  last frame stays until the new one arrives.
- Out of memory, unsupported format, huge image (cap in ADR-0035), disk full and failed save have plain messages with
  one next action each. A failed save never touches the original.
- Motion follows ADR-0014 and `prefers-reduced-motion`. No effects on the canvas.
- Every string goes through `t()` (ADR-0034, eight languages). Numbers and units follow the language.
- Accessibility: tool rail is a toolbar with roving focus, panels are labelled regions, sliders are `role="slider"`
  with values spoken in units, the canvas has a text alternative, and everything works at 200 % interface size.

### 5.4 Batch editor (Stage 16)

Opens from a multi-selection. Same shell, different center: a **filmstrip of up to 12 sample pictures** from the
selection (first, last and spread between, the user can pin others) shows the live result of the recipe, so the user
judges it on real variation. Left: the same tool rail, restricted to batch-capable tools (the others are shown
disabled with the reason). Right: the recipe (edit stack), then **Output**: format and quality, destination (next to
the original with a suffix, a new folder, or replace through trash), name template (the batch-rename tokens from
ADR-0021 plus `{name}`, `{date}`, `{n}`), conflict policy (ADR-0029), metadata policy. **Run** starts a job, the
editor closes, the jobs panel shows progress, cancel, per-item errors and "Show results". Recipes can be saved,
named, exported and imported as files (`.panelyth-recipe.json`), and are listed in the batch editor and in the
single-image editor as presets.

## 6. Non-goals of the whole feature

- RAW, HEIC/AVIF, multi-page TIFF and animated GIF/WebP editing (the editor opens the first frame of a GIF/WebP only
  to convert; animated files are refused with a message).
- Layers with blend modes, masks painted per layer, vector shapes, RAW development, HDR, panoramas, face
  recognition, AI features (BRS §10 keeps AI out of scope).
- 16-bit or floating-point editing (8 bits per channel in v1; a 16-bit PNG/TIFF opens with a notice).
- Color-managed conversion between ICC profiles (values are edited in the file's own space; the embedded profile is
  kept).
- Lossless (MCU-aligned) JPEG rotate and crop. JPEG is re-encoded; the Save popover says so and offers PNG.
- Persisting a non-destructive edit list beside the file (sidecar/XMP). Edits live until saved or closed.
- Video editing (BRS §10).
- Plugins for third-party filters (ADR-0022 registry stays internal).

## 7. Supported formats

| Format | Open | Save |
|---|---|---|
| JPEG | yes | yes (quality 1–100, default 92; EXIF/ICC carried over, orientation reset to 1) |
| PNG | yes (alpha) | yes (alpha, indexed after Reduce colors) |
| WebP | yes (still) | **no** (no pure-Go encoder, ADR-0019): saved as PNG or JPEG |
| GIF | first frame | yes as single-frame, indexed |
| BMP | yes | yes |
| TIFF | yes (single page, 8-bit) | yes (uncompressed or Deflate) |
| HEIC, AVIF, RAW | no | no |

## 8. Proposed requirement text

Adds to `docs/viewer/BRS.md` as **FR-23 — Image editing** (see that file). Performance targets for the editor are in
the stage documents (proposed budgets, fixed by the Stage 12 baseline and then added to `docs/viewer/PERFORMANCE.md`).

## 9. Open questions (answered inside the named stage)

| Question | Decided in |
|---|---|
| How frames travel from Go to the canvas (encoded file + token vs raw buffer): measured | 12 |
| EXIF reader/writer: extend `internal/meta` or add a small pure-Go library | 12 |
| Editing size cap (proposed 100 MP) and memory budget per session | 12 |
| Spot-heal algorithm (patch-based vs gradient-domain) | 15 |
| Whether auto red-eye ships in batch | 15, 16 |
| Text shaping for watermarks in complex scripts (pure-Go limits) | 14 |
