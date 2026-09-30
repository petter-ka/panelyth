# ADR-0006 — Decoder Abstraction

## Status

Accepted

## Decision

Create a Go decoder interface independent from the UI and index schema.

Conceptual interface:

```go
type Decoder interface {
    CanDecode(ctx context.Context, path string) bool
    DecodeThumbnail(ctx context.Context, path string, profile PreviewProfile) (PreviewResult, error)
    DecodePreview(ctx context.Context, path string, profile PreviewProfile) (PreviewResult, error)
    ReadMetadata(ctx context.Context, path string) (ImageMetadata, error)
}
```

## MVP

Implement the simplest reliable decoder path for the core formats required by the stage.

## Extensibility

The architecture must support adding AVIF, HEIF/HEIC and RAW without changing React components or cache semantics.

## Packaging rule

If a decoder depends on native libraries, package the correct library per target OS/CPU architecture and test it in packaged builds.

Do not assume a codec is available merely because it works on the developer machine.
