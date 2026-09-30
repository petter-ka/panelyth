# ADR-0009 — Local Video Playback

## Status

Accepted

## Decision

Use Electron/Chromium media capabilities for local video playback where supported. Go owns discovery, metadata and cached poster generation.

## Rules

- video bytes do not flow through normal RPC
- media URLs are validated/controlled
- poster frames are cache-backed
- unsupported codec/container states are handled explicitly
