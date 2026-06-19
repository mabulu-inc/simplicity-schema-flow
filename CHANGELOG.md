# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.0] - 2026-06-19

### Added

- A function whose **return type** changes (e.g. `integer` → `bigint`, or a
  changed `TABLE(...)`/`OUT` column) is now applied with a `DROP FUNCTION …
CASCADE` + `CREATE` instead of failing with `cannot change return type of
existing function`. The drop is gated behind `--allow-destructive` (the
  CASCADE removes dependent policies/views); without the flag the change is
  reported as blocked rather than attempting a create that can't succeed.
- After a CASCADE drop, schema-flow runs a **post-apply convergence pass**: it
  re-plans against the live database, recreates declared policies/views the
  CASCADE removed, and warns if anything is still pending — so a single `run`
  converges instead of silently leaving the schema short of the declared state.
- Before a `DROP FUNCTION … CASCADE`, schema-flow now lists the dependents it
  will drop and **warns about any not declared in the schema** (an ad-hoc view
  or policy a consumer created), so they aren't removed silently.

### Fixed

- A declared **partial unique index** (`unique: true` + `where:`) whose name
  matches an existing plain `UNIQUE` constraint is now built correctly. Before,
  schema-flow emitted a `CREATE … IF NOT EXISTS` that silently did nothing
  (the name was already taken by the constraint), logged "Added index", and
  never converged — the partial predicate was never applied. It now drops the
  conflicting constraint and creates the partial index (gated behind
  `--allow-destructive`); without the flag the change is reported as blocked
  instead of a create that does nothing.
- Functions whose signature uses a type **alias** — `timestamptz`, `int8`,
  `varchar`, `bool`, and friends — no longer re-appear in every plan. Postgres
  stores these under their canonical names (`timestamp with time zone`, …), so
  schema-flow now canonicalises the declared return type, `TABLE(...)` columns,
  and argument types before comparing, instead of matching the raw string.
  A function declared with aliases now converges to zero operations after its
  first apply, and drift no longer reports a phantom difference for it.

## [0.13.0] - 2026-06-16

### Changed

- Seeds are now **insert-only**. A seed row whose key already exists is left
  exactly as it is in the database — schema-flow no longer updates existing rows
  to match the YAML. This keeps reference data that an application edits after
  install (a renamed status, a soft-deleted builtin) safe from being clobbered
  or resurrected on the next apply. To change an already-seeded value, use a
  migration pre/post-script.
- Seeds now use **partial** unique indexes (those with a `where:` clause) for
  match-key de-duplication, matching on the index's columns while ignoring its
  predicate. Because the existence check spans the whole table, a soft-deleted
  builtin still counts as present and is never re-inserted as a second live row.
- When more than one unique key could match a seed, schema-flow now picks the
  best one deterministically — full (table-wide) keys before partial ones, then
  the fewest columns, then declaration order — instead of just the first one
  declared. This makes the chosen key independent of `indexes:` ordering and
  favours the most fundamental identity.

### Removed

- The `seeds_on_conflict` table field has been removed. It only toggled the old
  seed UPDATE behaviour, which no longer exists now that seeds are insert-only;
  remove it from your YAML (the parser now rejects it).

## [0.12.0] - 2026-06-15

### Changed

- When seed rows omit the primary key, schema-flow now also recognises a plain
  unique index (`CREATE UNIQUE INDEX`, not just a `UNIQUE` constraint) as the
  match key for de-duplicating inserts. Previously only unique indexes that
  were also declared as constraints were used, so seeds keyed on an index-only
  unique column could insert duplicate rows on re-runs. Partial unique indexes
  (those with a `where:` filter) are still skipped, since they don't enforce
  uniqueness across the whole table.

## [0.11.3] - 2026-06-13

### Added

- The documentation site now shows the released version as a badge in its
  header, linking to the matching GitHub release. The version is derived from
  the package version at build time, so it always reflects the current release.

## [0.11.2] - 2026-06-11

### Fixed

- Concurrent first-time migrations against one database (one schema each,
  running in parallel) no longer crash while setting up schema-flow's internal
  bookkeeping. Creating the shared `_smplcty_schema_flow` schema and its
  history / snapshot / expand-state tables is not atomic in PostgreSQL even
  with `CREATE ... IF NOT EXISTS`, so two parallel first-runs could race and
  one would fail with a duplicate-object error. The bootstrap now tolerates
  that race and converges. This closes the last gap for running schema-flow
  from many parallel test workers against a shared database.

## [0.11.1] - 2026-06-11

### Fixed

- Parallel migrations against separate schemas in one database no longer
  collide. Constraint existence guards (foreign keys, checks, unique-backed
  and exclusion constraints) now scope their lookup to the target table, not
  just the constraint name — which is unique per schema, not per database. A
  same-named constraint living in another schema (e.g. a sibling test schema,
  or an orphaned `test_*` schema left by a failed run) no longer causes a
  migration to skip its own `ADD CONSTRAINT` and then fail validating it.
  Consumers using one schema per parallel test can drop the
  `fileParallelism: false` workaround. (#58)
- Mixin parameter interpolation no longer treats `{{...}}` tokens inside
  documentation `comment` text as real parameters. A mixin (or any of its
  columns, indexes, checks, triggers, or policies) can now describe its own
  `{{param}}` syntax in a comment without the loader aborting with an "unknown
  or unset mixin param" error. Substitution applies only to structural fields;
  comments and the mixin name are left verbatim.
- Corrected 16 internal documentation links that pointed at the wrong base
  path (`/schema-flow/…` instead of `/simplicity-schema-flow/…`), so
  cross-page links in the docs site now resolve.

### Changed

- Migrations now wait for the advisory lock instead of failing immediately
  when another migration is in progress. Acquisition retries with exponential
  backoff (up to 30s) and only errors if the lock stays held for the whole
  window. Two migrations targeting different schemas in the same database now
  queue and both succeed, rather than the second aborting with "Could not
  acquire advisory lock."

## [0.11.0] - 2026-06-09

### Added

- **Import schema from packages (`imports`).** A new top-level config key loads
  another package's `schema/` directory as additional sources, merged with your
  local schema. The installed dependency version controls the imported
  schema — consume a canonical schema by reference instead of copying YAML
  between repos. Local tables can foreign-key imported tables, use imported
  mixins, and call imported functions; imported objects are treated as managed
  desired state, so they never show up as drift. Resolution is version-pinned
  and works under `pnpm dlx`.
- **Extend imported (or local) tables (`extend:`).** An `extend:` file adds
  columns, indexes, checks, triggers, policies, grants, mixins, and seeds to an
  existing table without redeclaring it — so each app can add its own columns
  to a shared table. Re-declaring an existing column, or extending a table that
  doesn't exist, fails with a clear error.
- **Parameterized mixins (`params`).** A mixin can declare `params` with
  defaults; `{{name}}` placeholders are interpolated into its columns, foreign
  keys, indexes, and policies — and into the function bodies shipped in the same
  package. The consuming app overrides values via `imports[].params`. This lets
  a generic package ship an `audit` mixin (and its trigger functions) without
  coupling to any app's identity model, while keeping the common case
  param-free. Unknown or unset params fail with a clear error.

[Unreleased]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.14.0...HEAD
[0.14.0]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.11.3...v0.12.0
[0.11.3]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.11.2...v0.11.3
[0.11.2]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.11.1...v0.11.2
[0.11.1]: https://github.com/mabulu-inc/simplicity-schema-flow/compare/v0.11.0...v0.11.1
