# FastView — Claude Code Project

Working title for a very fast cross-platform desktop image viewer.

## Product goal

Build a Windows / macOS / Linux image viewer with:

- Go backend / native sidecar for filesystem indexing, metadata, thumbnail generation and cache
- React renderer inside Electron
- Electron main process only for desktop lifecycle, secure IPC and native integrations
- persistent preview cache on the user's OS cache drive
- infinite scrolling + virtualized image grid
- large-directory support
- keyboard-first navigation
- cross-platform packaging
- performance treated as a first-class product requirement

## Start here

Claude Code should read these files in this order:

1. `CLAUDE.md`
2. `BRS.md`
3. `docs/ARCHITECTURE.md`
4. `docs/PERFORMANCE.md`
5. `docs/CACHE-DESIGN.md`
6. `ROADMAP.md`
7. `DEVELOPMENT-STAGES.md`
8. relevant ADRs in `decisions/`
9. the stage document being implemented in `stages/`

## Project principle

Do not optimize by intuition. Add instrumentation, reproduce the bottleneck, measure, change one thing, measure again.

The target is not merely fast startup. The target is a viewer that still feels fluid while browsing directories containing tens or hundreds of thousands of images.
