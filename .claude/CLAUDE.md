# SIMPLICITY-SCHEMA — Claude Code Instructions

## Project Goal

Build `@mabulu-inc/simplicity-schema` — a declarative schema management tool for PostgreSQL.
Requirements are defined in `docs/PRD.md`.

## Methodology

Follow the Ralph Methodology defined in `docs/RALPH-METHODOLOGY.md`.

## Project-Specific Config

- **Language**: TypeScript (strict mode)
- **File naming**: kebab-case
- **Package manager**: pnpm
- **Testing framework**: Vitest
- **Quality check**: `pnpm check` (lint → format → typecheck → build → test:coverage)
- **Test command**: `pnpm test`
- **Testing policy**: NEVER mock PostgreSQL — always use real instances via Docker container

## Database (MANDATORY)

- PostgreSQL runs in Docker via `docker-compose.yml` in the project root
- **NEVER assume PostgreSQL is installed locally** — always use the container
- Default connection: `postgresql://postgres:postgres@localhost:54329/postgres`
- Tests MUST read `DATABASE_URL` from the environment (loaded from `.env`)
- Before running tests, ensure the container is up: `docker compose up -d --wait`

## Project-Specific Rules

- **Do NOT use TodoWrite** — it wastes turns and provides no value in a stateless loop
- **Do NOT explore library internals** (node_modules) unless a specific error requires it
