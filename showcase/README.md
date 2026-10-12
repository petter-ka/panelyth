# Panelyth Showcase

The product page of Panelyth: a photo and video viewer and a keyboard-first, two-panel file manager (the commander)
in one desktop app. It is a standalone React page with its own package manifest and a nested pnpm workspace; it
imports nothing from the repository's apps or shared packages.

## Run it

```sh
pnpm install
pnpm dev
```

`pnpm build` writes a static site to `dist/`; `pnpm preview` serves it. Asset URLs are relative (`vite.config.js`),
so the built page works at a domain's root and under a project path such as GitHub Pages' `/panelyth/`.

## What the page says and where it comes from

- The copy follows `docs/` (the BRS and feature matrix of each app, `docs/shared/APP-SWITCHING.md`,
  `docs/INSTALL.md`). The figures in "One window" are the recorded ones: the app switch from Stage C00, the folder
  size from the performance budgets.
- **Download** links to the GitHub releases of `petter-ka/panelyth`. The page asks GitHub for the newest release and
  then links each file directly and shows the version and sizes; until a release is published (or when GitHub cannot
  be reached) every button leads to the releases page. File names are the ones in `docs/INSTALL.md`.

## Screenshots

Everything in `src/media/` is taken from the real app, running on a generated demo library. The hero is a slideshow
of six of the screenshots, the viewer and the commander in turn (`heroSlides` in `src/main.jsx`); it changes every
five seconds, waits while the pointer or the focus is on it, and does not start by itself for people who asked their
system for less motion. To make the pictures again after the app's look changed:

```sh
pnpm build                                   # in the repository root: the app
node showcase/scripts/demo-library.mjs       # once: the demo library (about 10 minutes, 75 MB)
node showcase/scripts/capture.mjs            # stills and video; or: capture.mjs stills | video
node showcase/scripts/capture.mjs stills --only=commander-find   # retake some pictures, keep the rest
```

- `scripts/demo-library.mjs` draws about 150 landscape pictures and renders seven short clips into
  `showcase/.demo/Users/user` (ignored by git). The pictures are procedural, so the page carries no third-party
  rights. It needs `ffmpeg` on the `PATH`.
- `scripts/session.mjs` starts the built app with a profile of its own and points its places (Home, Pictures, …) into
  the demo home. On Windows the library is mounted as drive `U:` for the run, so paths read `U:\Users\user\…`
  whatever the checkout's path and the account's name are.
- `scripts/capture.mjs stills` takes the nine screenshots. `capture.mjs video` records a walk through both apps
  (`hero.mp4`, `hero.webm`, `hero-poster.jpg`) from the frames the app paints; the page no longer shows it, since the
  hero became a slideshow. The video draws a pointer and names the keys that are pressed, and is recorded with the
  preview cache warm, as on a second visit to a folder.

The scripts use the Playwright, Electron and canvas packages of the main workspace, so run `pnpm install` in the
repository root first. The app's windows open on the screen while a capture runs.
