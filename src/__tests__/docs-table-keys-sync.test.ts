import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TABLE_KEYS, COLUMN_KEYS } from '../schema/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const TABLES_DOC = path.resolve(here, '../../docs-site/src/content/docs/schema/tables.md');

/**
 * Pull the keys (first-column `code` cells) out of a markdown reference table
 * between two headings — e.g. the "Table-level keys" or "Columns" sections.
 */
function keysInSection(markdown: string, startMarker: string, endMarker: string): string[] {
  const start = markdown.indexOf(startMarker);
  expect(start, `tables.md must have a "${startMarker}" section`).toBeGreaterThanOrEqual(0);
  const after = markdown.slice(start + startMarker.length);
  const end = after.indexOf(endMarker);
  const section = end >= 0 ? after.slice(0, end) : after;

  const keys: string[] = [];
  for (const line of section.split('\n')) {
    // A table row whose first cell is a `code` token, e.g. `| \`table\` | … |`
    const m = line.match(/^\|\s*`([a-z_]+)`/);
    if (m) keys.push(m[1]);
  }
  return keys;
}

function assertSync(documented: string[], accepted: readonly string[], exceptions: Set<string>, label: string): void {
  const docSet = new Set(documented);
  const expected = accepted.filter((k) => !exceptions.has(k));

  const missingFromDocs = expected.filter((k) => !docSet.has(k));
  expect(
    missingFromDocs,
    `${label}: accepted by the parser but missing from the docs table: ${missingFromDocs.join(', ')}`,
  ).toEqual([]);

  const valid = new Set<string>(accepted);
  const invented = documented.filter((k) => !valid.has(k));
  expect(invented, `${label}: documented but not accepted by the parser: ${invented.join(', ')}`).toEqual([]);
}

describe('docs / parser key sync', () => {
  // unique_constraints — removed in 0.8.0; the parser keeps it only to throw a
  //                      helpful "moved to indexes:" error, so it isn't usable.
  // description        — an alias for `comment`; documented inline on its row.
  it('documents every accepted table-level key (and nothing invented)', () => {
    const markdown = fs.readFileSync(TABLES_DOC, 'utf-8');
    const documented = keysInSection(markdown, '## Table-level keys', '## Columns');
    assertSync(documented, TABLE_KEYS, new Set(['unique_constraints', 'description']), 'TABLE_KEYS');
  });

  it('documents every accepted column-level key (and nothing invented)', () => {
    const markdown = fs.readFileSync(TABLES_DOC, 'utf-8');
    // The "Columns" section holds the Required + Optional field tables; stop
    // before "### Column types", whose rows list PostgreSQL types, not keys.
    const documented = keysInSection(markdown, '## Columns', '### Column types');
    assertSync(documented, COLUMN_KEYS, new Set(['description']), 'COLUMN_KEYS');
  });
});
