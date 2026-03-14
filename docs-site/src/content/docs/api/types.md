---
title: Types
description: All exported TypeScript types.
---

All types are exported from `@mabulu-inc/simplicity-schema`.

## Schema types

```typescript
import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  CheckDef,
  UniqueConstraintDef,
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
} from '@mabulu-inc/simplicity-schema';
```

## Enum types

```typescript
import type {
  ForeignKeyAction, // 'CASCADE' | 'SET NULL' | 'SET DEFAULT' | 'RESTRICT' | 'NO ACTION'
  IndexMethod, // 'btree' | 'gin' | 'gist' | 'hash' | 'brin'
  FunctionSecurity, // 'invoker' | 'definer'
  FunctionVolatility, // 'volatile' | 'stable' | 'immutable'
  FunctionParallel, // 'unsafe' | 'safe' | 'restricted'
  FunctionArgMode, // 'IN' | 'OUT' | 'INOUT' | 'VARIADIC'
  TriggerTiming, // 'BEFORE' | 'AFTER' | 'INSTEAD OF'
  TriggerEvent, // 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE'
  TriggerForEach, // 'ROW' | 'STATEMENT'
  PolicyCommand, // 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'ALL'
} from '@mabulu-inc/simplicity-schema';
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
} from '@mabulu-inc/simplicity-schema';
```

## Drift types

```typescript
import type { DriftReport, DriftItem, DriftItemType, DriftStatus } from '@mabulu-inc/simplicity-schema';
```

## Lint types

```typescript
import type { LintResult, LintWarning, LintSeverity } from '@mabulu-inc/simplicity-schema';
```

## Executor types

```typescript
import type { ExecuteOptions, ExecuteResult, InvalidIndex } from '@mabulu-inc/simplicity-schema';
```

## Rollback types

```typescript
import type { MigrationSnapshot, RollbackResult, RunDownOptions, RunDownResult } from '@mabulu-inc/simplicity-schema';
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
} from '@mabulu-inc/simplicity-schema';
```

## Generation types

```typescript
import type { GenerateInput, GeneratedFile, GenerateSqlOptions } from '@mabulu-inc/simplicity-schema';
```

## Config types

```typescript
import type { SimplicitySchemaConfig, ConfigOverrides } from '@mabulu-inc/simplicity-schema';
```

## Logger types

```typescript
import type { Logger, LoggerOptions } from '@mabulu-inc/simplicity-schema';

import { LogLevel } from '@mabulu-inc/simplicity-schema';
```

## File types

```typescript
import type { Phase, SchemaFile, DiscoveredFiles, SchemaKind, ParsedSchema } from '@mabulu-inc/simplicity-schema';
```

## Pipeline types

```typescript
import type { PipelineOptions, StatusResult, BaselineResult } from '@mabulu-inc/simplicity-schema';
```

## Database types

```typescript
import type { ClientOptions } from '@mabulu-inc/simplicity-schema';
```

## Mixin types

```typescript
import type { MixinRegistry } from '@mabulu-inc/simplicity-schema';
```
