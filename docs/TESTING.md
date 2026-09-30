# Testing Strategy

## Unit tests

### React

Test:

- virtual range -> visible items
- page loading
- infinite scroll threshold
- keyboard navigation
- selection
- error placeholders
- theme state

### Go

Test:

- path normalization
- image type detection
- source identity
- cache key generation
- cache hit/miss
- request coalescing
- cancellation
- scanner filtering
- SQLite queries
- atomic cache write behavior

## Integration tests

### Go

- scan a generated fixture tree
- index many images
- query deterministic pages
- generate thumbnails
- reopen and hit cache

### Electron

- start sidecar
- open folder
- fetch first page
- request visible previews
- shutdown/restart sidecar cleanly

## End-to-end

Scenarios:

1. open folder with 100 images
2. open folder with 10k images
3. open folder with 100k synthetic files
4. scroll continuously
5. change tile size
6. revisit same folder
7. replace an image in place
8. cancel an in-progress scan
9. permission/error case
10. restart application after cache exists

## Performance fixtures

Keep deterministic fixture sets for:

- small folder
- large folder
- huge folder
- mixed unsupported files
- repeated filenames
- rapidly changing files

## Benchmarks

Track:

- files/sec scan
- metadata/sec
- SQLite page latency
- JPEG decode + resize latency
- cache hit latency
- cache miss end-to-end latency
- renderer frame/scroll behavior

Do not rely only on synthetic microbenchmarks. Include a real end-to-end benchmark path.
