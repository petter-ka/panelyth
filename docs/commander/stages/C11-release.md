# Stage C11 — Commander Release

Status: **Planned**. Track: commander. Depends on: C10, P04, P05, P06.

## Objective

Make Panelyth Commander 1.0 available to users: turn its feature flag on in a product release from the shared
pipeline, so the app switcher rail appears in the viewer, verified on all three OSes.

## Scope

- The product release on the P06 pipeline with the commander enabled (the app switcher rail visible).
- Cross-platform verification of the commander-specific items (P04 for the commander): drives and volumes, long paths
  and UNC, trash per OS, executable flags, 7-Zip discovery, shell quoting.
- Performance: every budget in `docs/commander/PERFORMANCE.md` on the reference and the low-end machine (P05 rules).
- Licensing: decide whether 7-Zip is bundled (LGPL with the unRAR restriction) or discovered only (ADR-0030); notices.
- Documentation: user guide, keyboard reference, data locations, uninstall.
- The final product name (ADR-0025 open point).

## Acceptance criteria

- Clean-machine install, update and uninstall on Windows, macOS and Linux.
- Switching works both ways with every carry-over rule, and the viewer's budgets still pass with the commander
  enabled.
- No open blocking findings from the security review (C10) or the performance review.

## Exit checklist

- [ ] implementation complete
- [ ] tests complete
- [ ] benchmark complete
- [ ] performance regression reviewed
- [ ] docs/ADR updated
