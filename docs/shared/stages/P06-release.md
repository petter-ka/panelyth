# Stage P06 — Release Engineering

Status: **Planned**. Track: platform (formerly viewer Stage 11). Depends on: P05. Whether the first release shows the
commander is decided in `docs/ROADMAP.md`; Stage C11 is the release that enables it.

## Objective

A repeatable, signed release pipeline for the product: one shell containing both apps (ADR-0031). The commander
stays hidden behind its feature flag until Stage C11 enables it.

## Scope

- One product version; the sidecar binary is versioned with it and reported in `hello`.
- Signed artifacts for each OS; macOS notarization.
- Update strategy (auto-update channel or manual).
- Installer smoke tests on clean machines.
- Cache and index migrations: an `index.db` version change drops the cache (ADR-0016); `library.db` migrations are
  tested from every released schema.
- Third-party binaries and notices: an **LGPL** ffmpeg/ffprobe build next to the sidecar, never a GPL build
  (ADR-0018); 7-Zip for the commander only if its licence fits (ADR-0030); one licence notice file.
- Release documentation (install, data locations, uninstall, known limits).
- Clean-machine validation, with the commander both hidden and enabled.

## Acceptance criteria

- The product can be built, signed, installed, updated and removed on all three OSes from the pipeline alone.
- Notices list every bundled third-party component.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
