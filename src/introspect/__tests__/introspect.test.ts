import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import pg from 'pg';
import {
  getExistingTables,
  getExistingEnums,
  getExistingFunctions,
  getExistingViews,
  getExistingMaterializedViews,
  getExistingRoles,
  introspectTable,
} from '../index.js';

const TEST_URL = process.env.DATABASE_URL!;
const TEST_SCHEMA = `test_introspect_${Date.now()}`;

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: TEST_URL });
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
});

afterAll(async () => {
  await client.query(`DROP SCHEMA ${TEST_SCHEMA} CASCADE`);
  client.release();
  await pool.end();
});

// Helper to run SQL in the test schema
async function exec(sql: string) {
  await client.query(`SET search_path TO ${TEST_SCHEMA}`);
  await client.query(sql);
  await client.query(`SET search_path TO public`);
}

describe('getExistingTables', () => {
  beforeAll(async () => {
    await exec(`CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      name text
    )`);
    await exec(`CREATE TABLE orders (
      id uuid PRIMARY KEY,
      user_id uuid,
      total numeric
    )`);
  });

  it('returns all table names in the schema', async () => {
    const tables = await getExistingTables(client, TEST_SCHEMA);
    expect(tables).toContain('users');
    expect(tables).toContain('orders');
  });

  it('does not return tables from other schemas', async () => {
    const tables = await getExistingTables(client, TEST_SCHEMA);
    // pg_catalog tables should not appear
    expect(tables).not.toContain('pg_class');
  });
});

describe('getExistingEnums', () => {
  beforeAll(async () => {
    await exec(`CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'delivered')`);
    await exec(`CREATE TYPE priority AS ENUM ('low', 'medium', 'high')`);
  });

  it('returns all enums with their values', async () => {
    const enums = await getExistingEnums(client, TEST_SCHEMA);
    expect(enums).toHaveLength(2);

    const status = enums.find((e) => e.name === 'order_status');
    expect(status).toBeDefined();
    expect(status!.values).toEqual(['pending', 'shipped', 'delivered']);

    const prio = enums.find((e) => e.name === 'priority');
    expect(prio).toBeDefined();
    expect(prio!.values).toEqual(['low', 'medium', 'high']);
  });
});

describe('getExistingFunctions', () => {
  beforeAll(async () => {
    await exec(`
      CREATE FUNCTION update_timestamp() RETURNS trigger
      LANGUAGE plpgsql
      SECURITY INVOKER
      AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
      $$
    `);
    await exec(`
      CREATE FUNCTION add_numbers(a integer, b integer) RETURNS integer
      LANGUAGE sql
      IMMUTABLE
      AS $$ SELECT a + b $$
    `);
  });

  it('returns all functions in the schema', async () => {
    const fns = await getExistingFunctions(client, TEST_SCHEMA);
    expect(fns.length).toBeGreaterThanOrEqual(2);

    const trigger = fns.find((f) => f.name === 'update_timestamp');
    expect(trigger).toBeDefined();
    expect(trigger!.language).toBe('plpgsql');
    expect(trigger!.returns).toBe('trigger');
    expect(trigger!.security).toBe('invoker');

    const add = fns.find((f) => f.name === 'add_numbers');
    expect(add).toBeDefined();
    expect(add!.language).toBe('sql');
    expect(add!.returns).toBe('integer');
    expect(add!.volatility).toBe('immutable');
    expect(add!.args).toHaveLength(2);
    expect(add!.args![0]).toMatchObject({ name: 'a', type: 'integer' });
    expect(add!.args![1]).toMatchObject({ name: 'b', type: 'integer' });
  });
});

describe('getExistingViews', () => {
  beforeAll(async () => {
    await exec(`CREATE VIEW active_users AS SELECT id, email FROM users WHERE name IS NOT NULL`);
  });

  it('returns all views in the schema', async () => {
    const views = await getExistingViews(client, TEST_SCHEMA);
    expect(views.length).toBeGreaterThanOrEqual(1);

    const v = views.find((v) => v.name === 'active_users');
    expect(v).toBeDefined();
    expect(v!.query).toBeTruthy();
  });
});

describe('getExistingMaterializedViews', () => {
  beforeAll(async () => {
    await exec(`CREATE MATERIALIZED VIEW user_counts AS SELECT count(*) AS cnt FROM users`);
    await exec(`CREATE UNIQUE INDEX ON ${TEST_SCHEMA}.user_counts (cnt)`);
  });

  it('returns all materialized views in the schema', async () => {
    const mvs = await getExistingMaterializedViews(client, TEST_SCHEMA);
    expect(mvs.length).toBeGreaterThanOrEqual(1);

    const mv = mvs.find((m) => m.name === 'user_counts');
    expect(mv).toBeDefined();
    expect(mv!.query).toBeTruthy();
  });
});

describe('introspectTable', () => {
  beforeAll(async () => {
    await exec(`
      CREATE TABLE products (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        price numeric DEFAULT 0,
        status ${TEST_SCHEMA}.order_status DEFAULT 'pending',
        created_at timestamptz NOT NULL DEFAULT now(),
        notes text
      )
    `);
    await exec(`CREATE INDEX idx_products_name ON products (name)`);
    await exec(`CREATE UNIQUE INDEX idx_products_name_price ON products (name, price)`);
    await exec(`ALTER TABLE products ADD CONSTRAINT chk_price CHECK (price >= 0)`);
    await exec(`COMMENT ON TABLE products IS 'Product catalog'`);
    await exec(`COMMENT ON COLUMN products.name IS 'Product display name'`);
    // Add a foreign key from orders to users
    await exec(`ALTER TABLE orders ADD CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL`);
    // Add a trigger
    await exec(`
      CREATE TRIGGER set_products_updated_at
      BEFORE UPDATE ON products
      FOR EACH ROW
      EXECUTE FUNCTION update_timestamp()
    `);
    // Enable RLS and add a policy
    await exec(`ALTER TABLE products ENABLE ROW LEVEL SECURITY`);
    await exec(`
      CREATE POLICY products_select ON products
      FOR SELECT
      USING (true)
    `);
  });

  it('returns columns with types, nullability, and defaults', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.table).toBe('products');

    const idCol = table.columns.find((c) => c.name === 'id');
    expect(idCol).toBeDefined();
    expect(idCol!.type).toBe('uuid');
    expect(idCol!.nullable).toBe(false);
    expect(idCol!.default).toContain('gen_random_uuid');

    const priceCol = table.columns.find((c) => c.name === 'price');
    expect(priceCol).toBeDefined();
    expect(priceCol!.type).toBe('numeric');
    expect(priceCol!.nullable).toBe(true);

    const notesCol = table.columns.find((c) => c.name === 'notes');
    expect(notesCol).toBeDefined();
    expect(notesCol!.nullable).toBe(true);

    const createdCol = table.columns.find((c) => c.name === 'created_at');
    expect(createdCol).toBeDefined();
    expect(createdCol!.type).toMatch(/timestamptz|timestamp with time zone/);
    expect(createdCol!.nullable).toBe(false);
  });

  it('returns primary key columns', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    // id has primary_key or primary_key array is set
    const idCol = table.columns.find((c) => c.name === 'id');
    expect(idCol!.primary_key).toBe(true);
  });

  it('returns indexes', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.indexes).toBeDefined();
    expect(table.indexes!.length).toBeGreaterThanOrEqual(2);

    const nameIdx = table.indexes!.find((i) => i.columns.includes('name') && i.columns.length === 1);
    expect(nameIdx).toBeDefined();
    expect(nameIdx!.unique).toBe(false);

    const compositeIdx = table.indexes!.find((i) => i.columns.includes('name') && i.columns.includes('price'));
    expect(compositeIdx).toBeDefined();
    expect(compositeIdx!.unique).toBe(true);
  });

  it('returns check constraints', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.checks).toBeDefined();
    const chk = table.checks!.find((c) => c.name === 'chk_price');
    expect(chk).toBeDefined();
    expect(chk!.expression).toContain('price');
  });

  it('returns foreign keys on referenced table', async () => {
    const table = await introspectTable(client, 'orders', TEST_SCHEMA);
    const fkCol = table.columns.find((c) => c.name === 'user_id');
    expect(fkCol).toBeDefined();
    expect(fkCol!.references).toBeDefined();
    expect(fkCol!.references!.table).toBe('users');
    expect(fkCol!.references!.column).toBe('id');
    expect(fkCol!.references!.on_delete).toBe('SET NULL');
  });

  it('returns triggers', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.triggers).toBeDefined();
    const trigger = table.triggers!.find((t) => t.name === 'set_products_updated_at');
    expect(trigger).toBeDefined();
    expect(trigger!.timing).toBe('BEFORE');
    expect(trigger!.events).toContain('UPDATE');
    expect(trigger!.function).toBe('update_timestamp');
    expect(trigger!.for_each).toBe('ROW');
  });

  it('returns RLS policies', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.policies).toBeDefined();
    const pol = table.policies!.find((p) => p.name === 'products_select');
    expect(pol).toBeDefined();
    expect(pol!.for).toBe('SELECT');
    expect(pol!.using).toBeTruthy();
  });

  it('returns table comment', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    expect(table.comment).toBe('Product catalog');
  });

  it('returns column comments', async () => {
    const table = await introspectTable(client, 'products', TEST_SCHEMA);
    const nameCol = table.columns.find((c) => c.name === 'name');
    expect(nameCol!.comment).toBe('Product display name');
  });
});

describe('getExistingRoles', () => {
  const testRole = `test_role_${Date.now()}`;

  beforeAll(async () => {
    await client.query(`CREATE ROLE ${testRole} NOLOGIN`);
  });

  afterAll(async () => {
    await client.query(`DROP ROLE IF EXISTS ${testRole}`);
  });

  it('returns roles', async () => {
    const roles = await getExistingRoles(client);
    const role = roles.find((r) => r.role === testRole);
    expect(role).toBeDefined();
    expect(role!.login).toBe(false);
  });
});

describe('generated columns', () => {
  beforeAll(async () => {
    await exec(`CREATE TABLE gen_test (
      id serial PRIMARY KEY,
      price numeric NOT NULL,
      quantity integer NOT NULL,
      total numeric GENERATED ALWAYS AS (price * quantity) STORED
    )`);
  });

  it('introspects generated column expression', async () => {
    const table = await introspectTable(client, 'gen_test', TEST_SCHEMA);
    const totalCol = table.columns.find((c) => c.name === 'total');
    expect(totalCol).toBeDefined();
    expect(totalCol!.generated).toBeDefined();
    expect(totalCol!.generated).toContain('price');
    expect(totalCol!.generated).toContain('quantity');
  });

  it('non-generated columns have no generated field', async () => {
    const table = await introspectTable(client, 'gen_test', TEST_SCHEMA);
    const priceCol = table.columns.find((c) => c.name === 'price');
    expect(priceCol).toBeDefined();
    expect(priceCol!.generated).toBeUndefined();
  });
});

describe('column-level grants introspection', () => {
  const roleName = `col_grant_introspect_${Date.now()}`;

  beforeAll(async () => {
    await exec(`CREATE TABLE grant_test (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email text NOT NULL,
      secret text
    )`);
    await client.query(`CREATE ROLE "${roleName}"`);
    await client.query(
      `GRANT SELECT ("id", "email") ON "${TEST_SCHEMA}"."grant_test" TO "${roleName}"`,
    );
  });

  afterAll(async () => {
    await client.query(`REVOKE ALL ON "${TEST_SCHEMA}"."grant_test" FROM "${roleName}"`).catch(() => {});
    await client.query(`DROP ROLE IF EXISTS "${roleName}"`);
  });

  it('introspects column-level grants', async () => {
    const table = await introspectTable(client, 'grant_test', TEST_SCHEMA);
    expect(table.grants).toBeDefined();
    expect(table.grants!.length).toBeGreaterThanOrEqual(1);
    const grant = table.grants!.find((g) => g.to === roleName);
    expect(grant).toBeDefined();
    expect(grant!.privileges).toContain('SELECT');
    expect(grant!.columns).toBeDefined();
    expect(grant!.columns!.sort()).toEqual(['email', 'id']);
  });

  it('does not include column grants in table grants for non-granted columns', async () => {
    const table = await introspectTable(client, 'grant_test', TEST_SCHEMA);
    const grant = table.grants!.find((g) => g.to === roleName);
    expect(grant).toBeDefined();
    // "secret" column should not be in the grant
    expect(grant!.columns).not.toContain('secret');
  });
});
