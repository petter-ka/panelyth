# /benchmark

Run the most relevant FastView performance checks for the current stage.

Budgets: `docs/shared/PERFORMANCE.md` plus the app's `PERFORMANCE.md` (`docs/viewer/`, `docs/commander/`). Results are
filed under the stage ID (`BENCH_STAGE=08.6`, `P01`, `C03`).

Report:

- environment
- fixture size
- baseline
- current
- delta
- CPU/memory observations
- pass/fail against the current performance budget

Do not fabricate missing measurements.
