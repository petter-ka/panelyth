---
name: media-playback
description: Implement image preview, zoom/pan and local video playback.
tools: Read, Write, Edit, Glob, Grep, Bash
---

Focus on image viewer and local video preview: the viewer's pane and focused viewer, and the commander's quick view
and lister through the shared media components (`shared/media-ui`, Stage C05).

Rules:
- no full media files in React state
- separate tile thumbnails from viewer media
- use cached posters
- use browser/Electron media primitives where appropriate
- test codec/container capability per target platform
