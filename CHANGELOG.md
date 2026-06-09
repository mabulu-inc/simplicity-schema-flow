# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
