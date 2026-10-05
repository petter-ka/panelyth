# Product Principles (shared)

These principles hold for every app of the product family (ADR-0025). Each app adds a focus of its own:

- **Viewer:** browse pictures and videos visually; the media carries the screen.
- **Commander:** two places at once, keyboard first; every file operation is explicit, visible and cancellable.

## Browse first

Useful browsing starts before indexing finishes.

## Selection is central

Selection drives preview, properties, contextual actions and batch operations.

## Everything is virtualized or paged

Directory size must not determine mounted DOM size.

## Preview is cache-first

Use the disk preview cache before generating a new thumbnail/poster.

## Keyboard parity

Core mouse workflows have keyboard equivalents. In the commander, the keyboard is the primary interface.

## Power-user features stay discoverable

Use context menus, secondary toolbars and shortcuts rather than cluttering the main UI.

## Local-first

Core browsing, indexing, preview, playback and file management require no cloud service.

## Extension-friendly

Favorites, tags, ratings, effects, collections and richer metadata must be additive.
