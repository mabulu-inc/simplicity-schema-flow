import { describe, it, expect, afterAll } from 'vitest';
import { detectDrift } from '../index.js';
import type { DriftItemType } from '../index.js';
import type { DesiredState, ActualState } from '../../planner/index.js';
import { useTestProject, writeSchema } from '../../testing/index.js';
import { buildPlan } from '../../planner/index.js';
import { execute } from '../../executor/index.js';
import { createLogger } from '../../core/logger.js';
import { closePool } from '../../core/db.js';
import { buildDesiredAndActual } from '../../cli/pipeline.js';

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

describe('detectDrift', () => {
  it('returns empty report when desired and actual are both empty', () => {
    const report = detectDrift(emptyDesired(), emptyActual());
    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  // ─── Tables ────────────────────────────────────────────────────

  it('reports table missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'users',
        status: 'missing_in_db',
      }),
    );
    expect(report.summary.total).toBeGreaterThan(0);
  });

  it('reports table missing in YAML', () => {
    const actual = emptyActual();
    actual.tables.set('legacy', {
      table: 'legacy',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'legacy',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── RLS / force_rls ──────────────────────────────────────────

  it('reports force_rls drift when desired but not in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        rls: true,
        force_rls: true,
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      rls: true,
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'users',
        status: 'different',
        detail: expect.stringContaining('force_rls'),
      }),
    );
  });

  it('reports force_rls drift when in DB but not desired', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        rls: true,
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      rls: true,
      force_rls: true,
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'users',
        status: 'different',
        detail: expect.stringContaining('force_rls'),
      }),
    );
  });

  it('reports no drift when force_rls matches', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        rls: true,
        force_rls: true,
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      rls: true,
      force_rls: true,
    });
    const report = detectDrift(desired, actual);
    const forceRlsItems = report.items.filter((i) => i.detail?.includes('force_rls'));
    expect(forceRlsItems).toHaveLength(0);
  });

  it('reports RLS drift when desired but not in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        rls: true,
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'table',
        object: 'users',
        status: 'different',
        detail: expect.stringContaining('RLS'),
      }),
    );
  });

  // ─── Columns ───────────────────────────────────────────────────

  it('reports column missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text', nullable: false },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.email',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports column missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'old_col', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.old_col',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports column type difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'age', type: 'bigint' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'age', type: 'integer' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.age',
        status: 'different',
        expected: expect.stringContaining('bigint'),
        actual: expect.stringContaining('integer'),
      }),
    );
  });

  it('reports column nullability difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text', nullable: false },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.name',
        status: 'different',
        detail: expect.stringContaining('nullable'),
      }),
    );
  });

  it('reports column default difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'active', type: 'boolean', default: 'true' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'active', type: 'boolean' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'column',
        object: 'users.active',
        status: 'different',
        detail: expect.stringContaining('default'),
      }),
    );
  });

  // ─── Indexes ───────────────────────────────────────────────────

  it('reports index missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_email',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports index missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      indexes: [{ name: 'idx_old', columns: ['id'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_old',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Enums ─────────────────────────────────────────────────────

  it('reports enum missing in DB', () => {
    const desired = emptyDesired();
    desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'status',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports enum missing in YAML', () => {
    const actual = emptyActual();
    actual.enums.set('old_status', { name: 'old_status', values: ['a', 'b'] });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'old_status',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports enum value differences', () => {
    const desired = emptyDesired();
    desired.enums = [{ name: 'status', values: ['active', 'inactive', 'pending'] }];
    const actual = emptyActual();
    actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'enum',
        object: 'status',
        status: 'different',
      }),
    );
  });

  // ─── Functions ─────────────────────────────────────────────────

  it('reports function missing in DB', () => {
    const desired = emptyDesired();
    desired.functions = [{ name: 'my_func', returns: 'trigger', body: 'BEGIN RETURN NEW; END;', language: 'plpgsql' }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'my_func',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports function missing in YAML', () => {
    const actual = emptyActual();
    actual.functions.set('old_func', { name: 'old_func', returns: 'void', body: '', language: 'sql' });
    const report = detectDrift(emptyDesired(), actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'old_func',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Views ─────────────────────────────────────────────────────

  it('reports view missing in DB', () => {
    const desired = emptyDesired();
    desired.views = [{ name: 'active_users', query: 'SELECT * FROM users WHERE active = true' }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'view',
        object: 'active_users',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports view query difference', () => {
    const desired = emptyDesired();
    desired.views = [{ name: 'active_users', query: 'SELECT * FROM users WHERE active = true' }];
    const actual = emptyActual();
    actual.views.set('active_users', { name: 'active_users', query: 'SELECT * FROM users WHERE active = false' });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'view',
        object: 'active_users',
        status: 'different',
      }),
    );
  });

  it('reports view grant missing in DB', () => {
    const desired = emptyDesired();
    desired.views = [
      {
        name: 'active_users',
        query: 'SELECT * FROM users WHERE active = true',
        grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
      },
    ];
    const actual = emptyActual();
    actual.views.set('active_users', { name: 'active_users', query: 'SELECT * FROM users WHERE active = true' });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: 'active_users:app_readonly',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports view grant extra in DB (missing in YAML)', () => {
    const desired = emptyDesired();
    desired.views = [
      {
        name: 'active_users',
        query: 'SELECT * FROM users WHERE active = true',
        grants: [],
      },
    ];
    const actual = emptyActual();
    actual.views.set('active_users', {
      name: 'active_users',
      query: 'SELECT * FROM users WHERE active = true',
      grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: 'active_users:app_readonly',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports no drift when view grants match', () => {
    const desired = emptyDesired();
    desired.views = [
      {
        name: 'active_users',
        query: 'SELECT * FROM users WHERE active = true',
        grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
      },
    ];
    const actual = emptyActual();
    actual.views.set('active_users', {
      name: 'active_users',
      query: 'SELECT * FROM users WHERE active = true',
      grants: [{ to: 'app_readonly', privileges: ['SELECT'] }],
    });
    const report = detectDrift(desired, actual);
    const grantItems = report.items.filter((i) => i.type === 'grant' && i.object.startsWith('active_users'));
    expect(grantItems).toHaveLength(0);
  });

  // ─── Materialized Views ────────────────────────────────────────

  it('reports materialized view missing in DB', () => {
    const desired = emptyDesired();
    desired.materializedViews = [{ name: 'mv_stats', query: 'SELECT count(*) FROM users' }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'materialized_view',
        object: 'mv_stats',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports materialized view query difference', () => {
    const desired = emptyDesired();
    desired.materializedViews = [{ name: 'mv_stats', query: 'SELECT count(*) FROM users' }];
    const actual = emptyActual();
    actual.materializedViews.set('mv_stats', { name: 'mv_stats', query: 'SELECT sum(1) FROM users' });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'materialized_view',
        object: 'mv_stats',
        status: 'different',
      }),
    );
  });

  // ─── Roles ─────────────────────────────────────────────────────

  it('reports role missing in DB', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'app_user', login: true }];
    const report = detectDrift(desired, emptyActual());
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'app_user',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports role attribute difference', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'app_user', login: true }];
    const actual = emptyActual();
    actual.roles.set('app_user', { role: 'app_user', login: false });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'app_user',
        status: 'different',
      }),
    );
  });

  it('reports superuser attribute difference', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'admin', superuser: true }];
    const actual = emptyActual();
    actual.roles.set('admin', { role: 'admin', superuser: false });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'admin',
        status: 'different',
        detail: expect.stringContaining('superuser'),
      }),
    );
  });

  it('reports multiple role attribute differences', () => {
    const desired = emptyDesired();
    desired.roles = [
      {
        role: 'power_user',
        createdb: true,
        createrole: true,
        inherit: false,
        bypassrls: true,
        replication: true,
        connection_limit: 10,
      },
    ];
    const actual = emptyActual();
    actual.roles.set('power_user', {
      role: 'power_user',
      createdb: false,
      createrole: false,
      inherit: true,
      bypassrls: false,
      replication: false,
      connection_limit: -1,
    });
    const report = detectDrift(desired, actual);
    const item = report.items.find((i) => i.object === 'power_user');
    expect(item).toBeDefined();
    expect(item!.status).toBe('different');
    expect(item!.detail).toContain('createdb');
    expect(item!.detail).toContain('createrole');
    expect(item!.detail).toContain('inherit');
    expect(item!.detail).toContain('bypassrls');
    expect(item!.detail).toContain('replication');
    expect(item!.detail).toContain('connection_limit');
  });

  it('reports no drift when all role attributes match', () => {
    const desired = emptyDesired();
    desired.roles = [
      {
        role: 'app_user',
        login: true,
        createdb: false,
        inherit: true,
      },
    ];
    const actual = emptyActual();
    actual.roles.set('app_user', {
      role: 'app_user',
      login: true,
      createdb: false,
      inherit: true,
    });
    const report = detectDrift(desired, actual);
    const roleItems = report.items.filter((i) => i.type === 'role');
    expect(roleItems).toHaveLength(0);
  });

  // ─── Extensions ────────────────────────────────────────────────

  it('reports extension missing in DB', () => {
    const desired = emptyDesired();
    desired.extensions = { extensions: ['uuid-ossp', 'pgcrypto'] };
    const actual = emptyActual();
    actual.extensions = ['uuid-ossp'];
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'extension' as DriftItemType,
        object: 'pgcrypto',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports extension missing in YAML', () => {
    const desired = emptyDesired();
    desired.extensions = { extensions: ['uuid-ossp'] };
    const actual = emptyActual();
    actual.extensions = ['uuid-ossp', 'pgcrypto'];
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'extension' as DriftItemType,
        object: 'pgcrypto',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Triggers ──────────────────────────────────────────────────

  it('reports trigger missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        triggers: [{ name: 'trg_updated', timing: 'BEFORE', events: ['UPDATE'], function: 'set_updated_at' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'users.trg_updated',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports trigger missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [{ name: 'trg_old', timing: 'BEFORE', events: ['UPDATE'], function: 'old_func' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'users.trg_old',
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Policies ──────────────────────────────────────────────────

  it('reports policy missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        policies: [{ name: 'user_access', to: 'app_user', using: 'id = current_user_id()' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'policy',
        object: 'users.user_access',
        status: 'missing_in_db',
      }),
    );
  });

  // ─── Checks ────────────────────────────────────────────────────

  it('reports check constraint missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'age', type: 'integer' },
        ],
        checks: [{ name: 'chk_age_positive', expression: 'age > 0' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'age', type: 'integer' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: 'users.chk_age_positive',
        status: 'missing_in_db',
      }),
    );
  });

  // ─── Comments ──────────────────────────────────────────────────

  it('reports table comment difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        comment: 'User accounts',
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      comment: 'Old comment',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'comment',
        object: 'users',
        status: 'different',
      }),
    );
  });

  // ─── Summary ───────────────────────────────────────────────────

  it('populates summary with totals and byType counts', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      },
    ];
    desired.enums = [{ name: 'status', values: ['a'] }];
    const report = detectDrift(desired, emptyActual());
    expect(report.summary.total).toBe(report.items.length);
    expect(report.summary.byType).toBeDefined();
    // Should have entries for table and enum at minimum
    expect(report.summary.byType['table']).toBeGreaterThanOrEqual(1);
    expect(report.summary.byType['enum']).toBeGreaterThanOrEqual(1);
  });

  // ─── No drift when matching ────────────────────────────────────

  it('returns empty report when desired and actual match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      },
    ];
    desired.enums = [{ name: 'status', values: ['active', 'inactive'] }];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
    });
    actual.enums.set('status', { name: 'status', values: ['active', 'inactive'] });
    const report = detectDrift(desired, actual);
    expect(report.items).toEqual([]);
    expect(report.summary.total).toBe(0);
  });

  // ─── Index attribute differences ─────────────────────────────

  it('reports index uniqueness difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      indexes: [{ name: 'idx_users_email', columns: ['email'], unique: false }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_email',
        status: 'different',
        detail: expect.stringContaining('unique'),
      }),
    );
  });

  it('reports index method difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'data', type: 'jsonb' },
        ],
        indexes: [{ name: 'idx_users_data', columns: ['data'], method: 'gin' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'data', type: 'jsonb' },
      ],
      indexes: [{ name: 'idx_users_data', columns: ['data'], method: 'btree' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_data',
        status: 'different',
        detail: expect.stringContaining('method'),
      }),
    );
  });

  it('reports index partial condition (where) difference', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'active', type: 'boolean' },
        ],
        indexes: [{ name: 'idx_users_active', columns: ['id'], where: 'active = true' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'active', type: 'boolean' },
      ],
      indexes: [{ name: 'idx_users_active', columns: ['id'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_active',
        status: 'different',
        detail: expect.stringContaining('where'),
      }),
    );
  });

  it('reports index column differences', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
          { name: 'name', type: 'text' },
        ],
        indexes: [{ name: 'idx_users_email', columns: ['email', 'name'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
        { name: 'name', type: 'text' },
      ],
      indexes: [{ name: 'idx_users_email', columns: ['email'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'index',
        object: 'idx_users_email',
        status: 'different',
        detail: expect.stringContaining('columns'),
      }),
    );
  });

  // ─── FK constraint drift ──────────────────────────────────────

  it('reports FK missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id' } },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('posts.user_id'),
        status: 'different',
        detail: expect.stringContaining('FK'),
      }),
    );
  });

  it('reports FK present in DB but not in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'user_id', type: 'integer' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id' } },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('posts.user_id'),
        status: 'different',
        detail: expect.stringContaining('FK'),
      }),
    );
  });

  it('reports FK on_delete action drift', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', on_delete: 'CASCADE' } },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', on_delete: 'SET NULL' } },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('posts.user_id'),
        status: 'different',
        detail: expect.stringContaining('on_delete'),
      }),
    );
  });

  it('reports FK on_update action drift', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', on_update: 'CASCADE' } },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', on_update: 'NO ACTION' } },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('posts.user_id'),
        status: 'different',
        detail: expect.stringContaining('on_update'),
      }),
    );
  });

  it('reports FK deferrable drift', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          {
            name: 'user_id',
            type: 'integer',
            references: { table: 'users', column: 'id', deferrable: true, initially_deferred: true },
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', deferrable: false } },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('posts.user_id'),
        status: 'different',
        detail: expect.stringContaining('deferrable'),
      }),
    );
  });

  it('reports FK schema drift', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          {
            name: 'user_id',
            type: 'integer',
            references: { table: 'users', column: 'id', schema: 'auth' },
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id' } },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: 'posts.user_id',
        status: 'different',
        detail: expect.stringContaining('FK schema differs'),
      }),
    );
  });

  it('reports no FK schema drift when both match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'posts',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          {
            name: 'user_id',
            type: 'integer',
            references: { table: 'users', column: 'id', schema: 'auth' },
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('posts', {
      table: 'posts',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'user_id', type: 'integer', references: { table: 'users', column: 'id', schema: 'auth' } },
      ],
    });
    const report = detectDrift(desired, actual);
    const schemaItems = report.items.filter((i) => i.detail?.includes('FK schema'));
    expect(schemaItems).toHaveLength(0);
  });

  // ─── Unique constraint drift ──────────────────────────────────

  it('reports unique constraint missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('uq_users_email'),
        status: 'missing_in_db',
      }),
    );
  });

  it('reports unique constraint missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'email', type: 'text' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      unique_constraints: [{ columns: ['email'], name: 'uq_users_email' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'constraint',
        object: expect.stringContaining('uq_users_email'),
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Function attribute differences ───────────────────────────

  it('reports function body difference', () => {
    const desired = emptyDesired();
    desired.functions = [{ name: 'my_func', returns: 'trigger', body: 'BEGIN RETURN NEW; END;', language: 'plpgsql' }];
    const actual = emptyActual();
    actual.functions.set('my_func', {
      name: 'my_func',
      returns: 'trigger',
      body: 'BEGIN RETURN OLD; END;',
      language: 'plpgsql',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'my_func',
        status: 'different',
        detail: expect.stringContaining('body'),
      }),
    );
  });

  it('reports function args difference', () => {
    const desired = emptyDesired();
    desired.functions = [
      {
        name: 'add_nums',
        returns: 'integer',
        body: 'SELECT a + b',
        language: 'sql',
        args: [
          { name: 'a', type: 'integer' },
          { name: 'b', type: 'integer' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.functions.set('add_nums', {
      name: 'add_nums',
      returns: 'integer',
      body: 'SELECT a + b',
      language: 'sql',
      args: [{ name: 'a', type: 'text' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'add_nums',
        status: 'different',
        detail: expect.stringContaining('args'),
      }),
    );
  });

  it('reports function return type difference', () => {
    const desired = emptyDesired();
    desired.functions = [{ name: 'get_count', returns: 'bigint', body: 'SELECT count(*) FROM t', language: 'sql' }];
    const actual = emptyActual();
    actual.functions.set('get_count', {
      name: 'get_count',
      returns: 'integer',
      body: 'SELECT count(*) FROM t',
      language: 'sql',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'get_count',
        status: 'different',
        detail: expect.stringContaining('returns'),
      }),
    );
  });

  it('reports function security difference', () => {
    const desired = emptyDesired();
    desired.functions = [{ name: 'sec_func', returns: 'void', body: 'SELECT 1', language: 'sql', security: 'definer' }];
    const actual = emptyActual();
    actual.functions.set('sec_func', {
      name: 'sec_func',
      returns: 'void',
      body: 'SELECT 1',
      language: 'sql',
      security: 'invoker',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'sec_func',
        status: 'different',
        detail: expect.stringContaining('security'),
      }),
    );
  });

  it('reports function volatility difference', () => {
    const desired = emptyDesired();
    desired.functions = [
      { name: 'vol_func', returns: 'void', body: 'SELECT 1', language: 'sql', volatility: 'immutable' },
    ];
    const actual = emptyActual();
    actual.functions.set('vol_func', {
      name: 'vol_func',
      returns: 'void',
      body: 'SELECT 1',
      language: 'sql',
      volatility: 'volatile',
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'function',
        object: 'vol_func',
        status: 'different',
        detail: expect.stringContaining('volatility'),
      }),
    );
  });

  // ─── Role membership drift ───────────────────────────────────

  it('reports role membership difference', () => {
    const desired = emptyDesired();
    desired.roles = [{ role: 'app_user', login: true, in: ['readers'] }];
    const actual = emptyActual();
    actual.roles.set('app_user', { role: 'app_user', login: true });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'role',
        object: 'app_user',
        status: 'different',
        detail: expect.stringContaining('membership'),
      }),
    );
  });

  // ─── Grant drift ──────────────────────────────────────────────

  it('reports table grant missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        grants: [{ to: 'app_user', privileges: ['SELECT', 'INSERT'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: expect.stringContaining('users'),
        status: 'missing_in_db',
      }),
    );
  });

  it('reports table grant missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      grants: [{ to: 'old_role', privileges: ['SELECT'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: expect.stringContaining('users'),
        status: 'missing_in_yaml',
      }),
    );
  });

  // ─── Seed drift ───────────────────────────────────────────────

  it('reports seed drift when YAML has seeds but DB table has no seeds field', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('statuses', {
      table: 'statuses',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'seed',
        object: 'statuses',
        status: 'different',
      }),
    );
  });

  // ─── Type alias normalization ──────────────────────────────────

  it('does not report drift for equivalent type aliases (int vs integer)', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'int', primary_key: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
    });
    const report = detectDrift(desired, actual);
    const colDrifts = report.items.filter((i) => i.type === 'column');
    expect(colDrifts).toEqual([]);
  });

  // ─── Generated Columns ──────────────────────────────────────────

  it('reports generated column missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'total', type: 'numeric', generated: 'price * quantity' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('orders', {
      table: 'orders',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'total', type: 'numeric' },
      ],
    });
    const report = detectDrift(desired, actual);
    const genDrift = report.items.find(
      (i) => i.type === 'column' && i.object === 'orders.total' && i.detail?.includes('generated'),
    );
    expect(genDrift).toBeDefined();
    expect(genDrift!.expected).toBe('price * quantity');
    expect(genDrift!.actual).toBe('(none)');
  });

  it('reports generated column expression differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'total', type: 'numeric', generated: 'price * quantity' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('orders', {
      table: 'orders',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'total', type: 'numeric', generated: 'price + quantity' },
      ],
    });
    const report = detectDrift(desired, actual);
    const genDrift = report.items.find(
      (i) => i.type === 'column' && i.object === 'orders.total' && i.detail?.includes('generated'),
    );
    expect(genDrift).toBeDefined();
    expect(genDrift!.status).toBe('different');
  });

  it('reports generated column in DB but not in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'total', type: 'numeric' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('orders', {
      table: 'orders',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'total', type: 'numeric', generated: 'price * quantity' },
      ],
    });
    const report = detectDrift(desired, actual);
    const genDrift = report.items.find(
      (i) => i.type === 'column' && i.object === 'orders.total' && i.detail?.includes('generated'),
    );
    expect(genDrift).toBeDefined();
    expect(genDrift!.expected).toBe('(none)');
  });

  it('no drift when generated expressions match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'orders',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'total', type: 'numeric', generated: 'price * quantity' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('orders', {
      table: 'orders',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'total', type: 'numeric', generated: 'price * quantity' },
      ],
    });
    const report = detectDrift(desired, actual);
    const genDrift = report.items.filter(
      (i) => i.type === 'column' && i.object === 'orders.total' && i.detail?.includes('generated'),
    );
    expect(genDrift).toHaveLength(0);
  });

  // ─── Column-level grant drift ─────────────────────────────────

  it('reports column-level grant missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['id', 'email'] }],
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
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: 'users:reader',
        status: 'missing_in_db',
      }),
    );
  });

  it('reports column-level grant missing in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
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
      grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['id', 'email'] }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'grant',
        object: 'users:reader',
        status: 'missing_in_yaml',
      }),
    );
  });

  it('reports no drift when column-level grants match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [
          { name: 'id', type: 'uuid', primary_key: true },
          { name: 'email', type: 'text' },
        ],
        grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['email', 'id'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [
        { name: 'id', type: 'uuid', primary_key: true },
        { name: 'email', type: 'text' },
      ],
      grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['id', 'email'] }],
    });
    const report = detectDrift(desired, actual);
    const grantDrift = report.items.filter((i) => i.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });

  it('detects drift when column-level grant columns differ', () => {
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
      grants: [{ to: 'reader', privileges: ['SELECT'], columns: ['id', 'email'] }],
    });
    const report = detectDrift(desired, actual);
    // The desired has 3 columns, actual has 2 — these are different keys so both should be reported
    const grantDrift = report.items.filter((i) => i.type === 'grant');
    expect(grantDrift.length).toBeGreaterThanOrEqual(1);
  });

  // ─── Composite Primary Keys ─────────────────────────────────────

  it('reports no drift when composite PKs match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'order_items',
        columns: [
          { name: 'order_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
        ],
        primary_key: ['order_id', 'product_id'],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('order_items', {
      table: 'order_items',
      columns: [
        { name: 'order_id', type: 'uuid', primary_key: true },
        { name: 'product_id', type: 'uuid', primary_key: true },
      ],
      primary_key: ['order_id', 'product_id'],
    });
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.filter((i) => i.object.includes('primary_key'));
    expect(pkDrift).toHaveLength(0);
  });

  it('reports drift when composite PK is missing in DB', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'order_items',
        columns: [
          { name: 'order_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
        ],
        primary_key: ['order_id', 'product_id'],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('order_items', {
      table: 'order_items',
      columns: [
        { name: 'order_id', type: 'uuid' },
        { name: 'product_id', type: 'uuid' },
      ],
    });
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.filter((i) => i.object === 'order_items.primary_key');
    expect(pkDrift).toHaveLength(1);
    expect(pkDrift[0].status).toBe('missing_in_db');
  });

  it('reports drift when composite PK columns differ', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'order_items',
        columns: [
          { name: 'order_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
          { name: 'variant_id', type: 'uuid' },
        ],
        primary_key: ['order_id', 'product_id', 'variant_id'],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('order_items', {
      table: 'order_items',
      columns: [
        { name: 'order_id', type: 'uuid', primary_key: true },
        { name: 'product_id', type: 'uuid', primary_key: true },
        { name: 'variant_id', type: 'uuid' },
      ],
      primary_key: ['order_id', 'product_id'],
    });
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.filter((i) => i.object === 'order_items.primary_key');
    expect(pkDrift).toHaveLength(1);
    expect(pkDrift[0].status).toBe('different');
  });

  it('reports drift when composite PK exists in DB but not in YAML', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'order_items',
        columns: [
          { name: 'order_id', type: 'uuid' },
          { name: 'product_id', type: 'uuid' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('order_items', {
      table: 'order_items',
      columns: [
        { name: 'order_id', type: 'uuid', primary_key: true },
        { name: 'product_id', type: 'uuid', primary_key: true },
      ],
      primary_key: ['order_id', 'product_id'],
    });
    const report = detectDrift(desired, actual);
    const pkDrift = report.items.filter((i) => i.object === 'order_items.primary_key');
    expect(pkDrift).toHaveLength(1);
    expect(pkDrift[0].status).toBe('missing_in_yaml');
  });

  // ─── Trigger for_each and when drift (T-042) ──────────────────

  it('reports trigger drift when for_each differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'events',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        triggers: [
          { name: 'trg_notify', timing: 'AFTER', events: ['INSERT'], function: 'notify_event', for_each: 'STATEMENT' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('events', {
      table: 'events',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [
        { name: 'trg_notify', timing: 'AFTER', events: ['INSERT'], function: 'notify_event', for_each: 'ROW' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'events.trg_notify',
        status: 'different',
      }),
    );
  });

  it('reports trigger drift when when clause differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
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
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [{ name: 'trg_audit', timing: 'AFTER', events: ['UPDATE'], function: 'audit_change', for_each: 'ROW' }],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'users.trg_audit',
        status: 'different',
      }),
    );
  });

  it('reports trigger drift when timing differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'orders',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        triggers: [
          { name: 'trg_validate', timing: 'BEFORE', events: ['INSERT'], function: 'validate_order', for_each: 'ROW' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('orders', {
      table: 'orders',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [
        { name: 'trg_validate', timing: 'AFTER', events: ['INSERT'], function: 'validate_order', for_each: 'ROW' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'trigger',
        object: 'orders.trg_validate',
        status: 'different',
      }),
    );
  });

  it('reports no trigger drift when triggers match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        triggers: [
          {
            name: 'trg_audit',
            timing: 'AFTER',
            events: ['UPDATE'],
            function: 'audit_change',
            for_each: 'ROW',
            when: 'OLD.* IS DISTINCT FROM NEW.*',
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      triggers: [
        {
          name: 'trg_audit',
          timing: 'AFTER',
          events: ['UPDATE'],
          function: 'audit_change',
          for_each: 'ROW',
          when: 'OLD.* IS DISTINCT FROM NEW.*',
        },
      ],
    });
    const report = detectDrift(desired, actual);
    const triggerDrift = report.items.filter((i) => i.type === 'trigger');
    expect(triggerDrift).toHaveLength(0);
  });

  // ─── with_grant_option drift ───────────────────────────────────

  it('detects drift when with_grant_option differs between desired and actual', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        grants: [{ to: 'reader', privileges: ['SELECT'], with_grant_option: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      grants: [{ to: 'reader', privileges: ['SELECT'] }],
    });
    const report = detectDrift(desired, actual);
    const grantDrift = report.items.filter((i) => i.type === 'grant');
    expect(grantDrift.length).toBeGreaterThan(0);
    expect(grantDrift).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'grant', status: 'different' })]),
    );
  });

  it('reports no drift when with_grant_option matches', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        grants: [{ to: 'reader', privileges: ['SELECT'], with_grant_option: true }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      grants: [{ to: 'reader', privileges: ['SELECT'], with_grant_option: true }],
    });
    const report = detectDrift(desired, actual);
    const grantDrift = report.items.filter((i) => i.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });

  it('reports different when policy permissive flag differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        policies: [
          {
            name: 'user_select',
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
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      policies: [
        {
          name: 'user_select',
          for: 'SELECT',
          to: 'public',
          permissive: true,
        },
      ],
    });
    const report = detectDrift(desired, actual);
    const policyDrift = report.items.filter((i) => i.type === 'policy');
    expect(policyDrift).toHaveLength(1);
    expect(policyDrift[0].status).toBe('different');
    expect(policyDrift[0].detail).toContain('permissive');
  });

  it('reports no drift when policy permissive flags match', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        policies: [
          {
            name: 'user_select',
            for: 'SELECT',
            to: 'public',
            permissive: true,
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      policies: [
        {
          name: 'user_select',
          for: 'SELECT',
          to: 'public',
          permissive: true,
        },
      ],
    });
    const report = detectDrift(desired, actual);
    const policyDrift = report.items.filter((i) => i.type === 'policy');
    expect(policyDrift).toHaveLength(0);
  });

  it('reports different when policy using clause differs', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        policies: [
          {
            name: 'user_select',
            for: 'SELECT',
            to: 'public',
            using: 'id = 1',
            permissive: true,
          },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      policies: [
        {
          name: 'user_select',
          for: 'SELECT',
          to: 'public',
          using: 'id = 2',
          permissive: true,
        },
      ],
    });
    const report = detectDrift(desired, actual);
    const policyDrift = report.items.filter((i) => i.type === 'policy');
    expect(policyDrift).toHaveLength(1);
    expect(policyDrift[0].status).toBe('different');
    expect(policyDrift[0].detail).toContain('using');
  });

  it('reports no drift when both omit with_grant_option', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'users',
        columns: [{ name: 'id', type: 'integer', primary_key: true }],
        grants: [{ to: 'reader', privileges: ['SELECT'] }],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('users', {
      table: 'users',
      columns: [{ name: 'id', type: 'integer', primary_key: true }],
      grants: [{ to: 'reader', privileges: ['SELECT'] }],
    });
    const report = detectDrift(desired, actual);
    const grantDrift = report.items.filter((i) => i.type === 'grant');
    expect(grantDrift).toHaveLength(0);
  });
  // ─── Seed drift: no false positive when actual seeds match desired ───

  it('reports no seed drift when actual seeds match desired seeds', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('statuses', {
      table: 'statuses',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
      seeds: [
        { id: 1, name: 'active' },
        { id: 2, name: 'inactive' },
      ],
    });
    const report = detectDrift(desired, actual);
    const seedDrift = report.items.filter((i) => i.type === 'seed');
    expect(seedDrift).toHaveLength(0);
  });

  it('reports no seed drift when actual seeds have coerced types (number vs string)', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('statuses', {
      table: 'statuses',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
      // PostgreSQL returns numbers as strings for some column types
      seeds: [
        { id: '1', name: 'active' },
        { id: '2', name: 'inactive' },
      ],
    });
    const report = detectDrift(desired, actual);
    const seedDrift = report.items.filter((i) => i.type === 'seed');
    expect(seedDrift).toHaveLength(0);
  });

  it('reports seed drift when actual seed values genuinely differ', () => {
    const desired = emptyDesired();
    desired.tables = [
      {
        table: 'statuses',
        columns: [
          { name: 'id', type: 'integer', primary_key: true },
          { name: 'name', type: 'text' },
        ],
        seeds: [
          { id: 1, name: 'active' },
          { id: 2, name: 'inactive' },
        ],
      },
    ];
    const actual = emptyActual();
    actual.tables.set('statuses', {
      table: 'statuses',
      columns: [
        { name: 'id', type: 'integer', primary_key: true },
        { name: 'name', type: 'text' },
      ],
      seeds: [
        { id: 1, name: 'active' },
        { id: 2, name: 'WRONG' },
      ],
    });
    const report = detectDrift(desired, actual);
    expect(report.items).toContainEqual(
      expect.objectContaining({
        type: 'seed',
        object: 'statuses',
        status: 'different',
      }),
    );
  });
});

// ─── drift --apply integration tests ──────────────────────────

const DATABASE_URL = process.env.DATABASE_URL!;
const logger = createLogger({ verbose: false, quiet: true, json: false });

afterAll(async () => {
  await closePool();
});

describe('drift --apply integration', () => {
  it('should fix drift by applying missing column', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Step 1: Create initial table via migration
      writeSchema(project.dir, {
        'tables/users.yaml': `table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
`,
      });
      await project.migrate();

      // Step 2: Add a new column to YAML (creates drift)
      writeSchema(project.dir, {
        'tables/users.yaml': `table: users
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
  - name: email
    type: text
`,
      });

      // Verify drift exists
      const report1 = await project.drift();
      expect(report1.items.length).toBeGreaterThan(0);
      expect(report1.items).toContainEqual(
        expect.objectContaining({ type: 'column', object: 'users.email', status: 'missing_in_db' }),
      );

      // Step 3: Apply drift fix
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });
      expect(plan.operations.length).toBeGreaterThan(0);
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // Step 4: Verify table/column drift is resolved
      const report2 = await project.drift();
      const tableDrift = report2.items.filter((i) => i.type === 'table' || i.type === 'column');
      expect(tableDrift).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('should block destructive drift fixes without --allow-destructive', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Step 1: Create table with extra column via migration
      writeSchema(project.dir, {
        'tables/items.yaml': `table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: title
    type: text
    nullable: false
  - name: description
    type: text
`,
      });
      await project.migrate();

      // Step 2: Remove the description column from YAML (DB has extra column)
      writeSchema(project.dir, {
        'tables/items.yaml': `table: items
columns:
  - name: id
    type: integer
    primary_key: true
  - name: title
    type: text
    nullable: false
`,
      });

      // Verify drift detected
      const report1 = await project.drift();
      expect(report1.items).toContainEqual(
        expect.objectContaining({ type: 'column', object: 'items.description', status: 'missing_in_yaml' }),
      );

      // Step 3: Plan without allowDestructive — drop_column should be blocked
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });

      expect(plan.blocked.length).toBeGreaterThan(0);
      expect(plan.blocked).toContainEqual(expect.objectContaining({ type: 'drop_column' }));

      // Step 4: Plan with allowDestructive — drop_column should be in operations
      const planDestructive = buildPlan(desired, actual, {
        allowDestructive: true,
        pgSchema: project.config.pgSchema,
      });
      expect(planDestructive.blocked).toHaveLength(0);
      expect(planDestructive.operations).toContainEqual(expect.objectContaining({ type: 'drop_column' }));

      // Step 5: Execute only the drop_column operation
      const dropOps = planDestructive.operations.filter((op) => op.type === 'drop_column');
      expect(dropOps.length).toBeGreaterThan(0);
      await execute({
        connectionString: project.config.connectionString,
        operations: dropOps,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // Step 6: The description column should be gone
      const report2 = await project.drift();
      const descriptionDrift = report2.items.filter((i) => i.object === 'items.description');
      expect(descriptionDrift).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('should fix drift for missing table entirely', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      // Write a table YAML without migrating — DB is empty, YAML defines table
      writeSchema(project.dir, {
        'tables/products.yaml': `table: products
columns:
  - name: id
    type: integer
    primary_key: true
  - name: name
    type: text
    nullable: false
  - name: price
    type: numeric
`,
      });

      // Drift: table missing in DB
      const report1 = await project.drift();
      expect(report1.items).toContainEqual(
        expect.objectContaining({ type: 'table', object: 'products', status: 'missing_in_db' }),
      );

      // Apply fix
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // Table drift should be resolved — table exists now
      const report2 = await project.drift();
      const tableMissing = report2.items.filter(
        (i) => i.type === 'table' && i.object === 'products' && i.status === 'missing_in_db',
      );
      expect(tableMissing).toHaveLength(0);
      // All columns should exist
      const colMissing = report2.items.filter(
        (i) => i.type === 'column' && i.object.startsWith('products.') && i.status === 'missing_in_db',
      );
      expect(colMissing).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  // ─── drift --apply ────────────────────────────────────────────

  it('drift --apply fixes missing column drift and re-drift shows no differences', async () => {
    const connStr = process.env.DATABASE_URL!;
    const project = await useTestProject(connStr);
    try {
      // 1. Write table YAML with two columns
      writeSchema(project.dir, {
        'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: title
    type: text
    nullable: false
  - name: description
    type: text
`,
      });

      // 2. Migrate to create table
      await project.migrate();

      // 3. Add a third column to YAML (simulating a new desired column)
      writeSchema(project.dir, {
        'tables/items.yaml': `
table: items
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: title
    type: text
    nullable: false
  - name: description
    type: text
  - name: price
    type: integer
`,
      });

      // 4. Detect drift — should show price missing in DB
      const report1 = await project.drift();
      const priceMissing = report1.items.find(
        (i) => i.type === 'column' && i.object === 'items.price' && i.status === 'missing_in_db',
      );
      expect(priceMissing).toBeDefined();

      // 5. Apply fix: build plan + execute (same as drift --apply)
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });
      expect(plan.operations.length).toBeGreaterThan(0);
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // 6. Re-detect drift — should be clean
      const report2 = await project.drift();
      const remaining = report2.items.filter((i) => i.type === 'column' && i.object === 'items.price');
      expect(remaining).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('drift --apply blocks destructive operations without --allow-destructive', async () => {
    const connStr = process.env.DATABASE_URL!;
    const project = await useTestProject(connStr);
    try {
      // 1. Write table YAML and migrate
      writeSchema(project.dir, {
        'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: amount
    type: integer
  - name: legacy_field
    type: text
`,
      });
      await project.migrate();

      // 2. Remove the legacy_field column from YAML (simulating desired drop)
      writeSchema(project.dir, {
        'tables/orders.yaml': `
table: orders
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: amount
    type: integer
`,
      });

      // 3. Detect drift — legacy_field missing in YAML
      const report1 = await project.drift();
      const extraCol = report1.items.find(
        (i) => i.type === 'column' && i.object === 'orders.legacy_field' && i.status === 'missing_in_yaml',
      );
      expect(extraCol).toBeDefined();

      // 4. Plan without --allow-destructive — drop_column should be blocked
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });
      const blockedDropCol = plan.blocked.find(
        (op) => op.type === 'drop_column' && op.objectName.includes('legacy_field'),
      );
      expect(blockedDropCol).toBeDefined();

      // 5. With --allow-destructive, the drop should be in operations
      const planDestructive = buildPlan(desired, actual, {
        allowDestructive: true,
        pgSchema: project.config.pgSchema,
      });
      const dropOp = planDestructive.operations.find(
        (op) => op.type === 'drop_column' && op.objectName.includes('legacy_field'),
      );
      expect(dropOp).toBeDefined();

      // 6. Execute with allow-destructive and verify drift resolved
      await execute({
        connectionString: project.config.connectionString,
        operations: planDestructive.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      const report2 = await project.drift();
      const remainingDrift = report2.items.filter((i) => i.object.includes('legacy_field'));
      expect(remainingDrift).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('drift --apply fixes missing index drift', async () => {
    const connStr = process.env.DATABASE_URL!;
    const project = await useTestProject(connStr);
    try {
      // 1. Create table without index
      writeSchema(project.dir, {
        'tables/products.yaml': `
table: products
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
  - name: sku
    type: text
`,
      });
      await project.migrate();

      // 2. Add an index to YAML
      writeSchema(project.dir, {
        'tables/products.yaml': `
table: products
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
  - name: sku
    type: text
indexes:
  - name: idx_products_sku
    columns: [sku]
`,
      });

      // 3. Detect drift — index missing in DB
      const report1 = await project.drift();
      const idxMissing = report1.items.find(
        (i) => i.type === 'index' && i.object === 'idx_products_sku' && i.status === 'missing_in_db',
      );
      expect(idxMissing).toBeDefined();

      // 4. Apply fix
      const { desired, actual } = await buildDesiredAndActual(project.config, logger);
      const plan = buildPlan(desired, actual, {
        allowDestructive: false,
        pgSchema: project.config.pgSchema,
      });
      expect(plan.operations.length).toBeGreaterThan(0);
      await execute({
        connectionString: project.config.connectionString,
        operations: plan.operations,
        pgSchema: project.config.pgSchema,
        logger,
      });

      // 5. Re-detect drift — index should exist now
      const report2 = await project.drift();
      const idxRemaining = report2.items.filter((i) => i.type === 'index' && i.object === 'idx_products_sku');
      expect(idxRemaining).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('should report zero seed drift after run on fresh database', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/statuses.yaml': `
table: statuses
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: name
    type: text
    nullable: false
seeds:
  - id: 1
    name: active
  - id: 2
    name: inactive
  - id: 3
    name: archived
`,
      });

      // Run migration (creates table + inserts seeds)
      await project.migrate();

      // Drift should report zero seed differences
      const report = await project.drift();
      const seedDrift = report.items.filter((i) => i.type === 'seed');
      expect(seedDrift).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });

  it('should report zero seed drift with boolean and numeric type coercion', async () => {
    const project = await useTestProject(DATABASE_URL);
    try {
      writeSchema(project.dir, {
        'tables/settings.yaml': `
table: settings
columns:
  - name: id
    type: integer
    primary_key: true
    nullable: false
  - name: key
    type: text
    nullable: false
  - name: enabled
    type: boolean
    default: "true"
  - name: priority
    type: bigint
seeds:
  - id: 1
    key: feature_flags
    enabled: true
    priority: 100
  - id: 2
    key: maintenance
    enabled: false
    priority: 50
`,
      });

      await project.migrate();

      const report = await project.drift();
      const seedDrift = report.items.filter((i) => i.type === 'seed');
      expect(seedDrift).toHaveLength(0);
    } finally {
      await project.cleanup();
    }
  });
});
