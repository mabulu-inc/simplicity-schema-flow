# Milestones

Quick-scan index. Source of truth is `docs/tasks/T-NNN.md`.

## 0 — Infrastructure

- [x] T-000: Docker-based test database setup

## 1 — Core Foundation

- [x] T-001: Project setup and config system
- [x] T-002: Database connection management
- [x] T-003: File discovery and tracking
- [x] T-004: Logger

## 2 — Schema Parsing

- [x] T-005: Schema type definitions
- [x] T-006: YAML parser
- [x] T-007: Mixin system

## 3 — Introspection

- [x] T-008: Database introspection

## 4 — Planning and Execution

- [x] T-009: Planner / diff engine
- [x] T-010: Executor

## 5 — CLI

- [x] T-011: CLI entry point

## 6 — Secondary Features

- [x] T-012: Drift detection
- [x] T-013: Scaffold / generate
- [x] T-014: Rollback
- [x] T-015: Expand/contract
- [x] T-016: SQL generation
- [x] T-017: Lint
- [x] T-018: ERD generation

## 7 — Public API and Testing Infrastructure

- [x] T-019: Public API surface
- [x] T-020: Test infrastructure

## 8 — Zero-Downtime Patterns

- [x] T-021: CONCURRENTLY indexes
- [x] T-022: Safe NOT NULL pattern
- [x] T-023: Safe unique constraint pattern
- [x] T-024: Enum value removal blocking

## 9 — Grants, Memberships & Operations

- [x] T-025: Grant/revoke for sequences and functions
- [x] T-026: Role group memberships
- [x] T-027: Materialized view grants, comments, refresh
- [x] T-028: Extension schema_grants

## 10 — CLI Commands

- [x] T-029: Baseline command
- [x] T-030: Missing CLI command parsing

## 11 — Precheck Execution & Snapshots

- [x] T-031: Precheck execution and abort
- [x] T-032: Auto snapshot capture

## 12 — Drift Detection

- [x] T-033: Drift detection completeness

## 13 — Public API Surface

- [x] T-034: PRD-listed API exports

## 14 — Column & Table Features

- [x] T-035: Generated columns
- [x] T-036: Column-level grants
- [x] T-037: Composite primary keys
- [x] T-038: Seed upsert execution

## 15 — FK, Index, Function & Trigger Options

- [x] T-039: Foreign key options
- [x] T-040: Index options
- [x] T-041: Function options
- [x] T-042: Trigger for_each and when clause

## 16 — Role, Grant & Policy Options

- [x] T-043: Role attributes
- [x] T-044: Grant with_grant_option
- [x] T-045: Policy permissive flag
- [x] T-046: View grants

## 17 — CLI & Safety Features

- [x] T-047: drift --apply execution
- [x] T-048: Extension drop requires --allow-destructive
- [x] T-049: Intermediate state recovery
- [x] T-050: Expand/contract YAML-driven in normal run
- [x] T-051: --env flag E2E

## 18 — Missing Feature Implementation

- [ ] T-052: force_rls table attribute
- [ ] T-053: Custom constraint names
- [ ] T-054: Column-level check sugar
- [ ] T-055: description alias for comment
- [ ] T-056: Seeds enhancements
- [ ] T-057: Cross-schema FK references
- [ ] T-058: Expand reverse and batch_size

## 19 — E2E Test Harness

- [ ] T-059: E2E test harness

## 20 — E2E: Schema Object Types

- [ ] T-060: Tables
- [ ] T-061: Enums
- [ ] T-062: Functions
- [ ] T-063: Views and materialized views
- [ ] T-064: Roles and extensions

## 21 — E2E: Constraints, Indexes & Security

- [ ] T-065: Foreign keys
- [ ] T-066: Indexes
- [ ] T-067: Check and unique constraints
- [ ] T-068: RLS policies
- [ ] T-069: Grants and triggers

## 22 — E2E: Mixins, Seeds, Prechecks, Expand

- [ ] T-070: Mixins
- [ ] T-071: Seeds
- [ ] T-072: Prechecks
- [ ] T-073: Expand/contract lifecycle

## 23 — E2E: Safety & Zero-Downtime

- [ ] T-074: Destructive operation blocking
- [ ] T-075: Zero-downtime patterns
- [ ] T-076: Concurrency and recovery

## 24 — E2E: Pipeline & Analysis

- [ ] T-077: Pre/post scripts
- [ ] T-078: Drift detection
- [ ] T-079: Lint rules
- [ ] T-080: Rollback

## 25 — E2E: Commands & Generation

- [ ] T-081: Validate and baseline
- [ ] T-082: SQL and ERD generation
- [ ] T-083: Scaffold and generate from DB

## 26 — E2E: Configuration & Status

- [ ] T-084: Config resolution
- [ ] T-085: Status command and multi-run behavior
