---
title: Zero-downtime patterns
description: How simplicity-schema avoids locking and downtime during migrations.
---

## Foreign keys: NOT VALID + VALIDATE

Foreign keys are added in two steps to avoid full table scans under lock:

```sql
-- Step 1: instant, no table scan
ALTER TABLE orders ADD CONSTRAINT fk_orders_user
  FOREIGN KEY (user_id) REFERENCES users(id) NOT VALID;

-- Step 2: scans table but doesn't hold ACCESS EXCLUSIVE lock
ALTER TABLE orders VALIDATE CONSTRAINT fk_orders_user;
```

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

## Pre-migration checks

Tables can define assertions that must pass before migration proceeds:

```yaml
prechecks:
  - name: no_orphaned_rows
    query: 'SELECT count(*) = 0 FROM child WHERE parent_id NOT IN (SELECT id FROM parent)'
    message: 'Orphaned rows exist — clean up before migration'
```

If any precheck returns a falsy value, migration aborts with the provided message.
