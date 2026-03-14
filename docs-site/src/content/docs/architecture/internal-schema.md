---
title: Internal schema
description: The _simplicity PostgreSQL schema used for tool state.
---

## Overview

All tool state lives in a dedicated `_simplicity` PostgreSQL schema, completely separate from user objects. User-defined objects go into whatever schema you configure via `pgSchema` (default: `public`).

## Tables

### `_simplicity.history`

File tracking table. Records which schema files have been applied.

| Column       | Type          | Description                      |
| ------------ | ------------- | -------------------------------- |
| `file_path`  | `text` (PK)   | Relative path to the schema file |
| `file_hash`  | `text`        | SHA-256 hash of file contents    |
| `phase`      | `text`        | `pre`, `schema`, or `post`       |
| `applied_at` | `timestamptz` | When the file was last applied   |

A file is re-run only when its hash changes. There is no one-shot vs. repeatable distinction.

### `_simplicity.expand_state`

Tracks in-progress expand/contract column migrations.

### `_simplicity.snapshots`

Stores migration snapshots for rollback. Each snapshot captures the operations that were applied.

## Why a separate schema?

- **No collisions** -- Tool tables never conflict with user-defined objects, even if you have a table named `history` or `snapshots`
- **Clean uninstall** -- `DROP SCHEMA _simplicity CASCADE` removes all tool state without touching user data
- **Clear ownership** -- `_simplicity.*` is always tool-managed; everything in the user's schema is their declared state

## Creation

The schema is created automatically on first run:

```sql
CREATE SCHEMA IF NOT EXISTS _simplicity;
```

This happens in phase 0, before any other operations.
