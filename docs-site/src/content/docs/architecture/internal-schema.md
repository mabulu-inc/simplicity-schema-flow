---
title: Internal schema
description: The _smplcty_schema_flow PostgreSQL schema used for tool state.
---

## Overview

All tool state lives in a dedicated `_smplcty_schema_flow` PostgreSQL schema, completely separate from user objects. User-defined objects go into whatever schema you configure via `pgSchema` (default: `public`).

## Tables

### `_smplcty_schema_flow.history`

File tracking table. Records which schema files have been applied **per managed pgSchema** — a single database can manage multiple pgSchemas independently without their file-hash entries clobbering each other.

| Column       | Type          | Description                                                       |
| ------------ | ------------- | ----------------------------------------------------------------- |
| `file_path`  | `text`        | Relative path to the schema file (part of composite PK)           |
| `pg_schema`  | `text`        | The managed pgSchema this entry applies to (part of composite PK) |
| `file_hash`  | `text`        | SHA-256 hash of file contents                                     |
| `phase`      | `text`        | `pre`, `schema`, or `post`                                        |
| `applied_at` | `timestamptz` | When the file was last applied                                    |

A file is re-run only when its hash changes for the same pgSchema. There is no one-shot vs. repeatable distinction. On first run after upgrading from a pre-pgSchema-aware version, the column is added in place and existing rows back-fill to `pg_schema = 'public'`.

### `_smplcty_schema_flow.expand_state`

Tracks in-progress expand/contract column migrations. Carries a `pg_schema` column so backfills scoped to one managed schema don't pick up state belonging to another.

### `_smplcty_schema_flow.snapshots`

Stores migration snapshots for rollback. Each snapshot is keyed on its `pg_schema` value, so `runDown` only sees snapshots that belong to the schema it was invoked against.

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
