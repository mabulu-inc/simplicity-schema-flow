---
title: Source layout
description: How the simplicity-schema codebase is organized.
---

```
src/
├── index.ts                 # Public API surface (re-exports)
├── cli/
│   ├── index.ts             # CLI entry point
│   ├── args.ts              # Argument parsing
│   ├── help.ts              # Help text
│   └── pipeline.ts          # Migration pipeline orchestration
├── core/
│   ├── config.ts            # Config resolution (CLI > file > env > defaults)
│   ├── config-file.ts       # YAML config file loading with ${VAR} interpolation
│   ├── db.ts                # Connection pool management (withClient, withTransaction)
│   ├── files.ts             # File discovery (glob for YAML/SQL, SHA-256 hashing)
│   ├── logger.ts            # Structured logger (verbose/quiet/json modes)
│   └── tracker.ts           # History table operations (ensure, record, query)
├── schema/
│   ├── types.ts             # TypeScript type definitions for all YAML schemas
│   ├── parser.ts            # YAML parsing, validation, auto-detection
│   └── mixins.ts            # Mixin loading, {table} substitution, merge logic
├── introspect/
│   └── index.ts             # Database introspection via pg_catalog
├── planner/
│   └── index.ts             # Desired vs actual state diffing, operation generation
├── executor/
│   └── index.ts             # SQL execution, advisory locking, retry, CONCURRENTLY handling
├── drift/
│   └── index.ts             # Drift detection (YAML vs DB comparison)
├── lint/
│   └── index.ts             # Static analysis rules for migration plans
├── rollback/
│   └── index.ts             # Snapshot capture, reverse operation computation
├── expand/
│   └── index.ts             # Expand/contract column migration logic
├── scaffold/
│   └── index.ts             # Project init, template generation, DB-to-YAML generation
├── sql/
│   └── index.ts             # SQL file generation from plans
├── erd/
│   └── index.ts             # Mermaid ER diagram generation
└── testing/
    └── index.ts             # Test helpers (useTestProject, writeSchema)
```

## Key design decisions

**Declarative, not imperative**: Users declare end state; the tool computes the diff. No migration files to manage, no ordering conflicts.

**Real PostgreSQL for tests**: No mocking. Every test creates an isolated database, runs the full pipeline, and queries PG to verify. This catches real issues that mocks miss.

**Phased execution**: Fixed order respecting PostgreSQL dependencies. Extensions before enums, enums before tables, tables before indexes, etc.

**Safe by default**: Destructive operations require explicit opt-in. FK uses NOT VALID + VALIDATE. Indexes use CONCURRENTLY. NOT NULL uses the safe CHECK pattern.

**Internal schema separation**: Tool state in `_simplicity` never collides with user objects.
