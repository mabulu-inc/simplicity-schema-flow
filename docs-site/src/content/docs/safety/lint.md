---
title: Lint rules
description: Static analysis for migration plans.
---

The linter analyzes migration plans before execution and warns about dangerous patterns.

## Usage

```bash
simplicity-schema lint --db postgresql://user:pass@localhost:5432/mydb
```

## Rules

| Rule                      | Severity | Description                                                                                     |
| ------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `set-not-null-direct`     | Warning  | Direct `SET NOT NULL` without the safe CHECK pattern. Can lock the table for a full scan.       |
| `add-column-with-default` | Warning  | Adding a column with a volatile default. May lock the table on older PostgreSQL versions.       |
| `drop-column`             | Warning  | Dropping a column causes data loss.                                                             |
| `drop-table`              | Warning  | Dropping a table causes data loss.                                                              |
| `type-narrowing`          | Warning  | Narrowing a column type (e.g., `text` -> `varchar(50)`) can fail if existing data doesn't fit.  |
| `type-change`             | Warning  | Changing column type may require a full table rewrite.                                          |
| `missing-fk-index`        | Info     | Foreign key column without an index. Causes slow joins and slow cascading deletes.              |
| `rename-detection`        | Info     | Detected a possible rename (drop + add with same type). Consider using expand/contract instead. |

## Programmatic API

```typescript
import { lintPlan } from '@mabulu-inc/simplicity-schema';

const result = lintPlan(plan);

for (const warning of result.warnings) {
  console.log(`[${warning.severity}] ${warning.rule}: ${warning.message}`);
  // warning.operation — the operation that triggered the warning
}
```
