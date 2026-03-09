# SIMPLICITY-SCHEMA — Claude Code Instructions

## Project Goal

Build `@mabulu-inc/simplicity-schema` — a declarative schema management tool for PostgreSQL.
This is a clean-room reimplementation inspired by `@mabulu-inc/schema-flow` (located at `../schema-flow`).

## Ralph Loop Boot Sequence

**On every iteration, do this FIRST:**

1. Read `docs/PROGRESS.md` — check "Current State" for last task, next task, blockers
2. Read `docs/TASKS.md` — find the next eligible task (lowest-numbered TODO with all deps DONE)
3. Read the task's referenced spec or source files for exact interfaces and behaviors
4. Execute the task:
   a. For reverse-engineering tasks: read source, document findings in the specified output file
   b. For implementation tasks: use red/green TDD — write failing tests, implement, verify
   c. Run full test suite if applicable: `pnpm test`
   d. If all pass: commit, update PROGRESS.md, set task to DONE
   e. If blocked: update PROGRESS.md with blocker, move to next eligible task

## Task Selection Algorithm

1. Read PROGRESS.md "Current State" → "Next eligible task"
2. In TASKS.md, verify that task's `Depends` are all DONE in PROGRESS.md
3. If verified, start that task
4. If not (stale), re-scan TASKS.md: filter TODO, exclude tasks with unmet Depends, pick lowest-numbered

## Task Completion Criteria

A task is DONE only when ALL conditions hold:
1. All files listed in task's "Produces" field exist
2. All tests (if any) pass
3. No regressions in existing code

## Turn Efficiency Rules (MANDATORY)

- **Do NOT use TodoWrite** — it wastes turns and provides no value in a stateless loop
- **Do NOT explore library internals** (node_modules) unless a specific error requires it
- **Do NOT push to origin** — ralph.sh handles pushing after each iteration
- **Prioritize finishing**: research/implement → verify → commit → update docs. Never explore without purpose.
- **If the task is done, commit immediately.** Do not do extra exploration or refactoring.

## Commit Convention

- One commit per completed task
- Message format: `T-NNN: short description`
- No Claude attribution in commit messages

## Reference Codebase

The schema-flow source is at `../schema-flow/src/`. Key directories:
- `core/` — config, db pool, file discovery, logging, tracker
- `schema/` — YAML types and parser
- `planner/` — diff engine that compares YAML to DB and generates operations
- `executor/` — runs migrations in transactions
- `introspect/` — reads current DB state via pg_catalog
- `drift/` — detects schema drift between YAML and DB
- `scaffold/` — generates YAML from existing DB
- `rollback/` — reverse migration support
- `expand/` — zero-downtime column migrations
- `sql/` — SQL file generation
- `lint/` — schema linting rules
- `erd/` — Mermaid ERD generation
- `cli/` — CLI entry point

## Project Conventions

- **Language**: TypeScript (strict mode)
- **File naming**: kebab-case
- **Package manager**: pnpm
- **Testing framework**: Vitest
- **Testing policy**: NEVER mock PostgreSQL — always use real instances
