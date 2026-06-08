---
title: Bootstrap tables & sessions
description: Apply and seed selected tables in a transaction that commits before the main migration.
---

Mark a table `bootstrap: true` to apply it — its `CREATE`, indexes, constraints, and seeds — in a **dedicated transaction that commits before the main apply transaction**. This exists for the chicken-and-egg case where the rest of the migration depends on rows that must already be present.

```yaml
table: users
bootstrap: true
columns:
  - { name: user_id, type: serial, primary_key: true }
  - { name: name, type: varchar(100), nullable: false }
seeds:
  - { name: app-init }
```

The classic example is an audit setup: a per-tx hook (via [`--per-tx-sql`](/schema-flow/cli/flags/)) resolves a service user and stamps `app.actor_id` at the start of every transaction. On a fresh database that user doesn't exist yet, so without a bootstrap phase every seed in the main transaction lands unattributed. With it, the service user is committed first and the main-tx hook resolves it.

## Apply order

1. **Pre-scripts** — each in its own tx.
2. **Bootstrap tx** — `bootstrapSession` GUCs are set, any `--per-tx-sql` hook runs, then bootstrap tables are created and seeded; the tx commits.
3. **Main apply tx** — everything else. The per-tx hook here sees the committed bootstrap rows.
4. **Post-scripts**, then the **tighten** phase — unchanged.

## Rules and behaviour

- **No FK to a non-bootstrap table.** A bootstrap table can't have a foreign key to a table this migration creates outside the bootstrap set — it wouldn't exist yet when the bootstrap tx runs. The planner rejects this at `plan` time, naming the offending FK. (An FK to a table that already exists in the database is fine.) Bootstrap-to-bootstrap FKs are allowed.

- **Triggers run before user-defined functions exist.** Because the bootstrap tx commits before the main apply tx, any `CREATE FUNCTION` in your migration has **not run yet** when the bootstrap table is created and seeded. If the bootstrap table carries a trigger that calls one of those functions, the bootstrap seed fails with `function … does not exist`. Keep bootstrap tables free of trigger dependencies on objects the same migration creates — attach those triggers to non-bootstrap tables, or define the function outside the migration.

- **Session settings.** The bootstrap tx sets `smplcty.bootstrap = 'true'` for its duration, so triggers/hooks can detect it generically with `current_setting('smplcty.bootstrap', true)`. You can set your own GUCs alongside it via `bootstrapSession` (below).

- **Audit columns on the bootstrap table itself.** The very first service-user row has nothing to stamp it (the hook is lenient inside the bootstrap tx, before the table exists). Give that seed explicit `created_by`/`updated_by` values — it's the first row, so it can reference its own known id. Combined with a `bootstrapSession` lenient GUC so the trigger doesn't overwrite them, this removes the need for any audit-backfill post-script.

## `bootstrapSession`

`bootstrapSession` is a **config-file-only** map of session settings applied (as `SET LOCAL`) for the duration of the bootstrap transaction, alongside the built-in `smplcty.bootstrap = 'true'`. Its type is `Record<string, string | number | boolean>`.

```js
// schema-flow.config.js
export default {
  bootstrapSession: {
    'app.audit_lenient': true,
  },
};
```

Point it at a GUC your own triggers already check so bootstrap seeds behave the way you need without touching the trigger. The values are rendered into `SET LOCAL`, so they apply only inside the bootstrap tx and reset automatically when it commits.

See [Configuration](/schema-flow/getting-started/configuration/) for where this sits among the other config keys.

## See also

- [Seeds](/schema-flow/schema/seeds/) — the seeding mechanics bootstrap tables reuse.
- [Execution phases](/schema-flow/architecture/execution-phases/) — full transaction ordering.
