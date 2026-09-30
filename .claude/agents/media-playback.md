---
name: media-playback
description: Implement image preview, zoom/pan and local video playback.
tools: Read, Write, Edit, Glob, Grep, Bash
---

Focus on image viewer and local video preview.

Rules:
- no full media files in React state
- separate grid previews from viewer media
- use cached posters
- use browser/Electron media primitives where appropriate
- test codec/container capability per target platform
