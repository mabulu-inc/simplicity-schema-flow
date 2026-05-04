---
title: Types
description: All exported TypeScript types.
---

All types are exported from `@smplcty/schema-flow`.

## Schema types

```typescript
import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  IndexKey, // string | { expression } | IndexColumn
  IndexColumn, // { column, order?, nulls? }
  CheckDef,
  UniqueConstraintDef,
  ExclusionConstraintDef,
  ExclusionConstraintElement,
  TriggerDef,
  PolicyDef,
  MixinSchema,
  FunctionSchema,
  FunctionArg,
  EnumSchema,
  ExtensionsSchema,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  GrantDef,
  FunctionGrantDef,
  PrecheckDef,
  SeedRow,
  ExpandDef,
  ForeignKeyRef,
  SchemaGrant,
} from '@smplcty/schema-flow';
```

## Enum types

```typescript
import type {
  ForeignKeyAction, // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  IndexMethod, // 'btree' | 'gin' | 'gist' | 'hash' | 'brin'
  IndexOrder, // 'ASC' | 'DESC'
  IndexNulls, // 'FIRST' | 'LAST'
  FunctionSecurity, // 'invoker' | 'definer'
  FunctionVolatility, // 'volatile' | 'stable' | 'immutable'
  FunctionParallel, // 'unsafe' | 'safe' | 'restricted'
  FunctionArgMode, // 'IN' | 'OUT' | 'INOUT' | 'VARIADIC'
  TriggerTiming, // 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  TriggerEvent, // 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
  TriggerForEach, // 'ROW' | 'STATEMENT'
  PolicyCommand, // 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'
} from '@smplcty/schema-flow';
```

## Planner types

```typescript
import type {
  Operation,
  OperationType,
  PlanResult,
  PlanOptions,
  DesiredState,
  ActualState,
} from '@smplcty/schema-flow';
```

## Drift types

```typescript
import type { DriftReport, DriftItem, DriftItemType, DriftStatus } from '@smplcty/schema-flow';
```

## Lint types

```typescript
import type { LintResult, LintWarning, LintSeverity } from '@smplcty/schema-flow';
```

## Executor types

```typescript
import type { ExecuteOptions, ExecuteResult, InvalidIndex } from '@smplcty/schema-flow';
```

## Rollback types

```typescript
import type { MigrationSnapshot, RollbackResult, RunDownOptions, RunDownResult } from '@smplcty/schema-flow';
```

## Expand types

```typescript
import type {
  ExpandState,
  ExpandOperationType,
  ExpandOperation,
  BackfillOptions,
  BackfillResult,
  ContractOptions,
  ContractResult,
} from '@smplcty/schema-flow';
```

## Generation types

```typescript
import type { GenerateInput, GeneratedFile, GenerateSqlOptions } from '@smplcty/schema-flow';
```

## Config types

```typescript
import type { SimplicitySchemaConfig, ConfigOverrides } from '@smplcty/schema-flow';
```

## Logger types

```typescript
import type { Logger, LoggerOptions } from '@smplcty/schema-flow';

import { LogLevel } from '@smplcty/schema-flow';
```

## File types

```typescript
import type { Phase, SchemaFile, DiscoveredFiles, SchemaKind, ParsedSchema } from '@smplcty/schema-flow';
```

## Pipeline types

```typescript
import type { PipelineOptions, StatusResult, BaselineResult } from '@smplcty/schema-flow';
```

## Database types

```typescript
import type { ClientOptions } from '@smplcty/schema-flow';
```

## Mixin types

```typescript
import type { MixinRegistry } from '@smplcty/schema-flow';
```
