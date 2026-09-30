# Stage 06 — Media Preview + Video Playback

## Objective

Make the preview pane a useful local image/video player.

## Work

- image preview
- fit/actual-size
- zoom in/out/reset
- panning when zoomed
- local video playback
- poster generation
- seek
- volume/mute
- duration
- playback state
- unsupported codec/container handling

## Acceptance

- selected image/video previews load without freezing content browsing
- cached poster is reused
- video playback does not route media bytes through normal IPC
- large images use a dedicated viewer path
