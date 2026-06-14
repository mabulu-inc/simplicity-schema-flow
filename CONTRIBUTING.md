# Contributing to schema-flow

## Development methodology

This project is PRD-driven and task-based: work is specified up front and implemented one task at a time.

### How work is organized

1. **PRD** (`docs/PRD.md`) — the source of truth for what to build, organized into numbered sections with testable requirements
2. **Task files** (`docs/tasks/T-NNN.md`) — one file per feature or fix, with status tracking, dependencies, and PRD traceability

Each task follows red/green TDD: write failing tests first, implement the minimum to pass, verify with `pnpm check`, commit.

### Creating a task

Add a new file in `docs/tasks/` following the format of the existing task files. Key fields:

- **Status**: TODO or DONE
- **Depends**: other tasks that must complete first
- **PRD Reference**: which PRD section this implements
- **Complexity**: light, standard, or heavy

## Getting started

### Prerequisites

- Node.js 20+
- Docker (PostgreSQL runs in a container, never locally)
- pnpm

### Setup

```bash
pnpm install
docker compose up -d --wait
cp .env.example .env  # if needed
```

### Running checks

```bash
pnpm check          # lint → format → typecheck → build → test:coverage
pnpm test           # tests only
pnpm test:watch     # watch mode
```

## Code standards

- **TypeScript** in strict mode, kebab-case file naming
- **Behavioral tests only** — test outcomes against real PostgreSQL, never mock the database
- **One commit per task** — task file update included in the same commit
- Every line of production code must be exercised by a test
- No dead code, no TODO/FIXME/HACK, no commented-out blocks
- `pnpm check` must pass before any commit lands
