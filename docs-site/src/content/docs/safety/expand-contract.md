---
title: Expand/contract migrations
description: Zero-downtime column migrations for type changes, renames, and transforms.
---

Expand/contract is a pattern for changing columns without downtime. Instead of altering a column in place (which may lock the table or lose data), you:

1. Add a new column alongside the old one (fast — no row scan).
2. A trigger mirrors writes from the old column into the new one.
3. Backfill existing rows out-of-band (`schema-flow backfill`).
4. Switch the application to the new column.
5. Drop the old column (`schema-flow contract --allow-destructive`).

The same invariant — `new IS DISTINCT FROM transform(old)` — gates the trigger, the backfill loop, and the contract check. It is null-safe by construction, so nullable source columns and identity-transform renames behave correctly.

## Defining an expand

Add `expand` to a column in your table YAML:

```yaml
# schema/tables/users.yaml
table: users
columns:
  - name: id
    type: uuid
    primary_key: true
  - name: email
    type: text
    nullable: false
  - name: email_lower
    type: text
    expand:
      from: email
      transform: 'lower(email)'
      reverse: 'email_lower' # optional — bidirectional dual-write
      batch_size: 5000 # optional — backfill batch size, default 1000
```

### Expand fields

| Field        | Type   | Required | Description                                                               |
| ------------ | ------ | -------- | ------------------------------------------------------------------------- |
| `from`       | string | yes      | Source column name                                                        |
| `transform`  | string | yes      | SQL expression to compute new from old (use the source column for rename) |
| `reverse`    | string | no       | SQL expression to compute old from new — enables bidirectional dual-write |
| `batch_size` | number | no       | Backfill batch size (default: 1000)                                       |

## Workflow

### Step 1: Expand (`run`)

```bash
npx @smplcty/schema-flow run
```

This:

- Creates the new column (`email_lower`).
- Installs a guarded dual-write trigger that mirrors `email` writes into `email_lower`. Direct writes to `email_lower` are preserved (the trigger only fires when the source column actually changes).
- Records state in `_smplcty_schema_flow.expand_state`.

**No row scan, no lock contention** — `run` stays fast regardless of table size.

### Step 2: Backfill (out-of-band)

```bash
npx @smplcty/schema-flow backfill
```

Drains pending backfills in batches. Idempotent and resumable: safe to kill and restart, safe to run multiple times. Background it via your OS of choice:

```bash
nohup schema-flow backfill > backfill.log 2>&1 &
disown
```

Filter to a specific scope and/or parallelise:

```bash
schema-flow backfill --table users
schema-flow backfill --column users.email_lower
schema-flow backfill --concurrency 4
```

### Step 3: Monitor

```bash
npx @smplcty/schema-flow expand-status
```

Shows in-progress migrations along with the per-state count of rows still pending backfill:

```
public.users.email → email_lower: expanded — 1,234 row(s) remaining
```

### Step 4: Switch application

Deploy the app reading + writing the new column. Code that still writes the old column stays in sync via the trigger. Code that writes the new column directly is preserved — the trigger no longer clobbers explicit writes.

### Step 5: Contract

Once backfill has completed:

```bash
npx @smplcty/schema-flow contract --allow-destructive
```

`contract` verifies the invariant `count(*) WHERE new IS DISTINCT FROM transform(old) = 0` and **refuses** if any row diverges:

```
ERROR: 1,234 row(s) still satisfy `email_lower IS DISTINCT FROM (lower(email))`.
       Run `schema-flow backfill` to complete, then re-run contract.
```

Bypass intentionally (rare — only when you accept losing source values for diverged rows):

```bash
npx @smplcty/schema-flow contract --allow-destructive --force --i-understand-data-loss
```

### Step 6: Clean up YAML

Remove the `expand:` block (and the old column entry) from the table file. The next `run` is a no-op.

## State tracking

Expand state lives in `_smplcty_schema_flow.expand_state`:

| Column         | Description                     |
| -------------- | ------------------------------- |
| `table_name`   | Qualified `schema.table`        |
| `new_column`   | New column name                 |
| `old_column`   | Source column name              |
| `transform`    | SQL transform expression        |
| `trigger_name` | Generated trigger name          |
| `status`       | `expanded` or `contracted`      |
| `created_at`   | When the state row was inserted |

The row is inserted automatically by `schema-flow run` when the dual-write trigger is installed.

## Example: zero-downtime column rename

Identity transform — copy with no change. Works for nullable sources without infinite-looping or stranding rows.

```yaml
- name: middle_name_v2
  type: text
  expand:
    from: middle_name
    transform: middle_name # identity → rename
```

Operator sequence:

```bash
schema-flow run                                  # adds column + trigger, fast
nohup schema-flow backfill > backfill.log 2>&1 & # drain off-peak
schema-flow expand-status                        # check progress
# ... deploy app reading + writing middle_name_v2 ...
schema-flow contract --allow-destructive         # drops middle_name once verified
# ... remove `expand:` from YAML ...
```

## Example: change column type

```yaml
- name: amount_numeric
  type: numeric(10, 2)
  expand:
    from: amount
    transform: 'amount::numeric(10,2)'
```

## Example: bidirectional dual-write

Useful during long rolling deploys when both old and new code coexist:

```yaml
- name: price_dollars
  type: numeric
  expand:
    from: price_cents
    transform: 'price_cents / 100.0'
    reverse: 'price_dollars * 100'
```

Writes to either column propagate to the other, so old readers and new readers both see consistent data.
