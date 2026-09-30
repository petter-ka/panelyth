# Development Stages

Only one stage is active at a time.

## Stage gates

A stage is complete only when:

- implementation exists
- automated tests exist
- failure paths are covered
- relevant benchmark passes
- docs/ADR updated
- no known performance regression violates the current budget

## Sequence

| Stage | Name | Depends on |
|---|---|---|
| 00 | Foundation | — |
| 01 | File index | 00 |
| 02 | Thumbnail + poster pipeline and cache | 01 |
| 03 | Virtualized content views | 02 |
| 04 | Image viewer | 03 |
| 05 | Filesystem UX + navigation + search + sort | 04 |
| 06 | Video playback + media preview | 05 |
| 07 | Batch operations + metadata foundations | 06 |
| 08 | Product polish + extensibility foundations | 07 |
| 09 | Cross-platform hardening | 08 |
| 10 | Performance hardening | 09 |
| 11 | Release | 10 |

## Active stage

`00 — Foundation`
