# Viewer Testing

Viewer-specific end-to-end scenarios. Layers, harness, isolation, fixtures and benchmark rules are shared:
`docs/shared/TESTING.md`.

## End-to-end scenarios

1. open folder with 100 images
2. open folder with 10k images
3. open folder with 100k synthetic files
4. scroll continuously
5. change tile size
6. revisit same folder
7. replace an image in place
8. cancel an in-progress scan
9. permission/error case
10. restart application after cache exists

11. edit a picture: open the editor from a tile, rotate, crop and resize (also by keyboard), undo and redo, read
    EXIF and the histogram, save a copy and check the file on disk, the Replace confirmation, the prompt for unsaved
    changes; a 24 MP picture within the editor's budgets; Edit from the commander's media window (Stage 12)
12. change colors: levels and a curve edited by keyboard on a known ramp, the histogram's clipping, the loupe's
    values, the saved pixels read back; count colors exactly, reduce them and check the indexed PNG; six color
    sliders dragged on a 24 MP picture within the frame budget (Stage 13)
13. add effects: obscure a region by numbers and keys, stamp a logo picked in the native dialog and a text
    watermark with a token, add a frame, save and read the pixels back, open the saved picture again; a file that
    is not a picture is refused; eight effect sliders dragged on a 24 MP picture (Stage 14)
14. draw and retouch: a brush stroke whose ink is on screen before Go answers, a text, a cloned patch, a healed
    blemish, red eyes fixed by Auto and by a click, undo and redo through all, the saved pixels read back; ink
    latency and frame pace on a 24 MP picture (Stage 15)
15. edit many pictures: 200 selected with a video and a folder among them, a built-in recipe and a watermark judged
    on two samples, a folder from the native dialog and a name template, 200 whole files with the right names and
    sizes while the tile view is scrolled without a long task; a slow batch cancelled without a partial file;
    "-edited" copies undone; the originals replaced through the trash after the confirmation (Stage 16)

Specs: `src/shared/e2e/specs/` (`index`, `previews`, `tiles`, `viewer`, `workspace`, `media`, `jobs`, `theme`,
`polish`, `foundation`, `editor`, `editor-color`, `editor-effects`, `editor-retouch`, `editor-batch`). Each spec writes its measurements to `src/shared/bench/results/stage-<id>-<date>-e2e-<kind>.jsonl`.

## Viewer fixtures

`images-150` and `images-12mp-120` (thumbnails, viewer), `images-48mp-3` (large decodes), `flat-100k`, `flat-10k`,
`tree-50k` (scrolling, paging), `folders-2000` (folder covers, Stage 08.6), `tree-small` and `subdirs-10k`
(navigation, lazy tree), `videos-v1` (posters, playback; needs ffmpeg), `editor-640` and `editor-24mp` (the image
editor; the spec adds an EXIF block with orientation 6 to one picture) and `edit/` (24, 50 and 100 MP JPEGs written
by `cmd/editbench`). Generation rules: `docs/shared/TESTING.md`.
