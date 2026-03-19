---
title: Internal schema
description: The _smplcty_schema_flow PostgreSQL schema used for tool state.
---

## Overview

All tool state lives in a dedicated `_smplcty_schema_flow` PostgreSQL schema, completely separate from user objects. User-defined objects go into whatever schema you configure via `pgSchema` (default: `public`).

## Tables

### `_smplcty_schema_flow.history`

File tracking table. Records which schema files have been applied.

| Column       | Type          | Description                      |
| ------------ | ------------- | -------------------------------- |
| `file_path`  | `text` (PK)   | Relative path to the schema file |
| `file_hash`  | `text`        | SHA-256 hash of file contents    |
| `phase`      | `text`        | `pre`, `schema`, or `post`       |
| `applied_at` | `timestamptz` | When the file was last applied   |

A file is re-run only when its hash changes. There is no one-shot vs. repeatable distinction.

### `_smplcty_schema_flow.expand_state`

Tracks in-progress expand/contract column migrations.

### `_smplcty_schema_flow.snapshots`

Stores migration snapshots for rollback. Each snapshot captures the operations that were applied.

## Why a separate schema?

- **No collisions** -- Tool tables never conflict with user-defined objects, even if you have a table named `history` or `snapshots`
- **Clean uninstall** -- `DROP SCHEMA _smplcty_schema_flow CASCADE` removes all tool state without touching user data
- **Clear ownership** -- `_smplcty_schema_flow.*` is always tool-managed; everything in the user's schema is their declared state

## Creation

The schema is created automatically on first run:

```sql
CREATE SCHEMA IF NOT EXISTS _smplcty_schema_flow;
```

This happens in phase 0, before any other operations.
