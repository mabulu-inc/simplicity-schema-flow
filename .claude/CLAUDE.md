# SCHEMA-FLOW — Claude Code Instructions

## Project Goal

Build `@smplcty/schema-flow` — a declarative schema management tool for PostgreSQL.
Requirements are defined in `docs/PRD.md`.

## Project-Specific Config

- **Language**: TypeScript (strict mode)
- **File naming**: kebab-case
- **Package manager**: pnpm
- **Testing framework**: Vitest
- **Quality check**: `pnpm check` (lint → format → typecheck → build → test:coverage)
- **Test command**: `pnpm test`
- **Testing policy**: NEVER mock PostgreSQL — always use real instances via Docker container

## Database (MANDATORY)

- Tests run PostgreSQL via **Testcontainers** — `vitest.global-setup.ts` starts an
  ephemeral `postgres:16` container automatically; nothing to start by hand.
- **NEVER assume PostgreSQL is installed locally** — tests always use the container.
- A reachable Docker daemon is required (Docker Desktop / colima locally; CI runners
  provide one). That is the only prerequisite — no `docker compose`, no `.env`.
- Each test file gets its own throwaway database (see `vitest.setup.ts`), so files
  run in parallel safely; within a file, `useTestProject` isolates per test via a
  unique schema. Tests read the connection from `DATABASE_URL`, which the harness
  sets to the container — never hard-code a connection string.

## Releases

- The agent session has **no TTY**: interactive `release-it` prompts hang and
  get force-closed. **NEVER** run bare `pnpm release` (or any interactive
  release-it invocation) in-session.
- Always cut releases non-interactively with `--ci`:
  `pnpm release:<bump> --ci` (release-it + `@release-it/keep-a-changelog`).
  The `--ci` flag is **mandatory** here.
- Bump (pre-1.0): new features → `release:minor`, fixes/non-breaking →
  `release:patch`. Do not use `release:major` until the package is ≥1.0.
- Release only from `main` with `CHANGELOG.md` `## [Unreleased]` populated
  (release-it refuses an empty `[Unreleased]`). release-it commits, tags,
  pushes, and creates the published GitHub release; the GitHub Action
  (`publish.yml`) runs the npm publish — release-it itself does not.

## Project-Specific Rules

- **Do NOT use TodoWrite** — it wastes turns and provides no value here
- **Do NOT explore library internals** (node_modules) unless a specific error requires it
