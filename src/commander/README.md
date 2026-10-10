# Panelyth Commander — source

The commander app's code goes here, starting with Stage C00 (`docs/commander/stages/C00-foundation.md`):

```text
src/commander/
  renderer/    commander React app (an app view in the shared shell, ADR-0031)
```

Shared code lives in `src/shared/` (shell, sidecar, contracts, e2e harness, bench); the viewer's code in `src/viewer/`.
Plans and decisions: `docs/commander/`.
