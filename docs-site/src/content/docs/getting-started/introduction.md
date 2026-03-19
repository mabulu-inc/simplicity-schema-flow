---
title: Introduction
description: What schema-flow is and how it works.
---

`@smplcty/schema-flow` is a declarative PostgreSQL schema management tool. You define your desired database state in YAML files; the tool diffs that state against the live database and generates + executes the minimal SQL to converge.

## How it works

1. You describe tables, enums, functions, views, roles, and extensions in YAML files under `schema/`
2. The tool introspects your live PostgreSQL database via `pg_catalog` and `information_schema`
3. It diffs desired state (YAML) vs actual state (DB) and produces a migration plan
4. It executes the plan with safety rails: advisory locking, `NOT VALID` constraints, `CONCURRENTLY` indexes, transactional DDL

No migration files to manage. No up/down scripts. Just declare the end state.

## Design principles

- **Declarative** -- Describe _what_ the database should look like, not _how_ to get there
- **Safe by default** -- Destructive operations blocked unless explicitly allowed; advisory locking prevents concurrent runs
- **Zero-downtime capable** -- `NOT VALID` constraints, `CONCURRENTLY` indexes, expand/contract column migrations
- **Convention over configuration** -- Works out of the box with a standard `schema/` directory layout
- **Clean internals** -- Tool state lives in a dedicated `_smplcty_schema_flow` PostgreSQL schema, separate from user objects
- **Dual interface** -- Full CLI for operators + TypeScript API for programmatic use

## Requirements

- Node.js 20+
- PostgreSQL 14+

## Setup

Install from npm:

```bash
npm install @smplcty/schema-flow
```

Or use `npx` / `pnpm dlx` to run directly without installing:

```bash
npx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```

Or with pnpm:

```bash
pnpm dlx @smplcty/schema-flow run --db postgresql://user:pass@localhost:5432/mydb
```
