---
title: Zero-downtime patterns
description: How schema-flow avoids locking and downtime during migrations.
---

Zero-downtime is not a mode you opt into — it is how schema-flow applies every
migration. The lock-friendly SQL below (`NOT VALID` foreign keys, `CONCURRENTLY`
indexes, safe `NOT NULL`) is only half the story; the other half is **how those
statements are committed**, which is what the per-table transaction model
guarantees.

## Per-table transactions

A migration is applied as **one transaction per table**, each guarded by
`lock_timeout` and retried on contention. It is never wrapped in a single
transaction spanning the whole diff.

That distinction is the whole game. Lock-friendly DDL generation is wasted if
every statement runs inside one giant transaction: that transaction acquires
`ACCESS EXCLUSIVE` on every table it touches and **holds all of those locks
until the final commit**. Under live traffic it queues behind an active write,
and a queued `ACCESS EXCLUSIVE` lock blocks every subsequent query on that
table — freezing it for the entire migration. Splitting per table means each
lock is held only for that table's handful of statements, then released.

```text
ALTER TABLE orders …      ┐ one transaction, lock_timeout set,
ALTER TABLE orders …      ┘ retried with backoff if "orders" is busy
ALTER TABLE items  …      ┐ next table → next transaction
ALTER TABLE items  …      ┘
```

- **`lock_timeout` per group** (`--lock-timeout`, default `5000`ms): a blocked
  group aborts cleanly instead of queuing and freezing the table behind it.
- **Retry with backoff** (`--max-retries`, default `3`): under live traffic each
  brief lock slips through a micro-gap within a few attempts. Exhausting the
  retries fails the run with the contended table named.
- **Re-run to converge**: an interrupted migration leaves a valid partial schema
  (earlier tables committed). Re-running recomputes the diff from live state and
  applies only what's left — every statement is idempotent, so this is recovery
  by re-run, not manual surgery. See
  [failure recovery](/simplicity-schema-flow/architecture/execution-phases/#failure-recovery-re-run-to-converge).

The result: large migrations thread through live writers without a maintenance
window. There is no single-transaction switch to forget, and no separate "online
mode" — this is the default and only behaviour.

## Foreign keys: NOT VALID + VALIDATE

Foreign keys are added in two steps to avoid full table scans under lock:

```sql
-- Step 1: instant, no table scan
ALTER TABLE orders ADD CONSTRAINT fk_orders_user
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

-- Step 2: scans table but doesn't hold ACCESS EXCLUSIVE lock
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
```

**Partitioned parents are the exception.** PostgreSQL rejects `NOT VALID`
foreign keys on a partitioned table, so on a
[partitioned parent](/simplicity-schema-flow/schema/partitioning/) schema-flow
emits a single immediately-validated `ADD CONSTRAINT … FOREIGN KEY` instead. It
propagates to every partition automatically.

## Safe NOT NULL

Setting a column to `NOT NULL` without locking the table:

```sql
-- 1. Add check constraint without validating
ALTER TABLE users ADD CONSTRAINT chk_users_email_nn
  CHECK (email IS NOT NULL) NOT VALID;

-- 2. Validate (scans without ACCESS EXCLUSIVE lock)
ALTER TABLE users VALIDATE CONSTRAINT chk_users_email_nn;

-- 3. Set NOT NULL (instant — PG trusts the validated check)
ALTER TABLE users ALTER COLUMN email SET NOT NULL;

-- 4. Drop redundant check
ALTER TABLE users DROP CONSTRAINT chk_users_email_nn;
```

## Safe unique constraints

```sql
-- 1. Non-blocking index creation
CREATE UNIQUE INDEX CONCURRENTLY idx_users_email ON users(email);

-- 2. Instant constraint using the index
ALTER TABLE users ADD CONSTRAINT uq_users_email UNIQUE USING INDEX idx_users_email;
```

## Indexes with CONCURRENTLY

Indexes are created using `CREATE INDEX CONCURRENTLY` outside of a transaction where possible. This avoids holding locks during index creation on large tables.

If a `CONCURRENTLY` operation fails, it leaves an invalid index. Use `detectInvalidIndexes()` and `reindexInvalid()` to find and retry them.

**Partitioned parents are the exception.** PostgreSQL rejects `CREATE INDEX
CONCURRENTLY` on a partitioned table, so on a
[partitioned parent](/simplicity-schema-flow/schema/partitioning/) schema-flow
emits a plain `CREATE INDEX`. Postgres builds each child partition's index and
attaches it to the parent.

## Pre-migration checks

Tables can define assertions that must pass before migration proceeds:

```yaml
prechecks:
  - name: no_orphaned_rows
    query: 'SELECT count(*) = 0 FROM child WHERE parent_id NOT IN (SELECT id FROM parent)'
    message: 'Orphaned rows exist — clean up before migration'
```

If any precheck returns a falsy value, migration aborts with the provided message.
