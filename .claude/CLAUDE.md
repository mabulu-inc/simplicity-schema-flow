# SIMPLICITY-SCHEMA — Claude Code Instructions

## Project Goal

Build `@mabulu-inc/simplicity-schema` — a declarative schema management tool for PostgreSQL.
Requirements are defined in `docs/PRD.md`.

## Ralph Loop Boot Sequence

**On every iteration, do this FIRST:**

1. Read `docs/PROGRESS.md` — check "Current State" for last task, next task, blockers
2. Read `docs/TASKS.md` — find the next eligible task (lowest-numbered TODO with all deps DONE)
3. Read `docs/PRD.md` for requirements relevant to the task
4. Execute the task:
   a. Use red/green TDD — write failing tests, implement, verify
   b. Run full test suite: `pnpm test`
   c. If all pass: commit, update PROGRESS.md, set task to DONE
   d. If blocked: update PROGRESS.md with blocker, move to next eligible task

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

## Database (MANDATORY)

- PostgreSQL runs in Docker via `docker-compose.yml` in the project root
- **NEVER assume PostgreSQL is installed locally** — always use the container
- Default connection: `postgresql://postgres:postgres@localhost:54329/postgres`
- Tests MUST read `DATABASE_URL` from the environment (loaded from `.env`)
- Before running tests, ensure the container is up: `docker compose up -d --wait`
- If `docker-compose.yml` or `.env` don't exist yet, create them as part of T-000

## Project Conventions

- **Language**: TypeScript (strict mode)
- **File naming**: kebab-case
- **Package manager**: pnpm
- **Testing framework**: Vitest
- **Testing policy**: NEVER mock PostgreSQL — always use real instances via Docker container
