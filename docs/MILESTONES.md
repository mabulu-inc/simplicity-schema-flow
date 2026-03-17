# Milestones

## 0 — Infrastructure ($0.18)

- [x] T-000: Docker-based test database setup — $0.18

## 1 — Core Foundation ($1.81)

- [x] T-001: Project setup and config system — $0.79
- [x] T-002: Database connection management — $0.43
- [x] T-003: File discovery and tracking — $0.39
- [x] T-004: Logger — $0.20

## 2 — Schema Parsing ($1.25)

- [x] T-005: Schema type definitions — $0.31
- [x] T-006: YAML parser — $0.55
- [x] T-007: Mixin system — $0.39

## 3 — Introspection ($0.75)

- [x] T-008: Database introspection — $0.75

## 4 — Planning and Execution ($1.72)

- [x] T-009: Planner / diff engine — $0.75
- [x] T-010: Executor — $0.97

## 5 — CLI ($0.68)

- [x] T-011: CLI entry point — $0.68

## 6 — Secondary Features ($3.27)

- [x] T-012: Drift detection — $0.55
- [x] T-013: Scaffold / generate — $0.54
- [x] T-014: Rollback — $0.69
- [x] T-015: Expand/contract — $0.48
- [x] T-016: SQL generation — $0.35
- [x] T-017: Lint — $0.38
- [x] T-018: ERD generation — $0.28

## 7 — Public API and Testing Infrastructure ($0.98)

- [x] T-019: Public API surface — $0.26
- [x] T-020: Test infrastructure — $0.72

## 8 — Coverage Gaps: Zero-Downtime Patterns ($2.53)

- [x] T-021: CONCURRENTLY indexes — $0.67
- [x] T-022: Safe NOT NULL pattern — $0.79
- [x] T-023: Safe unique constraint pattern — $0.73
- [x] T-024: Enum value removal blocking — $0.34

## 9 — Coverage Gaps: Grants, Memberships & Operations ($2.42)

- [x] T-025: Grant/revoke for sequences and functions — $0.83
- [x] T-026: Role group memberships — $0.58
- [x] T-027: Materialized view grants, comments, and refresh — $0.45
- [x] T-028: Extension schema_grants SQL generation — $0.56

## 10 — Coverage Gaps: CLI Commands ($1.57)

- [x] T-029: Baseline command — $0.42
- [x] T-030: Missing CLI command parsing — $1.15

## 11 — Coverage Gaps: Precheck Execution & Snapshots ($1.57)

- [x] T-031: Precheck execution and abort — $0.83
- [x] T-032: Auto snapshot capture during migration — $0.74

## 12 — Coverage Gaps: Drift Detection ($0.66)

- [x] T-033: Drift detection completeness — $0.66

## 13 — Coverage Gaps: Public API Surface ($0.52)

- [x] T-034: PRD-listed API exports — $0.52

## 14 — Coverage Gaps: Column & Table Features ($3.57)

- [x] T-035: Generated columns — $0.84
- [x] T-036: Column-level grants — $1.40
- [x] T-037: Composite primary keys — $0.97
- [x] T-038: Seed upsert execution — $0.36

## 15 — Coverage Gaps: FK, Index, Function & Trigger Options ($3.05)

- [x] T-039: Foreign key options in SQL generation — $0.85
- [x] T-040: Index options in SQL generation — $0.55
- [x] T-041: Function options in SQL generation — $0.81
- [x] T-042: Trigger for_each and when clause — $0.84

## 16 — Coverage Gaps: Role, Grant & Policy Options ($2.54)

- [x] T-043: Role attributes in SQL generation — $0.55
- [x] T-044: Grant with_grant_option — $0.86
- [x] T-045: Policy permissive flag — $0.64
- [x] T-046: View grants — $0.49

## 17 — Coverage Gaps: CLI & Safety Features ($5.67)

- [x] T-047: drift --apply execution — $3.08
- [x] T-048: Extension drop requires --allow-destructive — $0.60
- [x] T-049: Intermediate state recovery — $0.60
- [x] T-050: Expand/contract YAML-driven in normal run — $1.01
- [x] T-051: --env flag E2E — $0.38

## 18 — Missing Feature Implementation ($11.15)

- [x] T-052: force_rls table attribute — $4.24
- [x] T-053: Custom constraint names — $2.52
- [x] T-054: Column-level check sugar — $0.50
- [x] T-055: description alias for comment — $0.68
- [x] T-056: Seeds enhancements — $0.89
- [x] T-057: Cross-schema FK references — $2.32
- [x] T-058: Expand reverse and batch_size

## 19 — E2E Behavioral Test Suite: Foundation

- [x] T-059: E2E test harness — $0.00

## 20 — E2E Tests: Schema Object Types ($4.94)

- [x] T-060: E2E: Tables — $0.54
- [x] T-061: E2E: Enums — $1.12
- [x] T-062: E2E: Functions — $0.86
- [x] T-063: E2E: Views and materialized views — $1.71
- [x] T-064: E2E: Roles and extensions — $0.71

## 21 — E2E Tests: Constraints, Indexes & Security ($7.18)

- [x] T-065: E2E: Foreign keys — $1.00
- [x] T-066: E2E: Indexes — $1.33
- [x] T-067: E2E: Check and unique constraints — $1.60
- [x] T-068: E2E: RLS policies — $1.39
- [x] T-069: E2E: Grants and triggers — $1.86

## 22 — E2E Tests: Mixins, Seeds, Prechecks, Expand ($4.53)

- [x] T-070: E2E: Mixins — $0.63
- [x] T-071: E2E: Seeds — $0.79
- [x] T-072: E2E: Prechecks — $0.53
- [x] T-073: E2E: Expand/contract lifecycle — $2.58

## 23 — E2E Tests: Safety & Zero-Downtime ($4.87)

- [x] T-074: E2E: Destructive operation blocking — $2.05
- [x] T-075: E2E: Zero-downtime patterns — $1.49
- [x] T-076: E2E: Concurrency and recovery — $1.33

## 24 — E2E Tests: Pipeline & Analysis ($5.45)

- [x] T-077: E2E: Pre/post scripts — $0.50
- [x] T-078: E2E: Drift detection — $2.08
- [x] T-079: E2E: Lint rules — $1.73
- [x] T-080: E2E: Rollback — $1.14

## 25 — E2E Tests: Commands & Generation ($2.42)

- [x] T-081: E2E: Validate and baseline — $0.65
- [x] T-082: E2E: SQL and ERD generation — $0.75
- [x] T-083: E2E: Scaffold and generate from DB — $1.02

## 26 — E2E Tests: Configuration & Status ($1.86)

- [x] T-084: E2E: Config resolution — $0.60
- [x] T-085: E2E: Status command and multi-run behavior — $1.26

## 27 — Introspection Fixes ($0.48)

- [x] T-086: Fix trigger WHEN clause introspection for OLD/NEW expressions — $0.48

## 28 — Idempotent Pipeline Operations ($4.46)

- [x] T-087: Use CREATE ROLE IF NOT EXISTS in role pipeline — $0.34
- [x] T-088: Idempotent enum creation — $0.43
- [x] T-089: Idempotent table creation — $0.42
- [x] T-090: Idempotent materialized view creation — $0.26
- [x] T-091: Idempotent trigger creation — $0.43
- [x] T-092: Idempotent RLS policy creation — $0.37
- [x] T-093: Idempotent index and unique constraint creation — $1.05
- [x] T-094: Idempotent foreign key and check constraint creation — $1.16
- [ ] T-095: Document idempotent pipeline guarantee

**Grand Total: $82.08**
