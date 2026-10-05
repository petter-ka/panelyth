# /implement-stage

Implement exactly one development stage.

Process:

1. Read `CLAUDE.md`.
2. Read `docs/DEVELOPMENT-STAGES.md` (stage IDs: viewer `NN`, platform `PNN`, commander `CNN`).
3. Read the target stage document: `docs/viewer/stages/`, `docs/shared/stages/` or `docs/commander/stages/`.
4. Read linked ADRs (`docs/*/decisions/`, index in `docs/README.md`).
5. Inspect existing code.
6. Implement only the stage scope.
7. Add tests.
8. Run validation.
9. Run relevant performance checks.
10. Update stage checklist and affected docs.

Do not silently expand scope into a later stage.

When the stage touches shared code (`shared/*`, the sidecar, `shared/contracts`), validate both apps once the
commander exists.
