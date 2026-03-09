import { parse as parseYaml } from 'yaml';
import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  IndexMethod,
  CheckDef,
  UniqueConstraintDef,
  TriggerDef,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  PolicyDef,
  PolicyCommand,
  GrantDef,
  FunctionGrantDef,
  PrecheckDef,
  ForeignKeyRef,
  ForeignKeyAction,
  ExpandDef,
  EnumSchema,
  FunctionSchema,
  FunctionArg,
  FunctionArgMode,
  FunctionSecurity,
  FunctionVolatility,
  FunctionParallel,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ExtensionsSchema,
  SchemaGrant,
  MixinSchema,
} from './types.js';

// ─── Helpers ────────────────────────────────────────────────────

function requireString(obj: Record<string, unknown>, field: string, context: string): string {
  const val = obj[field];
  if (typeof val !== 'string' || val.length === 0) {
    throw new Error(`${context}: "${field}" is required and must be a non-empty string`);
  }
  return val;
}

function requireArray<T>(obj: Record<string, unknown>, field: string, context: string): T[] {
  const val = obj[field];
  if (!Array.isArray(val) || val.length === 0) {
    throw new Error(`${context}: "${field}" is required and must be a non-empty array`);
  }
  return val as T[];
}

function optionalString(obj: Record<string, unknown>, field: string): string | undefined {
  const val = obj[field];
  return typeof val === 'string' ? val : undefined;
}

function validateEnum<T extends string>(value: string, allowed: readonly T[], field: string, context: string): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`${context}: "${field}" must be one of [${allowed.join(', ')}], got "${value}"`);
  }
  return value as T;
}

// ─── Column Parsing ─────────────────────────────────────────────

const FK_ACTIONS: readonly ForeignKeyAction[] = ['CASCADE', 'SET NULL', 'SET DEFAULT', 'RESTRICT', 'NO ACTION'];

function parseColumnDef(raw: Record<string, unknown>, context: string): ColumnDef {
  const col: ColumnDef = {
    name: requireString(raw, 'name', context),
    type: requireString(raw, 'type', context),
  };

  if (raw.nullable !== undefined) col.nullable = Boolean(raw.nullable);
  if (raw.primary_key !== undefined) col.primary_key = Boolean(raw.primary_key);
  if (raw.unique !== undefined) col.unique = Boolean(raw.unique);
  if (raw.default !== undefined) col.default = String(raw.default);
  if (raw.comment !== undefined) col.comment = String(raw.comment);
  if (raw.generated !== undefined) col.generated = String(raw.generated);

  if (raw.references != null) {
    const ref = raw.references as Record<string, unknown>;
    const fk: ForeignKeyRef = {
      table: requireString(ref, 'table', `${context}.references`),
      column: requireString(ref, 'column', `${context}.references`),
    };
    if (ref.on_delete !== undefined) fk.on_delete = validateEnum(String(ref.on_delete), FK_ACTIONS, 'on_delete', `${context}.references`);
    if (ref.on_update !== undefined) fk.on_update = validateEnum(String(ref.on_update), FK_ACTIONS, 'on_update', `${context}.references`);
    if (ref.deferrable !== undefined) fk.deferrable = Boolean(ref.deferrable);
    if (ref.initially_deferred !== undefined) fk.initially_deferred = Boolean(ref.initially_deferred);
    col.references = fk;
  }

  if (raw.expand != null) {
    const exp = raw.expand as Record<string, unknown>;
    col.expand = {
      from: requireString(exp, 'from', `${context}.expand`),
      transform: requireString(exp, 'transform', `${context}.expand`),
    } satisfies ExpandDef;
  }

  return col;
}

// ─── Index Parsing ──────────────────────────────────────────────

const INDEX_METHODS: readonly IndexMethod[] = ['btree', 'gin', 'gist', 'hash', 'brin'];

function parseIndexDef(raw: Record<string, unknown>, context: string): IndexDef {
  const idx: IndexDef = {
    columns: requireArray<string>(raw, 'columns', context),
  };
  if (raw.name !== undefined) idx.name = String(raw.name);
  if (raw.unique !== undefined) idx.unique = Boolean(raw.unique);
  if (raw.method !== undefined) idx.method = validateEnum(String(raw.method), INDEX_METHODS, 'method', context);
  if (raw.where !== undefined) idx.where = String(raw.where);
  if (raw.include !== undefined) idx.include = raw.include as string[];
  if (raw.opclass !== undefined) idx.opclass = String(raw.opclass);
  return idx;
}

// ─── Trigger Parsing ────────────────────────────────────────────

const TRIGGER_TIMINGS: readonly TriggerTiming[] = ['BEFORE', 'AFTER', 'INSTEAD OF'];
const TRIGGER_EVENTS: readonly TriggerEvent[] = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
const TRIGGER_FOR_EACH: readonly TriggerForEach[] = ['ROW', 'STATEMENT'];

function parseTriggerDef(raw: Record<string, unknown>, context: string): TriggerDef {
  const trig: TriggerDef = {
    name: requireString(raw, 'name', context),
    timing: validateEnum(String(raw.timing), TRIGGER_TIMINGS, 'timing', context),
    events: requireArray<string>(raw, 'events', context).map(
      e => validateEnum(String(e), TRIGGER_EVENTS, 'events', context),
    ),
    function: requireString(raw, 'function', context),
  };
  if (raw.for_each !== undefined) trig.for_each = validateEnum(String(raw.for_each), TRIGGER_FOR_EACH, 'for_each', context);
  if (raw.when !== undefined) trig.when = String(raw.when);
  return trig;
}

// ─── Policy Parsing ─────────────────────────────────────────────

const POLICY_COMMANDS: readonly PolicyCommand[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'ALL'];

function parsePolicyDef(raw: Record<string, unknown>, context: string): PolicyDef {
  const pol: PolicyDef = {
    name: requireString(raw, 'name', context),
    to: requireString(raw, 'to', context),
  };
  if (raw.for !== undefined) pol.for = validateEnum(String(raw.for), POLICY_COMMANDS, 'for', context);
  if (raw.using !== undefined) pol.using = String(raw.using);
  if (raw.check !== undefined) pol.check = String(raw.check);
  if (raw.permissive !== undefined) pol.permissive = Boolean(raw.permissive);
  return pol;
}

// ─── Grant Parsing ──────────────────────────────────────────────

function parseGrantDef(raw: Record<string, unknown>, context: string): GrantDef {
  const grant: GrantDef = {
    to: requireString(raw, 'to', context),
    privileges: requireArray<string>(raw, 'privileges', context),
  };
  if (raw.columns !== undefined) grant.columns = raw.columns as string[];
  if (raw.with_grant_option !== undefined) grant.with_grant_option = Boolean(raw.with_grant_option);
  return grant;
}

function parseFunctionGrantDef(raw: Record<string, unknown>, context: string): FunctionGrantDef {
  return {
    to: requireString(raw, 'to', context),
    privileges: requireArray<string>(raw, 'privileges', context),
  };
}

// ─── Check / Unique / Precheck Parsing ──────────────────────────

function parseCheckDef(raw: Record<string, unknown>, context: string): CheckDef {
  const chk: CheckDef = {
    name: requireString(raw, 'name', context),
    expression: requireString(raw, 'expression', context),
  };
  if (raw.comment !== undefined) chk.comment = String(raw.comment);
  return chk;
}

function parseUniqueConstraintDef(raw: Record<string, unknown>, context: string): UniqueConstraintDef {
  const uc: UniqueConstraintDef = {
    columns: requireArray<string>(raw, 'columns', context),
  };
  if (raw.name !== undefined) uc.name = String(raw.name);
  return uc;
}

function parsePrecheckDef(raw: Record<string, unknown>, context: string): PrecheckDef {
  return {
    name: requireString(raw, 'name', context),
    query: requireString(raw, 'query', context),
    message: requireString(raw, 'message', context),
  };
}

// ─── Top-level Parsers ──────────────────────────────────────────

export function parseTable(yamlStr: string): TableSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'table';

  const table: TableSchema = {
    table: requireString(raw, 'table', ctx),
    columns: requireArray<Record<string, unknown>>(raw, 'columns', ctx).map(
      (c, i) => parseColumnDef(c, `${ctx}.columns[${i}]`),
    ),
  };

  if (raw.primary_key !== undefined) table.primary_key = raw.primary_key as string[];
  if (raw.indexes !== undefined) table.indexes = (raw.indexes as Record<string, unknown>[]).map(
    (idx, i) => parseIndexDef(idx, `${ctx}.indexes[${i}]`),
  );
  if (raw.checks !== undefined) table.checks = (raw.checks as Record<string, unknown>[]).map(
    (c, i) => parseCheckDef(c, `${ctx}.checks[${i}]`),
  );
  if (raw.unique_constraints !== undefined) table.unique_constraints = (raw.unique_constraints as Record<string, unknown>[]).map(
    (uc, i) => parseUniqueConstraintDef(uc, `${ctx}.unique_constraints[${i}]`),
  );
  if (raw.triggers !== undefined) table.triggers = (raw.triggers as Record<string, unknown>[]).map(
    (t, i) => parseTriggerDef(t, `${ctx}.triggers[${i}]`),
  );
  if (raw.policies !== undefined) table.policies = (raw.policies as Record<string, unknown>[]).map(
    (p, i) => parsePolicyDef(p, `${ctx}.policies[${i}]`),
  );
  if (raw.grants !== undefined) table.grants = (raw.grants as Record<string, unknown>[]).map(
    (g, i) => parseGrantDef(g, `${ctx}.grants[${i}]`),
  );
  if (raw.prechecks !== undefined) table.prechecks = (raw.prechecks as Record<string, unknown>[]).map(
    (p, i) => parsePrecheckDef(p, `${ctx}.prechecks[${i}]`),
  );
  if (raw.seeds !== undefined) table.seeds = raw.seeds as Record<string, unknown>[];
  if (raw.mixins !== undefined) table.mixins = raw.mixins as string[];
  if (raw.comment !== undefined) table.comment = String(raw.comment);

  return table;
}

export function parseEnum(yamlStr: string): EnumSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'enum';

  return {
    name: requireString(raw, 'name', ctx),
    values: requireArray<string>(raw, 'values', ctx),
    ...(raw.comment !== undefined && { comment: String(raw.comment) }),
  };
}

export function parseFunction(yamlStr: string): FunctionSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'function';

  const SECURITY: readonly FunctionSecurity[] = ['invoker', 'definer'];
  const VOLATILITY: readonly FunctionVolatility[] = ['volatile', 'stable', 'immutable'];
  const PARALLEL: readonly FunctionParallel[] = ['unsafe', 'safe', 'restricted'];
  const ARG_MODES: readonly FunctionArgMode[] = ['IN', 'OUT', 'INOUT', 'VARIADIC'];

  const fn: FunctionSchema = {
    name: requireString(raw, 'name', ctx),
    language: requireString(raw, 'language', ctx),
    returns: requireString(raw, 'returns', ctx),
    body: requireString(raw, 'body', ctx),
  };

  if (raw.args !== undefined) {
    fn.args = (raw.args as Record<string, unknown>[]).map((a, i) => {
      const arg: FunctionArg = {
        name: requireString(a, 'name', `${ctx}.args[${i}]`),
        type: requireString(a, 'type', `${ctx}.args[${i}]`),
      };
      if (a.mode !== undefined) arg.mode = validateEnum(String(a.mode), ARG_MODES, 'mode', `${ctx}.args[${i}]`);
      if (a.default !== undefined) arg.default = String(a.default);
      return arg;
    });
  }

  if (raw.security !== undefined) fn.security = validateEnum(String(raw.security), SECURITY, 'security', ctx);
  if (raw.volatility !== undefined) fn.volatility = validateEnum(String(raw.volatility), VOLATILITY, 'volatility', ctx);
  if (raw.parallel !== undefined) fn.parallel = validateEnum(String(raw.parallel), PARALLEL, 'parallel', ctx);
  if (raw.strict !== undefined) fn.strict = Boolean(raw.strict);
  if (raw.leakproof !== undefined) fn.leakproof = Boolean(raw.leakproof);
  if (raw.cost !== undefined) fn.cost = Number(raw.cost);
  if (raw.rows !== undefined) fn.rows = Number(raw.rows);
  if (raw.set !== undefined) fn.set = raw.set as Record<string, string>;
  if (raw.grants !== undefined) fn.grants = (raw.grants as Record<string, unknown>[]).map(
    (g, i) => parseFunctionGrantDef(g, `${ctx}.grants[${i}]`),
  );
  if (raw.comment !== undefined) fn.comment = String(raw.comment);

  return fn;
}

export function parseView(yamlStr: string): ViewSchema | MaterializedViewSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'view';

  const name = requireString(raw, 'name', ctx);
  const query = requireString(raw, 'query', ctx);

  if (raw.materialized === true) {
    const mv: MaterializedViewSchema = {
      name,
      materialized: true,
      query,
    };
    if (raw.indexes !== undefined) mv.indexes = (raw.indexes as Record<string, unknown>[]).map(
      (idx, i) => parseIndexDef(idx, `${ctx}.indexes[${i}]`),
    );
    if (raw.grants !== undefined) mv.grants = (raw.grants as Record<string, unknown>[]).map(
      (g, i) => parseGrantDef(g, `${ctx}.grants[${i}]`),
    );
    if (raw.comment !== undefined) mv.comment = String(raw.comment);
    return mv;
  }

  const view: ViewSchema = { name, query };
  if (raw.grants !== undefined) view.grants = (raw.grants as Record<string, unknown>[]).map(
    (g, i) => parseGrantDef(g, `${ctx}.grants[${i}]`),
  );
  if (raw.comment !== undefined) view.comment = String(raw.comment);
  return view;
}

export function parseRole(yamlStr: string): RoleSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'role';

  const role: RoleSchema = {
    role: requireString(raw, 'role', ctx),
  };

  if (raw.login !== undefined) role.login = Boolean(raw.login);
  if (raw.superuser !== undefined) role.superuser = Boolean(raw.superuser);
  if (raw.createdb !== undefined) role.createdb = Boolean(raw.createdb);
  if (raw.createrole !== undefined) role.createrole = Boolean(raw.createrole);
  if (raw.inherit !== undefined) role.inherit = Boolean(raw.inherit);
  if (raw.bypassrls !== undefined) role.bypassrls = Boolean(raw.bypassrls);
  if (raw.replication !== undefined) role.replication = Boolean(raw.replication);
  if (raw.connection_limit !== undefined) role.connection_limit = Number(raw.connection_limit);
  if (raw.in !== undefined) role.in = raw.in as string[];
  if (raw.comment !== undefined) role.comment = String(raw.comment);

  return role;
}

export function parseExtensions(yamlStr: string): ExtensionsSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'extensions';

  const ext: ExtensionsSchema = {
    extensions: requireArray<string>(raw, 'extensions', ctx),
  };

  if (raw.schema_grants !== undefined) {
    ext.schema_grants = (raw.schema_grants as Record<string, unknown>[]).map((sg, i) => ({
      to: requireString(sg, 'to', `${ctx}.schema_grants[${i}]`),
      schemas: requireArray<string>(sg, 'schemas', `${ctx}.schema_grants[${i}]`),
    } satisfies SchemaGrant));
  }

  return ext;
}

export function parseMixin(yamlStr: string): MixinSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;
  const ctx = 'mixin';

  const mixin: MixinSchema = {
    mixin: requireString(raw, 'mixin', ctx),
  };

  if (raw.columns !== undefined) mixin.columns = (raw.columns as Record<string, unknown>[]).map(
    (c, i) => parseColumnDef(c, `${ctx}.columns[${i}]`),
  );
  if (raw.indexes !== undefined) mixin.indexes = (raw.indexes as Record<string, unknown>[]).map(
    (idx, i) => parseIndexDef(idx, `${ctx}.indexes[${i}]`),
  );
  if (raw.checks !== undefined) mixin.checks = (raw.checks as Record<string, unknown>[]).map(
    (c, i) => parseCheckDef(c, `${ctx}.checks[${i}]`),
  );
  if (raw.triggers !== undefined) mixin.triggers = (raw.triggers as Record<string, unknown>[]).map(
    (t, i) => parseTriggerDef(t, `${ctx}.triggers[${i}]`),
  );
  if (raw.policies !== undefined) mixin.policies = (raw.policies as Record<string, unknown>[]).map(
    (p, i) => parsePolicyDef(p, `${ctx}.policies[${i}]`),
  );
  if (raw.grants !== undefined) mixin.grants = (raw.grants as Record<string, unknown>[]).map(
    (g, i) => parseGrantDef(g, `${ctx}.grants[${i}]`),
  );
  if (raw.rls !== undefined) mixin.rls = Boolean(raw.rls);

  return mixin;
}

// ─── Auto-detect Schema Kind ────────────────────────────────────

export type SchemaKind = 'table' | 'enum' | 'function' | 'view' | 'materialized_view' | 'role' | 'extensions' | 'mixin';

export type ParsedSchema =
  | { kind: 'table'; schema: TableSchema }
  | { kind: 'enum'; schema: EnumSchema }
  | { kind: 'function'; schema: FunctionSchema }
  | { kind: 'view'; schema: ViewSchema }
  | { kind: 'materialized_view'; schema: MaterializedViewSchema }
  | { kind: 'role'; schema: RoleSchema }
  | { kind: 'extensions'; schema: ExtensionsSchema }
  | { kind: 'mixin'; schema: MixinSchema };

export function parseSchemaFile(yamlStr: string): ParsedSchema {
  const raw = parseYaml(yamlStr) as Record<string, unknown>;

  if (raw.table !== undefined) {
    return { kind: 'table', schema: parseTable(yamlStr) };
  }
  if (raw.role !== undefined) {
    return { kind: 'role', schema: parseRole(yamlStr) };
  }
  if (raw.mixin !== undefined) {
    return { kind: 'mixin', schema: parseMixin(yamlStr) };
  }
  if (raw.extensions !== undefined) {
    return { kind: 'extensions', schema: parseExtensions(yamlStr) };
  }
  // Discriminate between enum, function, and view — all have "name"
  if (raw.name !== undefined) {
    if (raw.values !== undefined) {
      return { kind: 'enum', schema: parseEnum(yamlStr) };
    }
    if (raw.language !== undefined || raw.body !== undefined) {
      return { kind: 'function', schema: parseFunction(yamlStr) };
    }
    if (raw.query !== undefined) {
      const result = parseView(yamlStr);
      if (raw.materialized === true) {
        return { kind: 'materialized_view', schema: result as MaterializedViewSchema };
      }
      return { kind: 'view', schema: result as ViewSchema };
    }
  }

  throw new Error('Unrecognized schema file: could not detect schema kind from YAML content');
}
