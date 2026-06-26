import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_KEYS } from '../schema/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLES_DOC = path.resolve(here, '../../docs-site/src/content/docs/schema/tables.md');

// Keys in TABLE_KEYS that are intentionally NOT given their own row in the
// docs "Table-level keys" table, with the reason:
//   unique_constraints — removed in 0.8.0; the parser keeps it only to throw a
//                        helpful "moved to indexes:" error, so it isn't a usable key.
//   description        — an alias for `comment`; documented inline on the comment row.
const UNDOCUMENTED_BY_DESIGN = new Set(['unique_constraints', 'description']);

/** Pull the keys (first-column `code` cells) out of the "## Table-level keys" table. */
function documentedTableKeys(markdown: string): string[] {
  const start = markdown.indexOf('## Table-level keys');
  expect(start, 'tables.md must have a "## Table-level keys" section').toBeGreaterThanOrEqual(0);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## '); // next h2
  const section = end >= 0 ? rest.slice(0, end) : rest;

  const keys: string[] = [];
  for (const line of section.split('\n')) {
    // A table row whose first cell is a `code` token, e.g. `| \`table\` | ... |`
    const m = line.match(/^\|\s*`([a-z_]+)`/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

describe('docs / TABLE_KEYS sync', () => {
  it('documents every accepted table-level key (and nothing invented)', () => {
    const markdown = fs.readFileSync(TABLES_DOC, 'utf-8');
    const documented = new Set(documentedTableKeys(markdown));

    const expected = new Set(TABLE_KEYS.filter((k) => !UNDOCUMENTED_BY_DESIGN.has(k)));

    // Every parser-accepted key must be documented...
    const missingFromDocs = [...expected].filter((k) => !documented.has(k));
    expect(
      missingFromDocs,
      `keys in TABLE_KEYS but missing from the docs table: ${missingFromDocs.join(', ')}`,
    ).toEqual([]);

    // ...and the docs must not list keys the parser doesn't accept.
    const validKeys = new Set<string>(TABLE_KEYS);
    const invented = [...documented].filter((k) => !validKeys.has(k));
    expect(invented, `keys documented but not accepted by the parser: ${invented.join(', ')}`).toEqual([]);
  });
});
