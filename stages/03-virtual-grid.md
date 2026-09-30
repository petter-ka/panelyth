# Stage 03 — Virtualized Infinite Grid

## Objective

Deliver the main browsing surface.

## Work

- responsive column calculation
- predictable tile geometry
- TanStack Virtual row virtualization
- offset/limit page loader
- infinite scroll trigger
- visible-item thumbnail priority
- keyboard navigation
- selected item model
- item placeholder/error states

## Performance rules

- keep mounted DOM bounded
- do not append individual React items for every backend event
- batch metadata updates
- avoid reading layout for every thumbnail
- do not decode non-visible images unnecessarily

## Acceptance

- very large synthetic folder scrolls continuously
- mounted tile count remains bounded
- fast scrolling does not start unbounded thumbnail work
