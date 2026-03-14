---
title: Expand/contract migrations
description: Zero-downtime column migrations for type changes, renames, and transforms.
---

Expand/contract is a pattern for changing columns without downtime. Instead of altering a column in place (which may lock the table or lose data), you:

1. Add a new column alongside the old one
2. Set up a trigger to keep both in sync
3. Backfill existing rows
4. Switch the application to the new column
5. Drop the old column

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
      reverse: 'email'
      batch_size: 5000
```

### Expand fields

| Field        | Type   | Required | Description                                   |
| ------------ | ------ | -------- | --------------------------------------------- |
| `from`       | string | yes      | Source column name                            |
| `transform`  | string | yes      | SQL expression to transform data (old -> new) |
| `reverse`    | string | no       | SQL expression for dual-write (new -> old)    |
| `batch_size` | number | no       | Backfill batch size (default: 1000)           |

## Workflow

### Step 1: Expand

```bash
npx @mabulu-inc/simplicity-schema run
```

This:

- Creates the new column (`email_lower`)
- Creates a dual-write trigger that applies `transform` on every write to `email`
- If `reverse` is defined, also writes back from `email_lower` to `email` on writes
- Backfills existing rows in batches

### Step 2: Monitor

```bash
npx @mabulu-inc/simplicity-schema expand-status
```

Shows in-progress expand/contract migrations and their backfill progress.

### Step 3: Switch application

Update your application to read from and write to the new column. The dual-write trigger keeps both columns in sync during the transition.

### Step 4: Contract

Once the application is fully switched over:

```bash
npx @mabulu-inc/simplicity-schema contract --allow-destructive
```

This drops the old column and the dual-write trigger.

## State tracking

Expand/contract state is tracked in `_simplicity.expand_state`. This table records:

- Which columns are in expand state
- Backfill progress
- Whether contract is ready

## Dual-write trigger

The trigger is created automatically:

```sql
-- Forward: old column writes -> new column
CREATE TRIGGER _simplicity_expand_email_lower
  BEFORE INSERT OR UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION _simplicity_expand_fn('email_lower', 'lower(email)');

-- Reverse (if defined): new column writes -> old column
-- Also handled by the same trigger with reverse expression
```

## Example: rename a column

```yaml
- name: full_name # new name
  type: text
  expand:
    from: name # old name
    transform: 'name'
    reverse: 'full_name'
```

## Example: change column type

```yaml
- name: amount_numeric
  type: numeric(10,2)
  expand:
    from: amount
    transform: 'amount::numeric(10,2)'
```
