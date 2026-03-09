# Progress Log

## Current State
<!-- Updated by each Ralph Loop iteration. Read this FIRST. -->
Last completed task: T-003 (File discovery and tracking)
Next eligible task: T-004 (Logger)

## Completed Tasks

- **T-001**: Project setup and config system — TypeScript project (tsconfig, vitest, pnpm), config resolution with defaults/env/yaml/CLI overrides. 16 tests passing.
- **T-002**: Database connection management — Pool singleton, withClient, withTransaction, retry logic for transient errors, configurable timeouts, testConnection. 19 tests passing.
- **T-003**: File discovery and tracking — glob-based YAML/SQL discovery from schema dir with phase classification (pre/schema/post), SHA-256 hash-based file tracker using _simplicity.history table, change detection via hash comparison. 62 tests passing.
- **T-000**: Docker-based test database setup — docker-compose.yml with PG 17 on port 54329 (tmpfs, healthcheck), .env/.env.example, vitest loads dotenv, db.test.ts uses DATABASE_URL without fallback. 35 tests passing.
