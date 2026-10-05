# ADR-0008 — Search and Sort Through SQLite

## Status

Accepted

## Decision

Search, filtering and sorting are executed by the Go/SQLite index and returned using offset/limit paging.

## Fields

Name, type, size, dates, dimensions, duration, favorite, rating, tags.

## Rationale

A huge folder must not be completely loaded into the renderer just to sort or search.
