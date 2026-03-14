---
title: Drift & lint
description: Drift detection and static analysis APIs.
---

## Drift detection

```typescript
import { detectDrift } from '@mabulu-inc/simplicity-schema';

const report = detectDrift(desired, actual);

for (const item of report.items) {
  console.log(`${item.status}: ${item.type} ${item.object}`);
}

console.log(`Total drift items: ${report.summary.total}`);
console.log('By type:', report.summary.byType);
```

### DriftReport

```typescript
interface DriftReport {
  items: DriftItem[];
  summary: {
    total: number;
    byType: Record<string, number>;
  };
}
```

### DriftItem

```typescript
interface DriftItem {
  type:
    | 'table'
    | 'column'
    | 'index'
    | 'constraint'
    | 'enum'
    | 'function'
    | 'view'
    | 'materialized_view'
    | 'role'
    | 'grant'
    | 'trigger'
    | 'policy'
    | 'comment'
    | 'seed';
  object: string; // e.g., "users.email"
  status: 'missing_in_db' | 'missing_in_yaml' | 'different';
  expected?: string; // YAML value
  actual?: string; // DB value
  detail?: string; // human-readable description
}
```

### What's compared

- Tables, columns (type, default, nullability, generated)
- Indexes (columns, uniqueness, method, WHERE, INCLUDE, opclass)
- Constraints (checks, foreign keys, unique)
- Enums (values and order)
- Functions (body, args, return type, security, volatility, parallel, strict, leakproof, cost, rows, SET)
- Views and materialized views (query)
- Roles (all attributes, memberships)
- Grants (table, column, sequence, function, with_grant_option)
- Triggers (timing, events, for_each, when, function)
- RLS policies (for, to, using, check, permissive)
- Comments on all object types
- Seeds (row existence, values)

## Lint

```typescript
import { lintPlan } from '@mabulu-inc/simplicity-schema';

const result = lintPlan(plan);

for (const warning of result.warnings) {
  console.log(`[${warning.severity}] ${warning.rule}: ${warning.message}`);
}
```

### LintResult

```typescript
interface LintResult {
  warnings: LintWarning[];
}

interface LintWarning {
  rule: string;
  severity: 'warning' | 'info';
  message: string;
  operation: Operation;
}
```
