import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLANNER = path.resolve(here, '../planner/index.ts');
const DOC = path.resolve(here, '../../docs-site/src/content/docs/safety/destructive-protection.md');

/**
 * Every operation type the planner can mark destructive: each `destructive:`
 * whose value isn't the literal `false`, paired with the type name(s) in the
 * nearest preceding `type:` of the same operation literal. A ternary type
 * (`isColumnGrant ? 'revoke_column' : 'revoke_table'`) yields both names.
 */
function destructiveTypesInPlanner(source: string): Set<string> {
  const types = new Set<string>();
  for (const m of source.matchAll(/destructive:\s*([^,\n}]+)/g)) {
    const value = m[1].trim();
    if (value === 'false' || value.startsWith('boolean')) continue;
    const before = source.slice(0, m.index);
    const typeLine = before.slice(before.lastIndexOf('type:')).split('\n')[0];
    for (const t of typeLine.matchAll(/'([a-z_]+)'/g)) types.add(t[1]);
  }
  return types;
}

/** The `code` op names on the "Blocked operations" list's bullets. */
function documentedTypes(markdown: string): Set<string> {
  const start = markdown.indexOf('## Blocked operations');
  expect(start, 'destructive-protection.md must have a "## Blocked operations" section').toBeGreaterThanOrEqual(0);
  const section = markdown.slice(start).split('\n## ')[0];
  const types = new Set<string>();
  for (const line of section.split('\n')) {
    if (!line.startsWith('- ')) continue;
    for (const t of line.matchAll(/`([a-z_]+)`/g)) types.add(t[1]);
  }
  return types;
}

describe('docs / planner destructive-operation sync (#84)', () => {
  // alter_column is destructive only for some changes, documented in prose:
  // a lossy type change, and dropping NOT NULL when a column leaves the
  // primary key (covered by replace_primary_key / drop_primary_key).
  const PROSE = new Set(['alter_column']);

  it('lists every operation the planner can block (and nothing it never blocks)', () => {
    const planned = destructiveTypesInPlanner(fs.readFileSync(PLANNER, 'utf-8'));
    // Guard the scan itself: if the planner's shape changes so the scan finds
    // almost nothing, fail here rather than pass vacuously.
    expect(planned.size, 'scan of planner/index.ts found too few destructive types').toBeGreaterThan(15);

    const documented = documentedTypes(fs.readFileSync(DOC, 'utf-8'));
    const missing = [...planned].filter((t) => !PROSE.has(t) && !documented.has(t)).sort();
    const invented = [...documented].filter((t) => !planned.has(t)).sort();
    expect(missing, `blocked by the planner but not documented: ${missing.join(', ')}`).toEqual([]);
    expect(invented, `documented as blocked but never blocked: ${invented.join(', ')}`).toEqual([]);
  });
});
