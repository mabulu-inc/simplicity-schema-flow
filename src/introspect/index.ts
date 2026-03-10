/**
 * Database introspection for simplicity-schema.
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

/** Get all table names in a schema. */
export async function getExistingTables(client: Client, schema: string): Promise<string[]> {
  const result = await client.query(
    `SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = $1 ORDER BY tablename`,
    [schema],
  );
  return result.rows.map((r: { tablename: string }) => r.tablename);
}

/** Get all enum types and their values in a schema. */
export async function getExistingEnums(client: Client, schema: string): Promise<EnumSchema[]> {
  const result = await client.query(
    `SELECT t.typname AS name,
            array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
     FROM pg_catalog.pg_type t
     JOIN pg_catalog.pg_enum e ON e.enumtypid = t.oid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1
     GROUP BY t.typname
     ORDER BY t.typname`,
    [schema],
  );
  return result.rows.map((r: { name: string; values: string[] }) => ({
    name: r.name,
    values: r.values,
  }));
}

/** Get all functions in a schema. */
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

/** Get all regular views in a schema. */
export async function getExistingViews(client: Client, schema: string): Promise<ViewSchema[]> {
  const result = await client.query(
    `SELECT viewname AS name, definition AS query
     FROM pg_catalog.pg_views
     WHERE schemaname = $1
     ORDER BY viewname`,
    [schema],
  );
  return result.rows.map((r: { name: string; query: string }) => ({
    name: r.name,
    query: r.query.trim(),
  }));
}

/** Get all materialized views in a schema. */
export async function getExistingMaterializedViews(client: Client, schema: string): Promise<MaterializedViewSchema[]> {
  const result = await client.query(
    `SELECT matviewname AS name, definition AS query
     FROM pg_catalog.pg_matviews
     WHERE schemaname = $1
     ORDER BY matviewname`,
    [schema],
  );
  return result.rows.map((r: { name: string; query: string }) => ({
    name: r.name,
    materialized: true as const,
    query: r.query.trim(),
  }));
}

/** Get all roles (not schema-scoped). */
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
     ORDER BY rolname`,
  );
  // Query role memberships
  const memberships = await client.query(
    `SELECT r.rolname AS member, g.rolname AS group_name
     FROM pg_auth_members m
     JOIN pg_roles r ON r.oid = m.member
     JOIN pg_roles g ON g.oid = m.roleid
     WHERE r.rolname NOT LIKE 'pg_%'`,
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
  const [columns, indexes, checks, triggers, policies, tableComment, fkInfo, columnGrants, compositePk, tableGrants] =
    await Promise.all([
      getColumns(client, tableName, schema),
      getIndexes(client, tableName, schema),
      getChecks(client, tableName, schema),
      getTriggers(client, tableName, schema),
      getPolicies(client, tableName, schema),
      getTableComment(client, tableName, schema),
      getForeignKeys(client, tableName, schema),
      getColumnGrants(client, tableName, schema),
      getCompositePrimaryKey(client, tableName, schema),
      getTableLevelGrants(client, tableName, schema),
    ]);

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
      if (fk.deferrable) {
        ref.deferrable = true;
        ref.initially_deferred = fk.initially_deferred;
      }
      col.references = ref;
    }
  }

  const result: TableSchema = {
    table: tableName,
    columns,
  };

  if (compositePk.length > 1) result.primary_key = compositePk;
  if (indexes.length > 0) result.indexes = indexes;
  if (checks.length > 0) result.checks = checks;
  if (triggers.length > 0) result.triggers = triggers;
  if (policies.length > 0) result.policies = policies;
  if (tableComment) result.comment = tableComment;
  const allGrants = [...columnGrants, ...tableGrants];
  if (allGrants.length > 0) result.grants = allGrants;

  return result;
}

// ─── Internal helpers ───────────────────────────────────────────

interface FKInfo {
  column: string;
  foreign_table: string;
  foreign_column: string;
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

async function getCompositePrimaryKey(client: Client, table: string, schema: string): Promise<string[]> {
  const result = await client.query(
    `SELECT a.attname AS column_name
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
  return result.rows.map((r: Record<string, unknown>) => r.column_name as string);
}

async function getColumns(client: Client, table: string, schema: string): Promise<ColumnDef[]> {
  const result = await client.query(
    `SELECT
       c.column_name AS name,
       c.udt_name AS udt_type,
       c.data_type AS data_type,
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
      type: normalizeType(r.udt_type as string, r.data_type as string, r.max_length as number | null),
      nullable: r.nullable as boolean,
    };

    if (r.is_primary_key) col.primary_key = true;
    if (r.default !== null && r.default !== undefined) col.default = r.default as string;
    if (r.comment) col.comment = r.comment as string;
    if (r.is_generated && r.generation_expression) col.generated = r.generation_expression as string;

    return col;
  });
}

function normalizeType(udtType: string, dataType: string, maxLength: number | null): string {
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
  const result = await client.query(
    `SELECT
       i.relname AS name,
       ix.indisunique AS is_unique,
       am.amname AS method,
       pg_get_expr(ix.indpred, ix.indrelid) AS where_clause,
       array_agg(a.attname::text ORDER BY array_position(ix.indkey, a.attnum)) AS columns
     FROM pg_catalog.pg_index ix
     JOIN pg_catalog.pg_class t ON t.oid = ix.indrelid
     JOIN pg_catalog.pg_class i ON i.oid = ix.indexrelid
     JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace
     JOIN pg_catalog.pg_am am ON am.oid = i.relam
     JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
     WHERE t.relname = $1
       AND n.nspname = $2
       AND NOT ix.indisprimary
     GROUP BY i.relname, ix.indisunique, am.amname, ix.indpred, ix.indrelid
     ORDER BY i.relname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const idx: IndexDef = {
      name: r.name as string,
      columns: r.columns as string[],
      unique: r.is_unique as boolean,
    };
    const method = r.method as string;
    if (method && method !== 'btree') {
      idx.method = method as IndexDef['method'];
    }
    if (r.where_clause) idx.where = r.where_clause as string;
    return idx;
  });
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

async function getForeignKeys(client: Client, table: string, schema: string): Promise<FKInfo[]> {
  const result = await client.query(
    `SELECT
       a.attname AS column,
       cf.relname AS foreign_table,
       af.attname AS foreign_column,
       con.confdeltype AS on_delete,
       con.confupdtype AS on_update,
       con.condeferrable AS deferrable,
       con.condeferred AS initially_deferred
     FROM pg_catalog.pg_constraint con
     JOIN pg_catalog.pg_class cls ON cls.oid = con.conrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     JOIN pg_catalog.pg_class cf ON cf.oid = con.confrelid
     JOIN pg_catalog.pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = con.conkey[1]
     JOIN pg_catalog.pg_attribute af ON af.attrelid = con.confrelid AND af.attnum = con.confkey[1]
     WHERE con.contype = 'f'
       AND cls.relname = $1
       AND ns.nspname = $2
     ORDER BY a.attname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => ({
    column: r.column as string,
    foreign_table: r.foreign_table as string,
    foreign_column: r.foreign_column as string,
    on_delete: FK_ACTION_MAP[r.on_delete as string] || 'NO ACTION',
    on_update: FK_ACTION_MAP[r.on_update as string] || 'NO ACTION',
    deferrable: r.deferrable as boolean,
    initially_deferred: r.initially_deferred as boolean,
  }));
}

async function getTriggers(client: Client, table: string, schema: string): Promise<TriggerDef[]> {
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
       pg_get_expr(t.tgqual, t.tgrelid) AS when_clause
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
    if (r.when_clause) trigger.when = r.when_clause as string;
    return trigger;
  });
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
       array_agg(r.rolname) AS roles
     FROM pg_catalog.pg_policy pol
     JOIN pg_catalog.pg_class cls ON cls.oid = pol.polrelid
     JOIN pg_catalog.pg_namespace ns ON ns.oid = cls.relnamespace
     LEFT JOIN pg_catalog.pg_roles r ON r.oid = ANY(pol.polroles)
     WHERE cls.relname = $1
       AND ns.nspname = $2
     GROUP BY pol.polname, pol.polcmd, pol.polpermissive, pol.polqual, pol.polwithcheck, pol.polrelid
     ORDER BY pol.polname`,
    [table, schema],
  );

  return result.rows.map((r: Record<string, unknown>) => {
    const roles = (r.roles as string[]) || [];
    const policy: PolicyDef = {
      name: r.name as string,
      for: r.command as PolicyCommand,
      to: roles[0] || 'public',
      permissive: r.permissive as boolean,
    };
    if (r.using_expr) policy.using = r.using_expr as string;
    if (r.check_expr) policy.check = r.check_expr as string;
    return policy;
  });
}

async function getColumnGrants(client: Client, table: string, schema: string): Promise<GrantDef[]> {
  // Query column_privileges from information_schema to find column-level grants.
  // We group by grantee and privilege_type, aggregating the column names.
  const result = await client.query(
    `SELECT grantee, privilege_type,
            array_agg(column_name::text ORDER BY column_name) AS columns,
            bool_or(is_grantable = 'YES') AS is_grantable
     FROM information_schema.column_privileges
     WHERE table_schema = $2
       AND table_name = $1
       AND grantor <> grantee
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
