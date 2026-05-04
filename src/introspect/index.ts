/**
 * Database introspection for schema-flow.
 *
 * Queries pg_catalog / information_schema to read current DB state and
 * return typed data structures matching the schema types.
 */

import type pg from 'pg';
import type {
  TableSchema,
  ColumnDef,
  IndexDef,
  CheckDef,
  TriggerDef,
  PolicyDef,
  GrantDef,
  ExclusionConstraintDef,
  EnumSchema,
  FunctionSchema,
  FunctionArg,
  ViewSchema,
  MaterializedViewSchema,
  RoleSchema,
  ForeignKeyAction,
  ForeignKeyRef,
  TriggerTiming,
  TriggerEvent,
  TriggerForEach,
  PolicyCommand,
  FunctionSecurity,
  FunctionVolatility,
  FunctionParallel,
} from '../schema/types.js';

type Client = pg.PoolClient | pg.Client;

/** Get all table names in a schema, excluding extension-owned tables. */
export async function getExistingTables(client: Client, schema: string): Promise<string[]> {
  const result = await client.query(
    `SELECT t.tablename
     FROM pg_catalog.pg_tables t
     JOIN pg_catalog.pg_class c ON c.relname = t.tablename
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = t.schemaname
     WHERE t.schemaname = $1
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
         WHERE d.objid = c.oid
           AND d.deptype = 'e'
       )
     ORDER BY t.tablename`,
    [schema],
  );
  return result.rows.map((r: { tablename: string }) => r.tablename);
}

/**
 * Map of sequence name → role name → Set of privilege types granted on that
 * sequence to that role. Privilege types match the PG strings: USAGE,
 * SELECT, UPDATE.
 */
export type SequenceGrantMap = Map<string, Map<string, Set<string>>>;

/**
 * Aggregate existing sequence grants in a schema. Used so the planner can
 * suppress repeat GRANT ops when the privileges are already in place — GRANT
 * is idempotent in Postgres but the plan output gets noisy without this.
 */
export async function getSequenceGrants(client: Client, schema: string): Promise<SequenceGrantMap> {
  const result = await client.query(
    `SELECT c.relname AS seq,
            pg_get_userbyid(ae.grantee) AS role,
            ae.privilege_type
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     CROSS JOIN LATERAL aclexplode(c.relacl) ae
     WHERE c.relkind = 'S'
       AND n.nspname = $1
       AND ae.grantee <> 0
     ORDER BY c.relname, role, ae.privilege_type`,
    [schema],
  );

  const out: SequenceGrantMap = new Map();
  for (const row of result.rows as { seq: string; role: string; privilege_type: string }[]) {
    let bySeq = out.get(row.seq);
    if (!bySeq) {
      bySeq = new Map();
      out.set(row.seq, bySeq);
    }
    let byRole = bySeq.get(row.role);
    if (!byRole) {
      byRole = new Set();
      bySeq.set(row.role, byRole);
    }
    byRole.add(row.privilege_type);
  }
  return out;
}

/** Get all enum types and their values in a schema, excluding extension-owned enums. */
export async function getExistingEnums(client: Client, schema: string): Promise<EnumSchema[]> {
  const result = await client.query(
    `SELECT t.typname AS name,
            array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
     FROM pg_catalog.pg_type t
     JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension ext ON ext.oid = d.refobjid
         WHERE d.objid = t.oid
           AND d.deptype = 'e'
       )
     GROUP BY t.typname
     ORDER BY t.typname`,
    [schema],
  );
  return result.rows.map((r: { name: string; values: string[] }) => ({
    name: r.name,
    values: r.values,
  }));
}

/** Get all functions in a schema, excluding extension-owned functions. */
export async function getExistingFunctions(client: Client, schema: string): Promise<FunctionSchema[]> {
  const result = await client.query(
    `SELECT p.proname AS name,
            l.lanname AS language,
            pg_catalog.pg_get_function_result(p.oid) AS returns,
            p.prosrc AS body,
            CASE p.prosecdef WHEN true THEN 'definer' ELSE 'invoker' END AS security,
            CASE p.provolatile WHEN 'i' THEN 'immutable' WHEN 's' THEN 'stable' ELSE 'volatile' END AS volatility,
            CASE p.proparallel WHEN 's' THEN 'safe' WHEN 'r' THEN 'restricted' ELSE 'unsafe' END AS parallel,
            p.proisstrict AS strict,
            p.proleakproof AS leakproof,
            p.procost AS cost,
            p.prorows AS rows,
            p.proconfig AS config,
            pg_catalog.pg_get_function_arguments(p.oid) AS arglist,
            obj_description(p.oid, 'pg_proc') AS comment
     FROM pg_catalog.pg_proc p
     JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     JOIN pg_catalog.pg_language l ON l.oid = p.prolang
     WHERE n.nspname = $1
       AND p.prokind = 'f'
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
         WHERE d.objid = p.oid
           AND d.deptype = 'e'
       )
     ORDER BY p.proname`,
    [schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const fn: FunctionSchema = {
      name: r.name as string,
      language: r.language as string,
      returns: r.returns as string,
      body: (r.body as string).trim(),
      security: r.security as FunctionSecurity,
      volatility: r.volatility as FunctionVolatility,
    };

    const parallel = r.parallel as FunctionParallel;
    if (parallel && parallel !== 'unsafe') fn.parallel = parallel;
    if (r.strict === true) fn.strict = true;
    if (r.leakproof === true) fn.leakproof = true;
    const cost = Number(r.cost);
    if (cost && cost !== 100) fn.cost = cost; // 100 is PG default for non-C functions
    const rows = Number(r.rows);
    if (rows && rows !== 0 && rows !== 1000) fn.rows = rows; // 1000 is PG default for set-returning
    // Parse proconfig array like ['search_path=public', 'statement_timeout=5s']
    const config = r.config as string[] | null;
    if (config && config.length > 0) {
      const setObj: Record<string, string> = {};
      for (const entry of config) {
        const eqIdx = entry.indexOf('=');
        if (eqIdx > 0) {
          setObj[entry.substring(0, eqIdx)] = entry.substring(eqIdx + 1);
        }
      }
      fn.set = setObj;
    }

    // Parse argument list string like "a integer, b integer"
    const arglist = ((r.arglist as string) || '').trim();
    if (arglist) {
      const args = parseArgList(arglist);
      if (args.length > 0) fn.args = args;
    }

    if (r.comment) fn.comment = r.comment as string;
    return fn;
  });
}

/** Parse a pg_get_function_arguments result string into FunctionArg[]. */
function parseArgList(arglist: string): FunctionArg[] {
  if (!arglist) return [];
  const args: FunctionArg[] = [];
  // Split on commas, but respect parentheses (for types like numeric(10,2))
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of arglist) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());

  for (const part of parts) {
    // Format: [mode] name type [DEFAULT expr]
    const tokens = part.split(/\s+/);
    let mode = 'IN';
    let idx = 0;

    if (['IN', 'OUT', 'INOUT', 'VARIADIC'].includes(tokens[0].toUpperCase())) {
      mode = tokens[0].toUpperCase();
      idx = 1;
    }

    if (idx + 1 < tokens.length) {
      const name = tokens[idx];
      const type = tokens
        .slice(idx + 1)
        .join(' ')
        .replace(/\s+DEFAULT\s+.*/i, '');
      if (mode !== 'OUT') {
        args.push({ name, type });
      }
    }
  }
  return args;
}

/** Get all regular views in a schema, excluding extension-owned views. */
export async function getExistingViews(client: Client, schema: string): Promise<ViewSchema[]> {
  const result = await client.query(
    `SELECT v.viewname AS name, v.definition AS query
     FROM pg_catalog.pg_views v
     JOIN pg_catalog.pg_class c ON c.relname = v.viewname
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = v.schemaname
     WHERE v.schemaname = $1
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
         WHERE d.objid = c.oid
           AND d.deptype = 'e'
       )
     ORDER BY v.viewname`,
    [schema],
  );
  const views: ViewSchema[] = [];
  for (const r of result.rows as { name: string; query: string }[]) {
    const view: ViewSchema = {
      name: r.name,
      query: r.query.trim(),
    };
    const triggers = await getTriggers(client, r.name, schema);
    if (triggers.length > 0) {
      view.triggers = triggers;
    }
    views.push(view);
  }
  return views;
}

/** Get all materialized views in a schema, excluding extension-owned ones. */
export async function getExistingMaterializedViews(client: Client, schema: string): Promise<MaterializedViewSchema[]> {
  const result = await client.query(
    `SELECT mv.matviewname AS name, mv.definition AS query
     FROM pg_catalog.pg_matviews mv
     JOIN pg_catalog.pg_class c ON c.relname = mv.matviewname
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace AND n.nspname = mv.schemaname
     WHERE mv.schemaname = $1
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_depend d
         JOIN pg_catalog.pg_extension e ON e.oid = d.refobjid
         WHERE d.objid = c.oid
           AND d.deptype = 'e'
       )
     ORDER BY mv.matviewname`,
    [schema],
  );
  return result.rows.map((r: { name: string; query: string }) => ({
    name: r.name,
    materialized: true as const,
    query: r.query.trim(),
  }));
}

/**
 * Known system role patterns created by cloud providers.
 * These are excluded from introspection alongside superusers.
 */
const SYSTEM_ROLE_PATTERNS = [
  'rds_superuser',
  'rds_password',
  'rds_replication',
  'rds_ad',
  'rdsadmin',
  'rdsrepladmin',
  'cloudsqlsuperuser',
  'cloudsqladmin',
  'cloudsqlreplica',
  'alloydbsuperuser',
  'alloydbadmin',
  'azure_pg_admin',
  'azure_superuser',
  'azuresu',
  'supabase_admin',
  'supabase_auth_admin',
  'supabase_storage_admin',
];

/** Get all roles (not schema-scoped), excluding superusers and known system roles. */
export async function getExistingRoles(client: Client): Promise<RoleSchema[]> {
  const result = await client.query(
    `SELECT rolname AS role,
            rolcanlogin AS login,
            rolsuper AS superuser,
            rolcreatedb AS createdb,
            rolcreaterole AS createrole,
            rolinherit AS inherit,
            rolbypassrls AS bypassrls,
            rolreplication AS replication,
            rolconnlimit AS connection_limit,
            shobj_description(oid, 'pg_authid') AS comment
     FROM pg_catalog.pg_roles
     WHERE rolname NOT LIKE 'pg_%'
       AND rolsuper = false
       AND rolname <> ALL($1::text[])
     ORDER BY rolname`,
    [SYSTEM_ROLE_PATTERNS],
  );
  // Query role memberships
  const memberships = await client.query(
    `SELECT r.rolname AS member, g.rolname AS group_name
     FROM pg_auth_members m
     JOIN pg_roles r ON r.oid = m.member
     JOIN pg_roles g ON g.oid = m.roleid
     WHERE r.rolname NOT LIKE 'pg_%'
       AND r.rolsuper = false
       AND r.rolname <> ALL($1::text[])`,
    [SYSTEM_ROLE_PATTERNS],
  );
  const membershipMap = new Map<string, string[]>();
  for (const row of memberships.rows) {
    const member = row.member as string;
    const group = row.group_name as string;
    if (!membershipMap.has(member)) membershipMap.set(member, []);
    membershipMap.get(member)!.push(group);
  }

  return result.rows.map((r: Record<string, unknown>) => {
    const role: RoleSchema = {
      role: r.role as string,
      login: r.login as boolean,
      superuser: r.superuser as boolean,
      createdb: r.createdb as boolean,
      createrole: r.createrole as boolean,
      inherit: r.inherit as boolean,
      bypassrls: r.bypassrls as boolean,
      replication: r.replication as boolean,
      connection_limit: r.connection_limit as number,
    };
    if (r.comment) role.comment = r.comment as string;
    const groups = membershipMap.get(role.role);
    if (groups && groups.length > 0) role.in = groups;
    return role;
  });
}

/** Introspect a single table, returning a TableSchema-compatible structure. */
export async function introspectTable(client: Client, tableName: string, schema: string): Promise<TableSchema> {
  const columns = await getColumns(client, tableName, schema);
  const indexes = await getIndexes(client, tableName, schema);
  const checks = await getChecks(client, tableName, schema);
  const triggers = await getTriggers(client, tableName, schema);
  const policies = await getPolicies(client, tableName, schema);
  const tableComment = await getTableComment(client, tableName, schema);
  const fkInfo = await getForeignKeys(client, tableName, schema);
  const columnGrants = await getColumnGrants(client, tableName, schema);
  const compositePk = await getCompositePrimaryKey(client, tableName, schema);
  const tableGrants = await getTableLevelGrants(client, tableName, schema);
  const rlsInfo = await getRlsStatus(client, tableName, schema);
  const uniqueConstraints = await getUniqueConstraints(client, tableName, schema);
  const exclusionConstraints = await getExclusionConstraints(client, tableName, schema);

  // Merge FK info into columns
  for (const fk of fkInfo) {
    const col = columns.find((c) => c.name === fk.column);
    if (col) {
      const ref: ForeignKeyRef = {
        table: fk.foreign_table,
        column: fk.foreign_column,
        on_delete: fk.on_delete,
        on_update: fk.on_update,
      };
      // Only set name if it differs from the default PostgreSQL pattern (table_column_fkey)
      const defaultFkName = `${tableName}_${fk.column}_fkey`;
      if (fk.constraint_name !== defaultFkName) {
        ref.name = fk.constraint_name;
      }
      // Only set schema if it differs from the table's own schema
      if (fk.foreign_schema !== schema) {
        ref.schema = fk.foreign_schema;
      }
      if (fk.deferrable) {
        ref.deferrable = true;
        ref.initially_deferred = fk.initially_deferred;
      }
      col.references = ref;
    }
  }

  // Merge single-column unique constraint info into columns
  for (const uc of uniqueConstraints) {
    if (uc.columns.length === 1) {
      const col = columns.find((c) => c.name === uc.columns[0]);
      if (col) {
        col.unique = true;
        const defaultName = `${tableName}_${uc.columns[0]}_key`;
        if (uc.constraint_name !== defaultName) {
          col.unique_name = uc.constraint_name;
        }
      }
    }
  }

  const result: TableSchema = {
    table: tableName,
    columns,
  };

  if (compositePk.columns.length > 1) result.primary_key = compositePk.columns;
  if (compositePk.constraintName) result.primary_key_name = compositePk.constraintName;
  if (indexes.length > 0) result.indexes = indexes;
  if (checks.length > 0) result.checks = checks;

  // Populate all unique constraints (single-column and multi-column)
  if (uniqueConstraints.length > 0) {
    result.unique_constraints = uniqueConstraints.map((uc) => {
      const def: { columns: string[]; name: string; nulls_not_distinct?: boolean } = {
        columns: uc.columns,
        name: uc.constraint_name,
      };
      if (uc.nulls_not_distinct) {
        def.nulls_not_distinct = true;
      }
      return def;
    });
  }

  if (exclusionConstraints.length > 0) result.exclusion_constraints = exclusionConstraints;
  if (triggers.length > 0) result.triggers = triggers;
  if (policies.length > 0) result.policies = policies;
  if (rlsInfo.rls) result.rls = true;
  if (rlsInfo.force_rls) result.force_rls = true;
  if (tableComment) result.comment = tableComment;
  const allGrants = [...columnGrants, ...tableGrants];
  if (allGrants.length > 0) result.grants = allGrants;

  return result;
}

// ─── Internal helpers ───────────────────────────────────────────

interface FKInfo {
  constraint_name: string;
  column: string;
  foreign_table: string;
  foreign_column: string;
  foreign_schema: string;
  on_delete: ForeignKeyAction;
  on_update: ForeignKeyAction;
  deferrable: boolean;
  initially_deferred: boolean;
}

const FK_ACTION_MAP: Record<string, ForeignKeyAction> = {
  a: 'NO ACTION',
  r: 'RESTRICT',
  c: 'CASCADE',
  n: 'SET NULL',
  d: 'SET DEFAULT',
};

async function getCompositePrimaryKey(
  client: Client,
  table: string,
  schema: string,
): Promise<{ columns: string[]; constraintName: string | undefined }> {
  const result = await client.query(
    `SELECT a.attname AS column_name, con.conname AS constraint_name
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid
       AND a.attnum = ANY(con.conkey)
     WHERE con.contype = 'p'
       AND cls.relname = $1
       AND ns.nspname = $2
     ORDER BY array_position(con.conkey, a.attnum)`,
    [table, schema],
  );
  const columns = result.rows.map((r: Record<string, unknown>) => r.column_name as string);
  const rawName = result.rows.length > 0 ? (result.rows[0].constraint_name as string) : undefined;
  // Only report non-default names (default is "table_pkey")
  const defaultName = `${table}_pkey`;
  const constraintName = rawName && rawName !== defaultName ? rawName : undefined;
  return { columns, constraintName };
}

async function getColumns(client: Client, table: string, schema: string): Promise<ColumnDef[]> {
  const result = await client.query(
    `SELECT
       c.column_name AS name,
       c.udt_name AS udt_type,
       c.character_maximum_length AS max_length,
       c.numeric_precision AS num_precision,
       c.numeric_scale AS num_scale,
       c.is_nullable = 'YES' AS nullable,
       c.column_default AS "default",
       c.is_generated = 'ALWAYS' AS is_generated,
       c.generation_expression,
       col_description(
         (SELECT oid FROM pg_catalog.pg_class WHERE relname = $1 AND relnamespace = (SELECT oid FROM pg_catalog.pg_namespace WHERE nspname = $2)),
         c.ordinal_position
       ) AS comment,
       EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint con
         JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
         JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
         WHERE con.contype = 'p'
           AND cls.relname = $1
           AND ns.nspname = $2
           AND c.ordinal_position = ANY(con.conkey)
       ) AS is_primary_key
     FROM information_schema.columns c
     WHERE c.table_schema = $2
       AND c.table_name = $1
     ORDER BY c.ordinal_position`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const col: ColumnDef = {
      name: r.name as string,
      type: normalizeType(
        r.udt_type as string,
        r.max_length as number | null,
        r.num_precision as number | null,
        r.num_scale as number | null,
      ),
      nullable: r.nullable as boolean,
    };

    if (r.is_primary_key) col.primary_key = true;
    if (r.default !== null && r.default !== undefined) col.default = r.default as string;
    if (r.comment) col.comment = r.comment as string;
    if (r.is_generated && r.generation_expression) col.generated = r.generation_expression as string;

    return col;
  });
}

function normalizeType(
  udtType: string,
  maxLength: number | null,
  numPrecision: number | null,
  numScale: number | null,
): string {
  // Map common udt_name values to user-friendly types
  const typeMap: Record<string, string> = {
    int4: 'integer',
    int8: 'bigint',
    int2: 'smallint',
    float4: 'real',
    float8: 'double precision',
    bool: 'boolean',
    timestamptz: 'timestamptz',
    timestamp: 'timestamp',
    varchar: maxLength ? `varchar(${maxLength})` : 'varchar',
    bpchar: maxLength ? `char(${maxLength})` : 'char',
    numeric: numPrecision != null ? `numeric(${numPrecision},${numScale ?? 0})` : 'numeric',
  };

  if (typeMap[udtType]) return typeMap[udtType];

  // For arrays, information_schema shows ARRAY but udt_name starts with _
  if (udtType.startsWith('_')) {
    const baseType = udtType.slice(1);
    const mapped = typeMap[baseType] || baseType;
    return `${mapped}[]`;
  }

  return udtType;
}

async function getIndexes(client: Client, table: string, schema: string): Promise<IndexDef[]> {
  // Each key is pulled via `pg_get_indexdef(oid, n, true)`, which returns
  // the N-th key's user-facing SQL form: a bare identifier for a plain
  // column (`email`), a quoted identifier when the column is case-sensitive
  // or reserved (`"Order"`), or a full expression (`lower(email)`,
  // `COALESCE(x, '…'::text)`). The N is 1-indexed; passing 0 returns the
  // full CREATE INDEX statement. `indnkeyatts` is the count of key columns
  // (excludes INCLUDE columns); `indnatts` is the total — slots
  // `indnkeyatts+1 … indnatts` are the INCLUDE columns.
  // `indoption` is a smallint vector with one entry per key column (not
  // INCLUDE columns). Bit 0 = DESC, bit 1 = NULLS FIRST. `pg_get_indexdef`
  // for individual columns does *not* include order/nulls, so we read them
  // separately here. Cast to int[] for client-side parsing — note this is
  // 0-indexed (issue #26 lesson) so we re-emit it 1-indexed when joining.
  const result = await client.query(
    `SELECT
       i.relname AS name,
       ix.indisunique AS is_unique,
       am.amname AS method,
       pg_get_expr(ix.indpred, ix.indrelid) AS where_clause,
       array(
         SELECT pg_get_indexdef(ix.indexrelid, k::int, true)
         FROM generate_series(1, ix.indnkeyatts) AS k
       ) AS keys,
       array(
         SELECT pg_get_indexdef(ix.indexrelid, k::int, true)
         FROM generate_series(ix.indnkeyatts + 1, ix.indnatts) AS k
       ) AS include_cols,
       ix.indoption::int[] AS indoptions,
       obj_description(i.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_index ix
     JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
     JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_catalog.pg_am am ON am.oid = i.relam
     WHERE t.relname = $1
       AND n.nspname = $2
       AND NOT ix.indisprimary
       AND NOT EXISTS (
         SELECT 1 FROM pg_catalog.pg_constraint con
         WHERE con.conindid = ix.indexrelid
           AND con.contype = 'u'
       )
     ORDER BY i.relname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const rawKeys = r.keys as string[];
    const indoptions = (r.indoptions as number[]) || [];
    const keys = rawKeys.map((k, i) => attachIndexOrdering(parseIndexKey(k), indoptions[i] ?? 0));
    const idx: IndexDef = {
      name: r.name as string,
      columns: keys,
      unique: r.is_unique as boolean,
    };
    const method = r.method as string;
    if (method && method !== 'btree') {
      idx.method = method as IndexDef['method'];
    }
    if (r.where_clause) idx.where = r.where_clause as string;
    if (r.comment) idx.comment = r.comment as string;
    const includeCols = (r.include_cols as string[]).map((k) => stripQuotes(k.trim()));
    if (includeCols.length > 0) idx.include = includeCols;
    return idx;
  });
}

const INDOPTION_DESC = 0x0001;
const INDOPTION_NULLS_FIRST = 0x0002;

/**
 * Combine a parsed key with its `indoption` bitfield. If the resulting
 * order/nulls combination matches Postgres's defaults (`ASC` for column,
 * `NULLS LAST` for `ASC` / `NULLS FIRST` for `DESC`), the original key
 * shape is returned unchanged so introspected output stays terse for the
 * common case. Non-default ordering returns an `IndexColumn` object with
 * only the non-default fields populated.
 */
function attachIndexOrdering(
  key: import('../schema/types.js').IndexKey,
  indoption: number,
): import('../schema/types.js').IndexKey {
  const isDesc = (indoption & INDOPTION_DESC) !== 0;
  const isNullsFirst = (indoption & INDOPTION_NULLS_FIRST) !== 0;
  // Default: ASC + NULLS LAST (=0). DESC + NULLS FIRST (=DESC|NULLS_FIRST=3) is
  // also fully default. Anything else carries non-default ordering metadata.
  const defaultNullsForOrder = isDesc ? true /* FIRST */ : false; /* LAST */
  const orderIsDefault = !isDesc;
  const nullsIsDefault = isNullsFirst === defaultNullsForOrder;
  if (orderIsDefault && nullsIsDefault) return key;

  // Pull the column name out of whatever shape we have. Expressions can't
  // carry order/nulls in our model — Postgres allows `(expr) DESC` but it's
  // an unusual case; if we see one we just drop the modifiers rather than
  // mis-modelling them.
  let column: string | undefined;
  if (typeof key === 'string') column = key;
  else if ('column' in key) column = key.column;
  if (!column) return key;

  const out: { column: string; order?: 'ASC' | 'DESC'; nulls?: 'FIRST' | 'LAST' } = { column };
  if (isDesc) out.order = 'DESC';
  if (!nullsIsDefault) out.nulls = isNullsFirst ? 'FIRST' : 'LAST';
  return out;
}

function stripQuotes(s: string): string {
  const m = s.match(/^"([^"]+)"$/);
  return m ? m[1] : s;
}

/**
 * Classify one `pg_get_indexdef` key string as either a plain column
 * reference or a SQL expression. A bare lowercase identifier or a
 * double-quoted identifier with no SQL operators is a column; anything
 * else (function calls, operators, casts, coalescings) is an expression.
 */
function parseIndexKey(rendered: string): import('../schema/types.js').IndexKey {
  const trimmed = rendered.trim();
  // Bare unquoted identifier: starts with letter/underscore, contains only
  // identifier chars. Postgres lowercases unquoted identifiers, so we
  // store as-is.
  if (/^[a-z_][a-z0-9_$]*$/i.test(trimmed)) return trimmed;
  // Quoted identifier with no embedded quotes/operators.
  const quotedMatch = trimmed.match(/^"([^"]+)"$/);
  if (quotedMatch && quotedMatch[1]) return quotedMatch[1];
  return { expression: trimmed };
}

async function getChecks(client: Client, table: string, schema: string): Promise<CheckDef[]> {
  const result = await client.query(
    `SELECT con.conname AS name,
            pg_get_constraintdef(con.oid, true) AS definition,
            obj_description(con.oid, 'pg_constraint') AS comment
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE con.contype = 'c'
       AND cls.relname = $1
       AND ns.nspname = $2
     ORDER BY con.conname`,
    [table, schema],
  );

  return result.rows.map((r: { name: string; definition: string; comment: string | null }) => {
    // pg_get_constraintdef returns "CHECK ((expr))" — extract the expression
    const match = r.definition.match(/^CHECK\s*\(\((.*)\)\)$/s) || r.definition.match(/^CHECK\s*\((.*)\)$/s);
    const expression = match ? match[1] : r.definition;
    const check: CheckDef = { name: r.name, expression };
    if (r.comment) check.comment = r.comment;
    return check;
  });
}

async function getExclusionConstraints(
  client: Client,
  table: string,
  schema: string,
): Promise<ExclusionConstraintDef[]> {
  const result = await client.query(
    `SELECT con.conname AS name,
            pg_get_constraintdef(con.oid, true) AS definition,
            obj_description(con.oid, 'pg_constraint') AS comment
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE con.contype = 'x'
       AND cls.relname = $1
       AND ns.nspname = $2
     ORDER BY con.conname`,
    [table, schema],
  );

  const out: ExclusionConstraintDef[] = [];
  for (const r of result.rows as { name: string; definition: string; comment: string | null }[]) {
    const parsed = parseExclusionConstraintDef(r.definition);
    if (!parsed) continue;
    const def: ExclusionConstraintDef = {
      name: r.name,
      using: parsed.using,
      elements: parsed.elements,
    };
    if (parsed.where) def.where = parsed.where;
    if (r.comment) def.comment = r.comment;
    out.push(def);
  }
  return out;
}

/**
 * Parse a `pg_get_constraintdef` output for an EXCLUDE constraint.
 * Examples:
 *   `EXCLUDE USING gist (room_id WITH =, during WITH &&)`
 *   `EXCLUDE USING gist (geofence WITH &&) WHERE (geofence IS NOT NULL)`
 *
 * Returns null if the input doesn't look like a recognised EXCLUDE form.
 */
function parseExclusionConstraintDef(
  def: string,
): { using: string; elements: { column: string; operator: string }[]; where?: string } | null {
  const usingMatch = def.match(/^EXCLUDE\s+USING\s+(\w+)\s*\(/);
  if (!usingMatch) return null;
  const using = usingMatch[1];
  const openIdx = def.indexOf('(', usingMatch[0].length - 1);
  if (openIdx < 0) return null;
  // Walk forward to find the matching close paren, accounting for nested
  // parens inside operator tokens (rare but possible) and inside expressions.
  let depth = 0;
  let closeIdx = -1;
  for (let i = openIdx; i < def.length; i++) {
    if (def[i] === '(') depth++;
    else if (def[i] === ')') {
      depth--;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    }
  }
  if (closeIdx < 0) return null;
  const elementList = def.slice(openIdx + 1, closeIdx);
  const elements: { column: string; operator: string }[] = [];
  for (const part of splitTopLevelCommas(elementList)) {
    const m = part.trim().match(/^"?([^"]+?)"?\s+WITH\s+(.+)$/);
    if (!m) return null;
    elements.push({ column: m[1], operator: m[2].trim() });
  }
  const tail = def.slice(closeIdx + 1).trim();
  let where: string | undefined;
  const whereMatch = tail.match(/^WHERE\s+\((.*)\)$/s);
  if (whereMatch) where = whereMatch[1];
  return { using, elements, where };
}

function splitTopLevelCommas(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  out.push(s.slice(start));
  return out;
}

async function getForeignKeys(client: Client, table: string, schema: string): Promise<FKInfo[]> {
  const result = await client.query(
    `SELECT
       con.conname AS constraint_name,
       a.attname AS column,
       cf.relname AS foreign_table,
       af.attname AS foreign_column,
       nf.nspname AS foreign_schema,
       con.confdeltype AS on_delete,
       con.confupdtype AS on_update,
       con.condeferrable AS deferrable,
       con.condeferred AS initially_deferred
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     JOIN pg_catalog.pg_class cf ON cf.oid = con.confrelid
     JOIN pg_catalog.pg_namespace nf ON nf.oid = cf.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     JOIN pg_catalog.pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = con.confkey[1]
     WHERE con.contype = 'f'
       AND cls.relname = $1
       AND ns.nspname = $2
     ORDER BY a.attname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    constraint_name: r.constraint_name as string,
    column: r.column as string,
    foreign_table: r.foreign_table as string,
    foreign_column: r.foreign_column as string,
    foreign_schema: r.foreign_schema as string,
    on_delete: FK_ACTION_MAP[r.on_delete as string] || 'NO ACTION',
    on_update: FK_ACTION_MAP[r.on_update as string] || 'NO ACTION',
    deferrable: r.deferrable as boolean,
    initially_deferred: r.initially_deferred as boolean,
  }));
}

async function getTriggers(client: Client, table: string, schema: string): Promise<TriggerDef[]> {
  // Use pg_get_triggerdef() instead of pg_get_expr(tgqual, tgrelid) because
  // pg_get_expr cannot decompile expressions containing multiple relation
  // variables (e.g. WHEN (OLD.* IS DISTINCT FROM NEW.*)) — it throws
  // "expression contains variables of more than one relation".
  const result = await client.query(
    `SELECT
       t.tgname AS name,
       CASE
         WHEN (t.tgtype & 2) != 0 THEN 'BEFORE'
         WHEN (t.tgtype & 64) != 0 THEN 'INSTEAD OF'
         ELSE 'AFTER'
       END AS timing,
       CASE WHEN (t.tgtype & 4) != 0 THEN true ELSE false END AS on_insert,
       CASE WHEN (t.tgtype & 8) != 0 THEN true ELSE false END AS on_delete,
       CASE WHEN (t.tgtype & 16) != 0 THEN true ELSE false END AS on_update,
       CASE WHEN (t.tgtype & 32) != 0 THEN true ELSE false END AS on_truncate,
       CASE WHEN (t.tgtype & 1) != 0 THEN 'ROW' ELSE 'STATEMENT' END AS for_each,
       p.proname AS function_name,
       pg_get_triggerdef(t.oid) AS full_definition
     FROM pg_catalog.pg_trigger t
     JOIN pg_catalog.pg_class cls ON cls.oid = t.tgrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     JOIN pg_catalog.pg_proc p ON p.oid = t.tgfoid
     WHERE cls.relname = $1
       AND ns.nspname = $2
       AND NOT t.tgisinternal
     ORDER BY t.tgname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const events: TriggerEvent[] = [];
    if (r.on_insert) events.push('INSERT');
    if (r.on_update) events.push('UPDATE');
    if (r.on_delete) events.push('DELETE');
    if (r.on_truncate) events.push('TRUNCATE');

    const trigger: TriggerDef = {
      name: r.name as string,
      timing: r.timing as TriggerTiming,
      events,
      function: r.function_name as string,
      for_each: r.for_each as TriggerForEach,
    };

    const whenClause = extractWhenClause(r.full_definition as string);
    if (whenClause) trigger.when = whenClause;

    return trigger;
  });
}

/**
 * Extract the WHEN clause from a pg_get_triggerdef() output string.
 *
 * pg_get_triggerdef returns strings like:
 *   CREATE TRIGGER trg_name BEFORE UPDATE ON schema.table
 *     FOR EACH ROW WHEN ((old.* IS DISTINCT FROM new.*))
 *     EXECUTE FUNCTION schema.fn()
 *
 * We extract the expression inside "WHEN ((...))".
 */
function extractWhenClause(triggerDef: string): string | undefined {
  // Match WHEN followed by a parenthesized expression, before EXECUTE
  const match = triggerDef.match(/\bWHEN\s*\((.+)\)\s*EXECUTE\b/is);
  if (!match) return undefined;
  let expr = match[1].trim();
  // pg_get_triggerdef wraps the expression in an extra set of parens: WHEN ((expr))
  // Strip the outer parens if present
  if (expr.startsWith('(') && expr.endsWith(')')) {
    expr = expr.slice(1, -1).trim();
  }
  return expr;
}

async function getPolicies(client: Client, table: string, schema: string): Promise<PolicyDef[]> {
  const result = await client.query(
    `SELECT
       pol.polname AS name,
       CASE pol.polcmd
         WHEN 'r' THEN 'SELECT'
         WHEN 'a' THEN 'INSERT'
         WHEN 'w' THEN 'UPDATE'
         WHEN 'd' THEN 'DELETE'
         WHEN '*' THEN 'ALL'
       END AS command,
       CASE pol.polpermissive WHEN true THEN true ELSE false END AS permissive,
       pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
       pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr,
       (SELECT string_agg(
         CASE WHEN u.oid = 0 THEN 'public'
              ELSE COALESCE(r.rolname, 'public')
         END, ', '
       ) FROM unnest(pol.polroles) AS u(oid)
         LEFT JOIN pg_catalog.pg_roles r ON r.oid = u.oid
       ) AS role_names
     FROM pg_catalog.pg_policy pol
     JOIN pg_catalog.pg_class cls ON cls.oid = pol.polrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     WHERE cls.relname = $1
       AND ns.nspname = $2
     ORDER BY pol.polname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const roleNames = (r.role_names as string) || 'public';
    const policy: PolicyDef = {
      name: r.name as string,
      for: r.command as PolicyCommand,
      to: roleNames,
      permissive: r.permissive as boolean,
    };
    if (r.using_expr) policy.using = r.using_expr as string;
    if (r.check_expr) policy.check = r.check_expr as string;
    return policy;
  });
}

async function getColumnGrants(client: Client, table: string, schema: string): Promise<GrantDef[]> {
  // Query column_privileges from information_schema to find column-level grants.
  // Postgres populates column_privileges with one row per column for table-level
  // grants too, indistinguishable from a real column-qualified grant. Exclude
  // any (grantee, privilege) pair that already exists at the table level, so
  // we only return grants that are *truly* column-restricted. (Issue #29.)
  const result = await client.query(
    `SELECT grantee, privilege_type,
            array_agg(column_name::text ORDER BY column_name) AS columns,
            bool_or(is_grantable = 'YES') AS is_grantable
     FROM information_schema.column_privileges cp
     WHERE table_schema = $2
       AND table_name = $1
       AND grantor <> grantee
       AND NOT EXISTS (
         SELECT 1
           FROM information_schema.table_privileges tp
          WHERE tp.table_schema = cp.table_schema
            AND tp.table_name = cp.table_name
            AND tp.grantee = cp.grantee
            AND tp.privilege_type = cp.privilege_type
            AND tp.grantor <> tp.grantee
       )
     GROUP BY grantee, privilege_type
     ORDER BY grantee, privilege_type`,
    [table, schema],
  );

  // Merge privileges for same grantee+columns combo into a single GrantDef
  const mergeMap = new Map<string, GrantDef>();
  for (const row of result.rows) {
    const cols = (row.columns as string[]).sort();
    const key = `${row.grantee}:${cols.join(',')}`;
    const existing = mergeMap.get(key);
    if (existing) {
      existing.privileges.push(row.privilege_type as string);
      existing.privileges.sort();
    } else {
      const grant: GrantDef = {
        to: row.grantee as string,
        privileges: [row.privilege_type as string],
        columns: cols,
      };
      if (row.is_grantable) grant.with_grant_option = true;
      mergeMap.set(key, grant);
    }
  }

  return Array.from(mergeMap.values());
}

async function getTableLevelGrants(client: Client, table: string, schema: string): Promise<GrantDef[]> {
  const result = await client.query(
    `SELECT grantee, privilege_type, is_grantable
     FROM information_schema.table_privileges
     WHERE table_schema = $2
       AND table_name = $1
       AND grantor <> grantee
     ORDER BY grantee, privilege_type`,
    [table, schema],
  );

  const mergeMap = new Map<string, GrantDef>();
  for (const row of result.rows) {
    const key = row.grantee as string;
    const existing = mergeMap.get(key);
    if (existing) {
      existing.privileges.push(row.privilege_type as string);
      existing.privileges.sort();
      if (row.is_grantable === 'YES') existing.with_grant_option = true;
    } else {
      const grant: GrantDef = {
        to: row.grantee as string,
        privileges: [row.privilege_type as string],
      };
      if (row.is_grantable === 'YES') grant.with_grant_option = true;
      mergeMap.set(key, grant);
    }
  }

  return Array.from(mergeMap.values());
}

async function getRlsStatus(
  client: Client,
  table: string,
  schema: string,
): Promise<{ rls: boolean; force_rls: boolean }> {
  const result = await client.query(
    `SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1
       AND n.nspname = $2
       AND c.relkind = 'r'`,
    [table, schema],
  );
  if (result.rows.length === 0) return { rls: false, force_rls: false };
  return {
    rls: result.rows[0].rls === true,
    force_rls: result.rows[0].force_rls === true,
  };
}

async function getTableComment(client: Client, table: string, schema: string): Promise<string | undefined> {
  const result = await client.query(
    `SELECT obj_description(c.oid, 'pg_class') AS comment
     FROM pg_catalog.pg_class c
     JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = $1
       AND n.nspname = $2
       AND c.relkind = 'r'`,
    [table, schema],
  );
  const comment = result.rows[0]?.comment;
  return comment || undefined;
}

interface UniqueConstraintInfo {
  constraint_name: string;
  columns: string[];
  nulls_not_distinct: boolean;
}

async function getUniqueConstraints(client: Client, table: string, schema: string): Promise<UniqueConstraintInfo[]> {
  // Check if indnullsnotdistinct column exists (PostgreSQL 15+)
  const pgVersionResult = await client.query('SHOW server_version_num');
  const pgVersion = parseInt(pgVersionResult.rows[0].server_version_num as string, 10);
  const hasNullsNotDistinct = pgVersion >= 150000;

  const nullsNotDistinctExpr = hasNullsNotDistinct ? 'COALESCE(idx.indnullsnotdistinct, false)' : 'false';

  const result = await client.query(
    `SELECT con.conname AS constraint_name,
            array_agg(a.attname::text ORDER BY array_position(con.conkey, a.attnum)) AS columns,
            ${nullsNotDistinctExpr} AS nulls_not_distinct
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
     LEFT JOIN pg_catalog.pg_index idx ON idx.indexrelid = con.conindid
     WHERE con.contype = 'u'
       AND cls.relname = $1
       AND ns.nspname = $2
     GROUP BY con.conname, ${nullsNotDistinctExpr}
     ORDER BY con.conname`,
    [table, schema],
  );
  return result.rows.map((r: Record<string, unknown>) => ({
    constraint_name: r.constraint_name as string,
    columns: r.columns as string[],
    nulls_not_distinct: r.nulls_not_distinct as boolean,
  }));
}
