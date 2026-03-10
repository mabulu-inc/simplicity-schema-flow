import { describe, it, expect } from 'vitest';
import { buildPlan, type DesiredState, type ActualState } from '../index.js';

// ─── Helpers ───────────────────────────────────────────────────

function emptyDesired(): DesiredState {
  return {
    tables: [],
    enums: [],
    functions: [],
    views: [],
    materializedViews: [],
    roles: [],
    extensions: null,
  };
}

function emptyActual(): ActualState {
  return {
    tables: new Map(),
    enums: new Map(),
    functions: new Map(),
    views: new Map(),
    materializedViews: new Map(),
    roles: new Map(),
    extensions: [],
  };
}

function findOps(ops: Operation[], type: string): Operation[] {
  return ops.filter((o) => o.type === type);
}

// ─── Tests ─────────────────────────────────────────────────────

describe('Planner', () => {
  describe('empty states', () => {
    it('produces no operations when both states are empty', () => {
      const result = buildPlan(emptyDesired(), emptyActual());
      expect(result.operations).toHaveLength(0);
      expect(result.blocked).toHaveLength(0);
    });
  });

  describe('extensions', () => {
    it('creates new extensions', () => {
      const desired = emptyDesired();
      desired.extensions = { extensions: ['pgcrypto', 'pg_trgm'] };
      const result = buildPlan(desired, emptyActual());
      const extOps = findOps(result.operations, 'create_extension');
      expect(extOps).toHaveLength(2);
      expect(extOps[0].sql).toContain('pgcrypto');
      expect(extOps[1].sql).toContain('pg_trgm');
    });

    it('skips existing extensions', () => {
      const desired = emptyDesired();
      desired.extensions = { extensions: ['pgcrypto'] };
      const actual = emptyActual();
      actual.extensions = ['pgcrypto'];
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'create_extension')).toHaveLength(0);
    });

    it('blocks drop extension when allowDestructive is false', () => {
      const actual = emptyActual();
      actual.extensions = ['pgcrypto'];
      const result = buildPlan(emptyDesired(), actual);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].type).toBe('drop_extension');
    });

    it('allows drop extension when allowDestructive is true', () => {
      const actual = emptyActual();
      actual.extensions = ['pgcrypto'];
      const result = buildPlan(emptyDesired(), actual, { allowDestructive: true });
      expect(findOps(result.operations, 'drop_extension')).toHaveLength(1);
    });
  });

  describe('enums', () => {
    it('creates new enum', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_enum');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain("'active'");
      expect(ops[0].sql).toContain("'inactive'");
    });

    it('adds new enum values to existing enum', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active', 'inactive', 'pending'] }];
      const actual = emptyActual();
      actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'add_enum_value');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain("'pending'");
    });

    it('skips existing enum values', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
      const actual = emptyActual();
      actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'add_enum_value')).toHaveLength(0);
      expect(findOps(result.operations, 'create_enum')).toHaveLength(0);
    });

    it('adds comment for new enum', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active'], comment: 'Status enum' }];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'set_comment');
      expect(ops.some((o) => o.sql.includes('Status enum'))).toBe(true);
    });

    it('blocks enum value removal by default', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active'] }];
      const actual = emptyActual();
      actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
      const result = buildPlan(desired, actual);
      // Should be blocked (destructive)
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].type).toBe('remove_enum_value');
      expect(result.blocked[0].objectName).toBe('status');
      expect(result.blocked[0].destructive).toBe(true);
      // Should not appear in operations
      expect(findOps(result.operations, 'remove_enum_value')).toHaveLength(0);
    });

    it('allows enum value removal with allowDestructive', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active'] }];
      const actual = emptyActual();
      actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
      const result = buildPlan(desired, actual, { allowDestructive: true });
      const ops = findOps(result.operations, 'remove_enum_value');
      expect(ops).toHaveLength(1);
      expect(ops[0].objectName).toBe('status');
      expect(ops[0].destructive).toBe(true);
      expect(result.blocked).toHaveLength(0);
    });

    it('blocks removal of multiple enum values', () => {
      const desired = emptyDesired();
      desired.enums = [{ name: 'status', values: ['active'] }];
      const actual = emptyActual();
      actual.enums.set('status', { name: 'status', values: ['active', 'inactive', 'pending'] });
      const result = buildPlan(desired, actual);
      expect(result.blocked).toHaveLength(2);
      expect(result.blocked.every((o) => o.type === 'remove_enum_value')).toBe(true);
    });
  });

  describe('roles', () => {
    it('creates new role', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_readonly', login: false }];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_role');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('app_readonly');
      expect(ops[0].sql).toContain('NOLOGIN');
    });

    it('alters role when attributes differ', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_readonly', login: true }];
      const actual = emptyActual();
      actual.roles.set('app_readonly', { role: 'app_readonly', login: false });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_role');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('LOGIN');
    });

    it('skips alter when role is unchanged', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_readonly', login: false }];
      const actual = emptyActual();
      actual.roles.set('app_readonly', { role: 'app_readonly', login: false });
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'alter_role')).toHaveLength(0);
      expect(findOps(result.operations, 'create_role')).toHaveLength(0);
    });

    it('produces grant_membership when role has in field', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_group' }, { role: 'app_readonly', login: false, in: ['app_group'] }];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_membership');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT "app_group" TO "app_readonly"');
      expect(ops[0].objectName).toBe('app_readonly.app_group');
    });

    it('produces multiple grant_membership for multiple groups', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'group_a' }, { role: 'group_b' }, { role: 'app_user', in: ['group_a', 'group_b'] }];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_membership');
      expect(ops).toHaveLength(2);
      expect(ops[0].sql).toContain('GRANT "group_a" TO "app_user"');
      expect(ops[1].sql).toContain('GRANT "group_b" TO "app_user"');
    });

    it('skips grant_membership when membership already exists', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_group' }, { role: 'app_readonly', login: false, in: ['app_group'] }];
      const actual = emptyActual();
      actual.roles.set('app_group', { role: 'app_group' });
      actual.roles.set('app_readonly', { role: 'app_readonly', login: false, in: ['app_group'] });
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'grant_membership')).toHaveLength(0);
    });

    it('produces grant_membership for new group when role already exists', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'group_a' }, { role: 'group_b' }, { role: 'app_user', in: ['group_a', 'group_b'] }];
      const actual = emptyActual();
      actual.roles.set('group_a', { role: 'group_a' });
      actual.roles.set('app_user', { role: 'app_user', in: ['group_a'] });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'grant_membership');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT "group_b" TO "app_user"');
    });

    it('creates role with all attributes', () => {
      const desired = emptyDesired();
      desired.roles = [
        {
          role: 'power_user',
          login: true,
          superuser: true,
          createdb: true,
          createrole: true,
          inherit: false,
          bypassrls: true,
          replication: true,
          connection_limit: 10,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_role');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('LOGIN');
      expect(ops[0].sql).toContain('SUPERUSER');
      expect(ops[0].sql).toContain('CREATEDB');
      expect(ops[0].sql).toContain('CREATEROLE');
      expect(ops[0].sql).toContain('NOINHERIT');
      expect(ops[0].sql).toContain('BYPASSRLS');
      expect(ops[0].sql).toContain('REPLICATION');
      expect(ops[0].sql).toContain('CONNECTION LIMIT 10');
    });

    it('alters role attributes correctly', () => {
      const desired = emptyDesired();
      desired.roles = [
        {
          role: 'app_user',
          superuser: true,
          createdb: true,
          createrole: true,
          inherit: false,
          bypassrls: true,
          replication: true,
        },
      ];
      const actual = emptyActual();
      actual.roles.set('app_user', {
        role: 'app_user',
        superuser: false,
        createdb: false,
        createrole: false,
        inherit: true,
        bypassrls: false,
        replication: false,
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_role');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('SUPERUSER');
      expect(ops[0].sql).toContain('CREATEDB');
      expect(ops[0].sql).toContain('CREATEROLE');
      expect(ops[0].sql).toContain('NOINHERIT');
      expect(ops[0].sql).toContain('BYPASSRLS');
      expect(ops[0].sql).toContain('REPLICATION');
    });

    it('alters connection_limit when it differs', () => {
      const desired = emptyDesired();
      desired.roles = [{ role: 'app_user', connection_limit: 50 }];
      const actual = emptyActual();
      actual.roles.set('app_user', { role: 'app_user', connection_limit: -1 });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_role');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CONNECTION LIMIT 50');
    });
  });

  describe('functions', () => {
    it('creates function with CREATE OR REPLACE', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'update_timestamp',
          language: 'plpgsql',
          returns: 'trigger',
          body: 'BEGIN NEW.updated_at = now(); RETURN NEW; END;',
          security: 'invoker',
          volatility: 'volatile',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE OR REPLACE FUNCTION');
      expect(ops[0].sql).toContain('update_timestamp');
      expect(ops[0].sql).toContain('RETURNS trigger');
    });

    it('includes PARALLEL SAFE in function SQL', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'safe_func',
          language: 'sql',
          returns: 'integer',
          body: 'SELECT 1',
          parallel: 'safe',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('PARALLEL SAFE');
    });

    it('includes STRICT in function SQL', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'strict_func',
          language: 'sql',
          returns: 'integer',
          body: 'SELECT $1',
          args: [{ name: 'x', type: 'integer' }],
          strict: true,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops[0].sql).toContain('STRICT');
    });

    it('includes LEAKPROOF in function SQL', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'leak_func',
          language: 'sql',
          returns: 'boolean',
          body: 'SELECT true',
          leakproof: true,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops[0].sql).toContain('LEAKPROOF');
    });

    it('includes COST and ROWS in function SQL', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'cost_func',
          language: 'sql',
          returns: 'SETOF integer',
          body: 'SELECT generate_series(1, 10)',
          cost: 200,
          rows: 10,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops[0].sql).toContain('COST 200');
      expect(ops[0].sql).toContain('ROWS 10');
    });

    it('includes SET configuration parameters in function SQL', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'secure_func',
          language: 'plpgsql',
          returns: 'void',
          body: 'BEGIN END;',
          security: 'definer',
          set: { search_path: 'public', statement_timeout: '5s' },
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops[0].sql).toContain('SET search_path = public');
      expect(ops[0].sql).toContain('SET statement_timeout = 5s');
    });

    it('includes all function options combined', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'full_func',
          language: 'sql',
          returns: 'integer',
          body: 'SELECT 1',
          security: 'definer',
          volatility: 'immutable',
          parallel: 'safe',
          strict: true,
          leakproof: true,
          cost: 100,
          set: { search_path: 'public' },
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_function');
      expect(ops[0].sql).toContain('IMMUTABLE');
      expect(ops[0].sql).toContain('SECURITY DEFINER');
      expect(ops[0].sql).toContain('PARALLEL SAFE');
      expect(ops[0].sql).toContain('STRICT');
      expect(ops[0].sql).toContain('LEAKPROOF');
      expect(ops[0].sql).toContain('COST 100');
      expect(ops[0].sql).toContain('SET search_path = public');
    });
  });

  describe('tables', () => {
    it('creates new table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true, default: 'gen_random_uuid()' },
            { name: 'email', type: 'text', nullable: false },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE TABLE');
      expect(ops[0].sql).toContain('"users"');
      expect(ops[0].sql).toContain('"id" uuid PRIMARY KEY');
      expect(ops[0].sql).toContain('"email" text NOT NULL');
    });

    it('adds column to existing table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text', nullable: false },
            { name: 'name', type: 'text', nullable: false },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text', nullable: false },
        ],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'add_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('"name" text NOT NULL');
    });

    it('drops column (destructive)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].type).toBe('drop_column');
    });

    it('alters column type', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'name', type: 'varchar(255)' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'name', type: 'text' }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('TYPE varchar(255)');
    });

    it('alters column nullability using safe NOT NULL pattern', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'name', type: 'text', nullable: false }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'name', type: 'text', nullable: true }],
      });
      const result = buildPlan(desired, actual);

      // Step 1: ADD CHECK NOT VALID
      const checkOps = findOps(result.operations, 'add_check_not_valid');
      expect(checkOps).toHaveLength(1);
      expect(checkOps[0].sql).toContain('CHECK ("name" IS NOT NULL) NOT VALID');
      expect(checkOps[0].sql).toContain('chk_users_name_not_null');

      // Step 2: VALIDATE CONSTRAINT
      const valOps = findOps(result.operations, 'validate_constraint');
      expect(valOps).toHaveLength(1);
      expect(valOps[0].sql).toContain('VALIDATE CONSTRAINT "chk_users_name_not_null"');

      // Step 3: SET NOT NULL
      const alterOps = findOps(result.operations, 'alter_column');
      expect(alterOps).toHaveLength(1);
      expect(alterOps[0].sql).toContain('SET NOT NULL');

      // Step 4: DROP redundant check
      const dropOps = findOps(result.operations, 'drop_check');
      expect(dropOps).toHaveLength(1);
      expect(dropOps[0].sql).toContain('DROP CONSTRAINT "chk_users_name_not_null"');
    });

    it('alters column default', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'status', type: 'text', default: "'active'" }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'status', type: 'text' }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain("SET DEFAULT 'active'");
    });

    it('drops table (destructive)', () => {
      const actual = emptyActual();
      actual.tables.set('old_table', {
        table: 'old_table',
        columns: [{ name: 'id', type: 'uuid' }],
      });
      const result = buildPlan(emptyDesired(), actual);
      expect(result.blocked).toHaveLength(1);
      expect(result.blocked[0].type).toBe('drop_table');
    });

    it('creates table with indexes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          indexes: [{ columns: ['email'], unique: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('UNIQUE');
      expect(ops[0].sql).toContain('"email"');
    });

    it('creates table with check constraints', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          checks: [{ name: 'email_not_empty', expression: 'length(email) > 0' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('email_not_empty');
    });

    it('creates table with foreign keys as NOT VALID', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'user_id', type: 'uuid', references: { table: 'users', column: 'id', on_delete: 'CASCADE' } },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const fkOps = findOps(result.operations, 'add_foreign_key_not_valid');
      expect(fkOps).toHaveLength(1);
      expect(fkOps[0].sql).toContain('NOT VALID');
      expect(fkOps[0].sql).toContain('ON DELETE CASCADE');
      // Validate constraint should follow
      const valOps = findOps(result.operations, 'validate_constraint');
      expect(valOps).toHaveLength(1);
    });

    it('creates FK with on_update option', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            {
              name: 'user_id',
              type: 'uuid',
              references: { table: 'users', column: 'id', on_delete: 'SET NULL', on_update: 'CASCADE' },
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const fkOps = findOps(result.operations, 'add_foreign_key_not_valid');
      expect(fkOps).toHaveLength(1);
      expect(fkOps[0].sql).toContain('ON DELETE SET NULL');
      expect(fkOps[0].sql).toContain('ON UPDATE CASCADE');
    });

    it('creates FK with deferrable initially deferred', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            {
              name: 'user_id',
              type: 'uuid',
              references: { table: 'users', column: 'id', deferrable: true, initially_deferred: true },
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const fkOps = findOps(result.operations, 'add_foreign_key_not_valid');
      expect(fkOps).toHaveLength(1);
      expect(fkOps[0].sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    });

    it('creates FK with deferrable initially immediate', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            {
              name: 'user_id',
              type: 'uuid',
              references: { table: 'users', column: 'id', deferrable: true, initially_deferred: false },
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const fkOps = findOps(result.operations, 'add_foreign_key_not_valid');
      expect(fkOps).toHaveLength(1);
      expect(fkOps[0].sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
      expect(fkOps[0].sql).not.toContain('INITIALLY DEFERRED');
    });

    it('creates table with triggers', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'set_updated_at',
              timing: 'BEFORE',
              events: ['UPDATE'],
              function: 'update_timestamp',
              for_each: 'ROW',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_trigger');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('BEFORE UPDATE');
      expect(ops[0].sql).toContain('update_timestamp()');
    });

    it('creates table with RLS policies', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          policies: [
            {
              name: 'users_own_data',
              for: 'SELECT',
              to: 'app_user',
              using: 'id = current_user_id()',
              permissive: true,
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const rlsOps = findOps(result.operations, 'enable_rls');
      expect(rlsOps).toHaveLength(1);
      const policyOps = findOps(result.operations, 'create_policy');
      expect(policyOps).toHaveLength(1);
      expect(policyOps[0].sql).toContain('PERMISSIVE');
      expect(policyOps[0].sql).toContain('FOR SELECT');
    });

    it('creates table with RESTRICTIVE policy', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          policies: [
            {
              name: 'restrict_delete',
              for: 'DELETE',
              to: 'app_user',
              using: 'false',
              permissive: false,
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const policyOps = findOps(result.operations, 'create_policy');
      expect(policyOps).toHaveLength(1);
      expect(policyOps[0].sql).toContain('AS RESTRICTIVE');
      expect(policyOps[0].sql).toContain('FOR DELETE');
      expect(policyOps[0].sql).not.toContain('PERMISSIVE');
    });

    it('creates table with force_rls', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          rls: true,
          force_rls: true,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const enableOps = findOps(result.operations, 'enable_rls');
      expect(enableOps).toHaveLength(1);
      const forceOps = findOps(result.operations, 'force_rls');
      expect(forceOps).toHaveLength(1);
      expect(forceOps[0].sql).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('creates table with rls:true but no force_rls', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          rls: true,
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const enableOps = findOps(result.operations, 'enable_rls');
      expect(enableOps).toHaveLength(1);
      const forceOps = findOps(result.operations, 'force_rls');
      expect(forceOps).toHaveLength(0);
    });

    it('creates table with grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_table');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT SELECT');
      expect(ops[0].sql).toContain('app_readonly');
    });

    it('creates table with comment', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          comment: 'Main users table',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'set_comment');
      expect(ops.some((o) => o.sql.includes('Main users table'))).toBe(true);
    });

    it('creates table with seeds', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          seeds: [{ id: '00000000-0000-0000-0000-000000000001', email: 'admin@example.com' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_seed');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('INSERT INTO');
      expect(ops[0].sql).toContain('ON CONFLICT');
    });

    it('creates table with column-level grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          grants: [{ to: 'app_readonly', privileges: ['SELECT'], columns: ['id', 'email'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('SELECT ("id", "email")');
    });

    it('produces grant_column for column-level grants on existing table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'name', type: 'text' },
          ],
          grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['id', 'email', 'name'] }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
          { name: 'name', type: 'text' },
        ],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'grant_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT SELECT ("id", "email", "name")');
      expect(ops[0].sql).toContain('TO "reader"');
    });

    it('produces grant_table (not grant_column) for table-level grants without columns', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          grants: [{ to: 'admin', privileges: ['ALL'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const tableGrants = findOps(result.operations, 'grant_table');
      const colGrants = findOps(result.operations, 'grant_column');
      expect(tableGrants).toHaveLength(1);
      expect(colGrants).toHaveLength(0);
    });

    it('creates table with unique constraints', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'email', type: 'text' },
            { name: 'tenant_id', type: 'uuid' },
          ],
          unique_constraints: [{ columns: ['email', 'tenant_id'], name: 'uq_email_tenant' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops[0].sql).toContain('uq_email_tenant');
      expect(ops[0].sql).toContain('UNIQUE');
    });

    it('creates table with composite primary key', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'user_roles',
          columns: [
            { name: 'user_id', type: 'uuid' },
            { name: 'role_id', type: 'uuid' },
          ],
          primary_key: ['user_id', 'role_id'],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops[0].sql).toContain('PRIMARY KEY ("user_id", "role_id")');
    });
  });

  describe('views', () => {
    it('creates new view', () => {
      const desired = emptyDesired();
      desired.views = [
        {
          name: 'active_users',
          query: 'SELECT id, email FROM users WHERE active = true',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_view');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE OR REPLACE VIEW');
    });

    it('blocks drop view when not allowDestructive', () => {
      const actual = emptyActual();
      actual.views.set('old_view', { name: 'old_view', query: 'SELECT 1' });
      const result = buildPlan(emptyDesired(), actual);
      expect(result.blocked.some((o) => o.type === 'drop_view')).toBe(true);
    });

    it('produces grant_table operations for view grants', () => {
      const desired = emptyDesired();
      desired.views = [
        {
          name: 'active_users',
          query: 'SELECT id, email FROM users WHERE active = true',
          grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_table');
      expect(grantOps).toHaveLength(1);
      expect(grantOps[0].sql).toContain('GRANT SELECT');
      expect(grantOps[0].sql).toContain('"active_users"');
      expect(grantOps[0].sql).toContain('"app_readonly"');
      expect(grantOps[0].phase).toBe(13);
    });

    it('produces multiple grant_table operations for view with multiple grants', () => {
      const desired = emptyDesired();
      desired.views = [
        {
          name: 'active_users',
          query: 'SELECT id, email FROM users WHERE active = true',
          grants: [
            { to: 'app_readonly', privileges: ['SELECT'] },
            { to: 'app_writer', privileges: ['SELECT', 'INSERT'] },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_table');
      expect(grantOps).toHaveLength(2);
      expect(grantOps[0].sql).toContain('"app_readonly"');
      expect(grantOps[1].sql).toContain('"app_writer"');
      expect(grantOps[1].sql).toContain('SELECT, INSERT');
    });
  });

  describe('materialized views', () => {
    it('creates new materialized view', () => {
      const desired = emptyDesired();
      desired.materializedViews = [
        {
          name: 'user_stats',
          materialized: true,
          query: 'SELECT user_id, count(*) FROM orders GROUP BY user_id',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_materialized_view');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE MATERIALIZED VIEW');
    });

    it('recreates materialized view when query changes (destructive)', () => {
      const desired = emptyDesired();
      desired.materializedViews = [
        {
          name: 'user_stats',
          materialized: true,
          query: 'SELECT user_id, count(*) AS cnt FROM orders GROUP BY user_id',
        },
      ];
      const actual = emptyActual();
      actual.materializedViews.set('user_stats', {
        name: 'user_stats',
        materialized: true,
        query: 'SELECT user_id, count(*) FROM orders GROUP BY user_id',
      });
      const result = buildPlan(desired, actual, { allowDestructive: true });
      expect(findOps(result.operations, 'drop_materialized_view')).toHaveLength(1);
      expect(findOps(result.operations, 'create_materialized_view')).toHaveLength(1);
    });

    it('produces refresh_materialized_view when query changes', () => {
      const desired = emptyDesired();
      desired.materializedViews = [
        {
          name: 'user_stats',
          materialized: true,
          query: 'SELECT user_id, count(*) AS cnt FROM orders GROUP BY user_id',
        },
      ];
      const actual = emptyActual();
      actual.materializedViews.set('user_stats', {
        name: 'user_stats',
        materialized: true,
        query: 'SELECT user_id, count(*) FROM orders GROUP BY user_id',
      });
      const result = buildPlan(desired, actual, { allowDestructive: true });
      const refreshOps = findOps(result.operations, 'refresh_materialized_view');
      expect(refreshOps).toHaveLength(1);
      expect(refreshOps[0].sql).toContain('REFRESH MATERIALIZED VIEW');
      expect(refreshOps[0].phase).toBe(10);
    });

    it('produces grant_table operations for materialized view grants', () => {
      const desired = emptyDesired();
      desired.materializedViews = [
        {
          name: 'user_stats',
          materialized: true,
          query: 'SELECT user_id, count(*) FROM orders GROUP BY user_id',
          grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_table');
      expect(grantOps).toHaveLength(1);
      expect(grantOps[0].sql).toContain('GRANT SELECT');
      expect(grantOps[0].sql).toContain('"user_stats"');
      expect(grantOps[0].sql).toContain('"app_readonly"');
      expect(grantOps[0].phase).toBe(13);
    });

    it('produces set_comment operations for materialized view comments', () => {
      const desired = emptyDesired();
      desired.materializedViews = [
        {
          name: 'user_stats',
          materialized: true,
          query: 'SELECT user_id, count(*) FROM orders GROUP BY user_id',
          comment: 'Aggregated user order statistics',
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const commentOps = findOps(result.operations, 'set_comment');
      expect(commentOps).toHaveLength(1);
      expect(commentOps[0].sql).toContain('COMMENT ON MATERIALIZED VIEW');
      expect(commentOps[0].sql).toContain('Aggregated user order statistics');
      expect(commentOps[0].phase).toBe(14);
    });
  });

  describe('operation ordering', () => {
    it('orders operations by phase (extensions before enums before tables)', () => {
      const desired = emptyDesired();
      desired.extensions = { extensions: ['pgcrypto'] };
      desired.enums = [{ name: 'status', values: ['active'] }];
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const phases = result.operations.map((o) => o.phase);
      // Check phases are non-decreasing
      for (let i = 1; i < phases.length; i++) {
        expect(phases[i]).toBeGreaterThanOrEqual(phases[i - 1]);
      }
      // Extensions (2) before enums (3) before tables (6)
      const extPhase = result.operations.find((o) => o.type === 'create_extension')!.phase;
      const enumPhase = result.operations.find((o) => o.type === 'create_enum')!.phase;
      const tablePhase = result.operations.find((o) => o.type === 'create_table')!.phase;
      expect(extPhase).toBeLessThan(enumPhase);
      expect(enumPhase).toBeLessThan(tablePhase);
    });

    it('places FKs after table creation', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'user_id', type: 'uuid', references: { table: 'users', column: 'id' } },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const tableOp = result.operations.find((o) => o.type === 'create_table')!;
      const fkOp = result.operations.find((o) => o.type === 'add_foreign_key_not_valid')!;
      expect(fkOp.phase).toBeGreaterThan(tableOp.phase);
    });

    it('places triggers after tables', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'trg',
              timing: 'BEFORE',
              events: ['INSERT'],
              function: 'fn',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const tableOp = result.operations.find((o) => o.type === 'create_table')!;
      const trgOp = result.operations.find((o) => o.type === 'create_trigger')!;
      expect(trgOp.phase).toBeGreaterThan(tableOp.phase);
    });
  });

  describe('destructive operation protection', () => {
    it('blocks all destructive operations by default', () => {
      const actual = emptyActual();
      actual.tables.set('old', { table: 'old', columns: [{ name: 'id', type: 'uuid' }] });
      actual.extensions = ['old_ext'];
      const result = buildPlan(emptyDesired(), actual);
      expect(result.blocked.length).toBeGreaterThan(0);
      expect(result.operations.filter((o) => o.destructive)).toHaveLength(0);
    });

    it('allows destructive operations with allowDestructive', () => {
      const actual = emptyActual();
      actual.tables.set('old', { table: 'old', columns: [{ name: 'id', type: 'uuid' }] });
      const result = buildPlan(emptyDesired(), actual, { allowDestructive: true });
      expect(result.blocked).toHaveLength(0);
      expect(result.operations.some((o) => o.destructive)).toBe(true);
    });
  });

  describe('pgSchema option', () => {
    it('uses specified pgSchema in SQL', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual(), { pgSchema: 'myschema' });
      const ops = findOps(result.operations, 'create_table');
      expect(ops[0].sql).toContain('"myschema"."users"');
    });
  });

  describe('column comment on existing table', () => {
    it('adds column comment when column has one', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text', comment: 'User email' },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'set_comment');
      expect(ops.some((o) => o.sql.includes('User email'))).toBe(true);
    });
  });

  describe('index diffing on existing table', () => {
    it('adds new index to existing table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
    });

    it('blocks drop of index not in desired', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
        indexes: [{ name: 'idx_old', columns: ['email'] }],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_index')).toBe(true);
    });
  });

  describe('trigger diffing on existing table', () => {
    it('blocks drop of trigger not in desired', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid' }],
        triggers: [
          {
            name: 'old_trigger',
            timing: 'BEFORE',
            events: ['INSERT'],
            function: 'fn',
          },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_trigger')).toBe(true);
    });
  });

  describe('policy diffing on existing table', () => {
    it('recreates policy when permissive flag changes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid' }],
          policies: [
            {
              name: 'user_policy',
              for: 'SELECT',
              to: 'public',
              permissive: false,
            },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid' }],
        policies: [
          {
            name: 'user_policy',
            for: 'SELECT',
            to: 'public',
            permissive: true,
          },
        ],
      });
      const result = buildPlan(desired, actual);
      const dropOps = findOps(result.operations, 'drop_policy');
      const createOps = findOps(result.operations, 'create_policy');
      expect(dropOps).toHaveLength(1);
      expect(createOps).toHaveLength(1);
      expect(createOps[0].sql).toContain('AS RESTRICTIVE');
    });

    it('blocks drop of policy not in desired', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid' }],
        policies: [
          {
            name: 'old_policy',
            for: 'SELECT',
            to: 'public',
            permissive: true,
          },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_policy')).toBe(true);
    });
  });

  describe('type normalization', () => {
    it('treats int and integer as the same type', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'test',
          columns: [{ name: 'count', type: 'integer' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('test', {
        table: 'test',
        columns: [{ name: 'count', type: 'int4' }],
      });
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'alter_column')).toHaveLength(0);
    });
  });

  describe('SQL escaping', () => {
    it('escapes single quotes in comments', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          comment: "User's table",
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'set_comment');
      expect(ops[0].sql).toContain("User''s table");
    });
  });

  describe('drop default', () => {
    it('drops column default when desired has no default', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'status', type: 'text' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'status', type: 'text', default: "'active'" }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('DROP DEFAULT');
    });
  });

  describe('safe NOT NULL pattern', () => {
    it('produces 4 operations in correct order for nullable → non-nullable', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [{ name: 'total', type: 'numeric', nullable: false }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('orders', {
        table: 'orders',
        columns: [{ name: 'total', type: 'numeric', nullable: true }],
      });
      const result = buildPlan(desired, actual);

      // Filter to just the NOT NULL-related operations
      const notNullOps = result.operations.filter(
        (o) =>
          o.type === 'add_check_not_valid' ||
          o.type === 'validate_constraint' ||
          (o.type === 'alter_column' && o.sql.includes('SET NOT NULL')) ||
          o.type === 'drop_check',
      );
      expect(notNullOps).toHaveLength(4);
      expect(notNullOps[0].type).toBe('add_check_not_valid');
      expect(notNullOps[1].type).toBe('validate_constraint');
      expect(notNullOps[2].type).toBe('alter_column');
      expect(notNullOps[3].type).toBe('drop_check');
    });

    it('does NOT use safe pattern for non-nullable → nullable (just DROP NOT NULL)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [{ name: 'total', type: 'numeric', nullable: true }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('orders', {
        table: 'orders',
        columns: [{ name: 'total', type: 'numeric', nullable: false }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'alter_column');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('DROP NOT NULL');
      expect(findOps(result.operations, 'add_check_not_valid')).toHaveLength(0);
    });

    it('handles multiple columns going non-nullable in same table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'email', type: 'text', nullable: false },
            { name: 'name', type: 'text', nullable: false },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'email', type: 'text', nullable: true },
          { name: 'name', type: 'text', nullable: true },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(findOps(result.operations, 'add_check_not_valid')).toHaveLength(2);
      expect(findOps(result.operations, 'validate_constraint')).toHaveLength(2);
      expect(findOps(result.operations, 'drop_check')).toHaveLength(2);
    });

    it('does not trigger safe pattern on CREATE TABLE (direct NOT NULL is fine)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text', nullable: false },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      // CREATE TABLE uses inline NOT NULL — no safe pattern needed
      expect(findOps(result.operations, 'add_check_not_valid')).toHaveLength(0);
      const createOps = findOps(result.operations, 'create_table');
      expect(createOps[0].sql).toContain('"email" text NOT NULL');
    });
  });

  describe('safe unique constraint pattern', () => {
    it('uses 2-step safe pattern when adding unique constraint to existing table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'email', type: 'text' },
            { name: 'tenant_id', type: 'uuid' },
          ],
          unique_constraints: [{ columns: ['email', 'tenant_id'], name: 'uq_users_email_tenant' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'email', type: 'text' },
          { name: 'tenant_id', type: 'uuid' },
        ],
      });
      const result = buildPlan(desired, actual);

      // Step 1: CREATE UNIQUE INDEX CONCURRENTLY
      const indexOps = findOps(result.operations, 'add_index');
      expect(indexOps).toHaveLength(1);
      expect(indexOps[0].sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
      expect(indexOps[0].sql).toContain('"uq_users_email_tenant"');
      expect(indexOps[0].concurrent).toBe(true);
      expect(indexOps[0].phase).toBe(7);

      // Step 2: ALTER TABLE ADD CONSTRAINT ... USING INDEX
      const ucOps = findOps(result.operations, 'add_unique_constraint');
      expect(ucOps).toHaveLength(1);
      expect(ucOps[0].sql).toContain('ADD CONSTRAINT "uq_users_email_tenant"');
      expect(ucOps[0].sql).toContain('USING INDEX "uq_users_email_tenant"');
      expect(ucOps[0].concurrent).toBe(true);
      expect(ucOps[0].phase).toBe(8);
    });

    it('generates default name for unique constraint without explicit name', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          unique_constraints: [{ columns: ['email'] }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
      });
      const result = buildPlan(desired, actual);
      const indexOps = findOps(result.operations, 'add_index');
      expect(indexOps).toHaveLength(1);
      expect(indexOps[0].sql).toContain('"uq_users_email"');
    });

    it('drops unique constraint not in desired (destructive)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
        unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_unique_constraint')).toBe(true);
    });

    it('does not produce safe pattern ops for new table (inline UNIQUE in CREATE TABLE)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      // New table: unique constraint is inline in CREATE TABLE
      const createOps = findOps(result.operations, 'create_table');
      expect(createOps[0].sql).toContain('UNIQUE');
      // No separate add_index or add_unique_constraint ops for this
      const ucOps = findOps(result.operations, 'add_unique_constraint');
      expect(ucOps).toHaveLength(0);
    });

    it('skips unique constraint that already exists', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
        unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
      });
      const result = buildPlan(desired, actual);
      const indexOps = findOps(result.operations, 'add_index');
      const ucOps = findOps(result.operations, 'add_unique_constraint');
      expect(indexOps).toHaveLength(0);
      expect(ucOps).toHaveLength(0);
    });
  });

  describe('function grants', () => {
    it('produces grant_function operations from function grants', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'get_user',
          language: 'plpgsql',
          returns: 'json',
          body: 'BEGIN RETURN NULL; END;',
          security: 'invoker',
          volatility: 'stable',
          grants: [{ to: 'app_readonly', privileges: ['EXECUTE'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_function');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT EXECUTE');
      expect(ops[0].sql).toContain('"get_user"');
      expect(ops[0].sql).toContain('"app_readonly"');
      expect(ops[0].phase).toBe(13);
    });

    it('produces grant_function with args in signature', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'get_user_by_id',
          language: 'plpgsql',
          returns: 'json',
          args: [{ name: 'user_id', type: 'uuid' }],
          body: 'BEGIN RETURN NULL; END;',
          grants: [{ to: 'app_user', privileges: ['EXECUTE'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_function');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('"get_user_by_id"(uuid)');
    });

    it('produces multiple grant_function operations for multiple grantees', () => {
      const desired = emptyDesired();
      desired.functions = [
        {
          name: 'helper_fn',
          language: 'plpgsql',
          returns: 'void',
          body: 'BEGIN END;',
          grants: [
            { to: 'role_a', privileges: ['EXECUTE'] },
            { to: 'role_b', privileges: ['EXECUTE'] },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_function');
      expect(ops).toHaveLength(2);
    });
  });

  describe('sequence grants', () => {
    it('auto-generates grant_sequence for tables with serial columns and grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'items',
          columns: [
            { name: 'id', type: 'serial', primary_key: true },
            { name: 'name', type: 'text' },
          ],
          grants: [{ to: 'app_user', privileges: ['SELECT', 'INSERT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_sequence');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('GRANT USAGE, SELECT');
      expect(ops[0].sql).toContain('_id_seq');
      expect(ops[0].sql).toContain('"app_user"');
      expect(ops[0].phase).toBe(13);
    });

    it('auto-generates grant_sequence for bigserial columns', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'events',
          columns: [
            { name: 'id', type: 'bigserial', primary_key: true },
            { name: 'data', type: 'jsonb' },
          ],
          grants: [{ to: 'writer', privileges: ['INSERT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_sequence');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('events_id_seq');
    });

    it('does not generate grant_sequence when table has no serial columns', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          grants: [{ to: 'reader', privileges: ['SELECT'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_sequence');
      expect(ops).toHaveLength(0);
    });

    it('does not generate grant_sequence when table has no grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'items',
          columns: [{ name: 'id', type: 'serial', primary_key: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_sequence');
      expect(ops).toHaveLength(0);
    });

    it('generates grant_sequence for each grantee with INSERT/UPDATE/ALL privileges', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'items',
          columns: [{ name: 'id', type: 'serial', primary_key: true }],
          grants: [
            { to: 'writer', privileges: ['INSERT', 'UPDATE'] },
            { to: 'reader', privileges: ['SELECT'] },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_sequence');
      // Only the writer needs sequence access (INSERT/UPDATE use sequences), reader doesn't
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('"writer"');
    });
  });

  describe('CONCURRENTLY indexes', () => {
    it('generates CREATE INDEX CONCURRENTLY for new indexes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          indexes: [{ columns: ['email'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('INDEX CONCURRENTLY');
      expect(ops[0].concurrent).toBe(true);
    });

    it('generates UNIQUE INDEX CONCURRENTLY for unique indexes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          indexes: [{ columns: ['email'], unique: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
      expect(ops[0].concurrent).toBe(true);
    });

    it('marks add_index operations as concurrent', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'email', type: 'text' }],
          indexes: [{ name: 'idx_users_email', columns: ['email'] }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'email', type: 'text' }],
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].concurrent).toBe(true);
      expect(ops[0].phase).toBe(7);
    });
  });

  describe('index options', () => {
    it('generates index with gin method', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'documents',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'tags', type: 'text[]' },
          ],
          indexes: [{ name: 'idx_documents_tags', columns: ['tags'], method: 'gin' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('USING gin');
    });

    it('generates index with gist method', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'locations',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'geom', type: 'geometry' },
          ],
          indexes: [{ name: 'idx_locations_geom', columns: ['geom'], method: 'gist' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('USING gist');
    });

    it('generates index with hash method', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          indexes: [{ name: 'idx_users_email_hash', columns: ['email'], method: 'hash' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('USING hash');
    });

    it('generates index with brin method', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'events',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'created_at', type: 'timestamptz' },
          ],
          indexes: [{ name: 'idx_events_created_at', columns: ['created_at'], method: 'brin' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('USING brin');
    });

    it('generates partial index with WHERE clause', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'active', type: 'boolean' },
          ],
          indexes: [{ name: 'idx_users_email_active', columns: ['email'], where: 'active = true' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('WHERE active = true');
    });

    it('generates covering index with INCLUDE', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'name', type: 'text' },
          ],
          indexes: [{ name: 'idx_users_email_incl_name', columns: ['email'], include: ['name'] }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('INCLUDE ("name")');
    });

    it('generates index with opclass', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          indexes: [{ name: 'idx_users_email_pattern', columns: ['email'], opclass: 'text_pattern_ops' }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('"email" text_pattern_ops');
    });

    it('generates index with all options combined', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'name', type: 'text' },
            { name: 'active', type: 'boolean' },
          ],
          indexes: [
            {
              name: 'idx_users_complex',
              columns: ['email'],
              unique: true,
              include: ['name'],
              where: 'active = true',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'add_index');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('CREATE UNIQUE INDEX CONCURRENTLY');
      expect(ops[0].sql).toContain('INCLUDE ("name")');
      expect(ops[0].sql).toContain('WHERE active = true');
    });
  });

  describe('extension schema_grants', () => {
    it('produces grant_schema operations from schema_grants', () => {
      const desired = emptyDesired();
      desired.extensions = {
        extensions: ['pgcrypto'],
        schema_grants: [{ to: 'app_user', schemas: ['public'] }],
      };
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_schema');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toBe('GRANT USAGE ON SCHEMA "public" TO "app_user"');
      expect(ops[0].objectName).toBe('public.app_user');
      expect(ops[0].phase).toBe(13);
      expect(ops[0].destructive).toBe(false);
    });

    it('produces multiple grant_schema for multiple schemas and roles', () => {
      const desired = emptyDesired();
      desired.extensions = {
        extensions: ['pgcrypto'],
        schema_grants: [
          { to: 'app_user', schemas: ['public', 'extensions'] },
          { to: 'readonly', schemas: ['public'] },
        ],
      };
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_schema');
      expect(ops).toHaveLength(3);
      expect(ops[0].sql).toBe('GRANT USAGE ON SCHEMA "public" TO "app_user"');
      expect(ops[1].sql).toBe('GRANT USAGE ON SCHEMA "extensions" TO "app_user"');
      expect(ops[2].sql).toBe('GRANT USAGE ON SCHEMA "public" TO "readonly"');
    });

    it('produces no grant_schema when schema_grants is absent', () => {
      const desired = emptyDesired();
      desired.extensions = { extensions: ['pgcrypto'] };
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'grant_schema');
      expect(ops).toHaveLength(0);
    });
  });

  describe('prechecks', () => {
    it('produces run_precheck operations for new table with prechecks', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          prechecks: [
            {
              name: 'no_orphans',
              query: 'SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)',
              message: 'Orphaned orders exist — fix before migrating',
            },
          ],
        },
      ];

      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'run_precheck');
      expect(ops).toHaveLength(1);
      expect(ops[0].objectName).toBe('users.no_orphans');
      expect(ops[0].sql).toBe('SELECT count(*) = 0 FROM orders WHERE user_id NOT IN (SELECT id FROM users)');
      expect(ops[0].precheckMessage).toBe('Orphaned orders exist — fix before migrating');
      expect(ops[0].phase).toBe(0);
    });

    it('produces run_precheck operations for existing table being altered', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          prechecks: [
            {
              name: 'validate_emails',
              query: 'SELECT count(*) = 0 FROM users WHERE email IS NULL',
              message: 'Null emails exist',
            },
          ],
        },
      ];

      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
      });

      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'run_precheck');
      expect(ops).toHaveLength(1);
      expect(ops[0].objectName).toBe('users.validate_emails');
      expect(ops[0].phase).toBe(0);
    });

    it('prechecks run before other operations (phase 0)', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          prechecks: [{ name: 'check1', query: 'SELECT true', message: 'fail' }],
        },
      ];

      const result = buildPlan(desired, emptyActual());
      // The first operation should be the precheck
      expect(result.operations[0].type).toBe('run_precheck');
      expect(result.operations[0].phase).toBe(0);
      // create_table should come after
      const createOp = result.operations.find((o) => o.type === 'create_table');
      expect(createOp).toBeDefined();
      expect(createOp!.phase).toBeGreaterThan(0);
    });
  });

  describe('generated columns', () => {
    it('includes GENERATED ALWAYS AS ... STORED in CREATE TABLE SQL', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'price', type: 'numeric' },
            { name: 'quantity', type: 'integer' },
            { name: 'total', type: 'numeric', generated: 'price * quantity' },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const createOp = findOps(result.operations, 'create_table')[0];
      expect(createOp).toBeDefined();
      expect(createOp.sql).toContain('GENERATED ALWAYS AS (price * quantity) STORED');
    });

    it('includes GENERATED ALWAYS AS ... STORED in ADD COLUMN SQL', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'price', type: 'numeric' },
            { name: 'quantity', type: 'integer' },
            { name: 'total', type: 'numeric', generated: 'price * quantity' },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('orders', {
        table: 'orders',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'price', type: 'numeric' },
          { name: 'quantity', type: 'integer' },
        ],
      });
      const result = buildPlan(desired, actual);
      const addOp = findOps(result.operations, 'add_column')[0];
      expect(addOp).toBeDefined();
      expect(addOp.sql).toContain('GENERATED ALWAYS AS (price * quantity) STORED');
    });
  });

  describe('composite primary keys', () => {
    it('does not add individual PRIMARY KEY on columns when composite primary_key is set', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'order_items',
          columns: [
            { name: 'order_id', type: 'uuid' },
            { name: 'product_id', type: 'uuid' },
            { name: 'quantity', type: 'integer' },
          ],
          primary_key: ['order_id', 'product_id'],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('PRIMARY KEY ("order_id", "product_id")');
      // Individual columns should NOT have PRIMARY KEY
      expect(ops[0].sql).not.toMatch(/"order_id" uuid PRIMARY KEY/);
      expect(ops[0].sql).not.toMatch(/"product_id" uuid PRIMARY KEY/);
    });

    it('creates table with 3-column composite primary key', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'tenant_user_roles',
          columns: [
            { name: 'tenant_id', type: 'uuid' },
            { name: 'user_id', type: 'uuid' },
            { name: 'role_id', type: 'uuid' },
          ],
          primary_key: ['tenant_id', 'user_id', 'role_id'],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_table');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('PRIMARY KEY ("tenant_id", "user_id", "role_id")');
    });
  });

  // ─── Trigger for_each and when clause (T-042) ──────────────────

  describe('trigger for_each and when clause', () => {
    it('creates trigger with FOR EACH STATEMENT', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'audit_log',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'audit_after_truncate',
              timing: 'AFTER',
              events: ['TRUNCATE'],
              function: 'log_truncate',
              for_each: 'STATEMENT',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_trigger');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('FOR EACH STATEMENT');
      expect(ops[0].sql).not.toContain('FOR EACH ROW');
      expect(ops[0].sql).toContain('AFTER TRUNCATE');
      expect(ops[0].sql).toContain('log_truncate()');
    });

    it('creates trigger with WHEN clause', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'set_updated_at',
              timing: 'BEFORE',
              events: ['UPDATE'],
              function: 'update_timestamp',
              for_each: 'ROW',
              when: 'OLD.* IS DISTINCT FROM NEW.*',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_trigger');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('WHEN (OLD.* IS DISTINCT FROM NEW.*)');
      expect(ops[0].sql).toContain('FOR EACH ROW');
    });

    it('creates trigger with FOR EACH STATEMENT and WHEN clause', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'orders',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'check_batch',
              timing: 'AFTER',
              events: ['INSERT', 'UPDATE'],
              function: 'validate_batch',
              for_each: 'STATEMENT',
              when: 'pg_trigger_depth() = 0',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_trigger');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('FOR EACH STATEMENT');
      expect(ops[0].sql).toContain('WHEN (pg_trigger_depth() = 0)');
      expect(ops[0].sql).toContain('INSERT OR UPDATE');
    });

    it('defaults for_each to ROW when not specified', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'items',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'trg_default',
              timing: 'AFTER',
              events: ['INSERT'],
              function: 'notify_insert',
            },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const ops = findOps(result.operations, 'create_trigger');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('FOR EACH ROW');
    });

    it('recreates trigger when for_each changes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'events',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'trg_notify',
              timing: 'AFTER',
              events: ['INSERT'],
              function: 'notify_event',
              for_each: 'STATEMENT',
            },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('events', {
        table: 'events',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        triggers: [
          {
            name: 'trg_notify',
            timing: 'AFTER',
            events: ['INSERT'],
            function: 'notify_event',
            for_each: 'ROW',
          },
        ],
      });
      const result = buildPlan(desired, actual);
      const dropOps = findOps(result.operations, 'drop_trigger');
      const createOps = findOps(result.operations, 'create_trigger');
      expect(dropOps).toHaveLength(1);
      expect(createOps).toHaveLength(1);
      expect(createOps[0].sql).toContain('FOR EACH STATEMENT');
    });

    it('recreates trigger when when clause changes', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          triggers: [
            {
              name: 'trg_audit',
              timing: 'AFTER',
              events: ['UPDATE'],
              function: 'audit_change',
              for_each: 'ROW',
              when: 'OLD.email IS DISTINCT FROM NEW.email',
            },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        triggers: [
          {
            name: 'trg_audit',
            timing: 'AFTER',
            events: ['UPDATE'],
            function: 'audit_change',
            for_each: 'ROW',
          },
        ],
      });
      const result = buildPlan(desired, actual);
      const dropOps = findOps(result.operations, 'drop_trigger');
      const createOps = findOps(result.operations, 'create_trigger');
      expect(dropOps).toHaveLength(1);
      expect(createOps).toHaveLength(1);
      expect(createOps[0].sql).toContain('WHEN (OLD.email IS DISTINCT FROM NEW.email)');
    });
  });

  describe('with_grant_option', () => {
    it('produces GRANT ... WITH GRANT OPTION for table-level grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          grants: [{ to: 'admin', privileges: ['SELECT', 'INSERT'], with_grant_option: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_table');
      expect(grantOps).toHaveLength(1);
      expect(grantOps[0].sql).toContain('WITH GRANT OPTION');
    });

    it('does not include WITH GRANT OPTION when flag is false', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          grants: [{ to: 'reader', privileges: ['SELECT'], with_grant_option: false }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_table');
      expect(grantOps).toHaveLength(1);
      expect(grantOps[0].sql).not.toContain('WITH GRANT OPTION');
    });

    it('produces GRANT ... WITH GRANT OPTION for column-level grants', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
          ],
          grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['email'], with_grant_option: true }],
        },
      ];
      const result = buildPlan(desired, emptyActual());
      const grantOps = findOps(result.operations, 'grant_column');
      expect(grantOps).toHaveLength(1);
      expect(grantOps[0].sql).toContain('WITH GRANT OPTION');
      expect(grantOps[0].sql).toContain('SELECT ("email")');
    });
  });

  describe('PRD §8.1 destructive operation blocking', () => {
    it('blocks disable_rls when existing table has policies but desired has none', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          // No policies
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        policies: [
          {
            name: 'user_policy',
            for: 'SELECT',
            to: 'public',
            using: 'true',
          },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'disable_rls')).toBe(true);
    });

    it('allows disable_rls with allowDestructive', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        policies: [
          {
            name: 'user_policy',
            for: 'SELECT',
            to: 'public',
            using: 'true',
          },
        ],
      });
      const result = buildPlan(desired, actual, { allowDestructive: true });
      const ops = findOps(result.operations, 'disable_rls');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('DISABLE ROW LEVEL SECURITY');
    });

    it('enables force_rls when desired but not in DB', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          rls: true,
          force_rls: true,
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        rls: true,
      });
      const result = buildPlan(desired, actual);
      const ops = findOps(result.operations, 'force_rls');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('FORCE ROW LEVEL SECURITY');
    });

    it('blocks disable_force_rls when force_rls removed from desired', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          rls: true,
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        rls: true,
        force_rls: true,
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'disable_force_rls')).toBe(true);
    });

    it('allows disable_force_rls with allowDestructive', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          rls: true,
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        rls: true,
        force_rls: true,
      });
      const result = buildPlan(desired, actual, { allowDestructive: true });
      const ops = findOps(result.operations, 'disable_force_rls');
      expect(ops).toHaveLength(1);
      expect(ops[0].sql).toContain('NO FORCE ROW LEVEL SECURITY');
    });

    it('blocks drop_policy when policy exists in DB but not in desired', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [{ name: 'id', type: 'uuid', primary_key: true }],
          policies: [
            {
              name: 'keep_policy',
              for: 'SELECT',
              to: 'public',
              using: 'true',
            },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [{ name: 'id', type: 'uuid', primary_key: true }],
        policies: [
          { name: 'keep_policy', for: 'SELECT', to: 'public', using: 'true' },
          { name: 'old_policy', for: 'ALL', to: 'public', using: 'true' },
        ],
      });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_policy')).toBe(true);
    });

    it('blocks drop_view when view exists in DB but not in desired', () => {
      const desired = emptyDesired();
      const actual = emptyActual();
      actual.views.set('old_view', { name: 'old_view', query: 'SELECT 1' });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_view')).toBe(true);
    });

    it('blocks drop_materialized_view when mat view exists in DB but not in desired', () => {
      const desired = emptyDesired();
      const actual = emptyActual();
      actual.materializedViews.set('old_mv', { name: 'old_mv', query: 'SELECT 1' });
      const result = buildPlan(desired, actual);
      expect(result.blocked.some((o) => o.type === 'drop_materialized_view')).toBe(true);
    });
  });

  // ─── Expand/contract YAML-driven (T-050) ──────────────────────

  describe('expand/contract YAML-driven', () => {
    it('produces expand operations when column has expand field on existing table', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'email_lower', type: 'text', expand: { from: 'email', transform: 'lower(email)' } },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      });
      const result = buildPlan(desired, actual);

      // Should produce expand_column instead of plain add_column
      const expandOps = findOps(result.operations, 'expand_column');
      expect(expandOps).toHaveLength(1);
      expect(expandOps[0].sql).toContain('ADD COLUMN');
      expect(expandOps[0].sql).toContain('email_lower');

      // Should produce dual-write trigger
      const triggerOps = findOps(result.operations, 'create_dual_write_trigger');
      expect(triggerOps).toHaveLength(1);
      expect(triggerOps[0].sql).toContain('lower(');

      // Should produce backfill
      const backfillOps = findOps(result.operations, 'backfill_column');
      expect(backfillOps).toHaveLength(1);
      expect(backfillOps[0].sql).toContain('UPDATE');

      // Should NOT produce a plain add_column
      const addColOps = findOps(result.operations, 'add_column');
      expect(addColOps).toHaveLength(0);
    });

    it('produces expand operations for new table with expand column', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'email_lower', type: 'text', expand: { from: 'email', transform: 'lower(email)' } },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());

      // create_table should be generated for the table itself
      const createOps = findOps(result.operations, 'create_table');
      expect(createOps).toHaveLength(1);
      // The expand column should NOT be in the CREATE TABLE SQL
      expect(createOps[0].sql).not.toContain('email_lower');

      // Expand operations should be generated separately
      const expandOps = findOps(result.operations, 'expand_column');
      expect(expandOps).toHaveLength(1);
      const triggerOps = findOps(result.operations, 'create_dual_write_trigger');
      expect(triggerOps).toHaveLength(1);
      const backfillOps = findOps(result.operations, 'backfill_column');
      expect(backfillOps).toHaveLength(1);
    });

    it('expand operations have higher phase than table creation', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'email', type: 'text' },
            { name: 'email_lower', type: 'text', expand: { from: 'email', transform: 'lower(email)' } },
          ],
        },
      ];
      const result = buildPlan(desired, emptyActual());

      const createOps = findOps(result.operations, 'create_table');
      const expandOps = findOps(result.operations, 'expand_column');
      const triggerOps = findOps(result.operations, 'create_dual_write_trigger');
      const backfillOps = findOps(result.operations, 'backfill_column');

      // Expand ops should come after table creation
      expect(expandOps[0].phase).toBeGreaterThan(createOps[0].phase);
      expect(triggerOps[0].phase).toBeGreaterThan(expandOps[0].phase);
      expect(backfillOps[0].phase).toBeGreaterThan(triggerOps[0].phase);
    });

    it('uses identity transform for simple rename expand', () => {
      const desired = emptyDesired();
      desired.tables = [
        {
          table: 'users',
          columns: [
            { name: 'id', type: 'uuid', primary_key: true },
            { name: 'full_name', type: 'text' },
            { name: 'display_name', type: 'text', expand: { from: 'full_name', transform: 'full_name' } },
          ],
        },
      ];
      const actual = emptyActual();
      actual.tables.set('users', {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'full_name', type: 'text' },
        ],
      });
      const result = buildPlan(desired, actual);
      const expandOps = findOps(result.operations, 'expand_column');
      expect(expandOps).toHaveLength(1);
      const backfillOps = findOps(result.operations, 'backfill_column');
      expect(backfillOps[0].sql).toContain('full_name');
    });
  });
});
