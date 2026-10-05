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

Specs: `tests/e2e/specs/` (`index`, `previews`, `tiles`, `viewer`, `workspace`, `media`, `jobs`, `theme`,
`polish`, `foundation`). Each spec writes its measurements to `bench/results/stage-<id>-<date>-e2e-<kind>.jsonl`.

## Viewer fixtures

`images-150` and `images-12mp-120` (thumbnails, viewer), `images-48mp-3` (large decodes), `flat-100k`, `flat-10k`,
`tree-50k` (scrolling, paging), `folders-2000` (folder covers, Stage 08.6), `tree-small` and `subdirs-10k`
(navigation, lazy tree) and `videos-v1` (posters, playback; needs ffmpeg). Generation rules: `docs/shared/TESTING.md`.
