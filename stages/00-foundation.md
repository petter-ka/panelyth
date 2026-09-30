# Stage 00 — Foundation

## Objective

Create the executable architecture without implementing the complete image viewer.

## Work

### Repo

- pnpm workspace
- `apps/desktop`
- `apps/renderer`
- `native/fastview-go`
- shared TypeScript contracts package
- build scripts

### Electron

- BrowserWindow
- preload
- secure webPreferences
- sidecar lifecycle
- process logging
- clean shutdown

### React

- application shell
- router/state skeleton if needed
- empty states
- grid placeholder
- theme shell

### Go

- process entrypoint
- framed RPC
- health endpoint/command
- structured logging
- graceful shutdown
- worker pool abstraction

## Acceptance criteria

- app starts
- React can call `ping`
- Electron can start and terminate Go
- Go tests pass
- renderer typechecks
- no synchronous IPC

## Performance check

Measure idle memory and startup baseline before adding image functionality.
