/**
 * ERD generation for simplicity-schema.
 *
 * Generates Mermaid ER diagrams from YAML table definitions.
 */

import type { TableSchema, ColumnDef } from '../schema/types.js';

/**
 * Generate a Mermaid ER diagram string from parsed table schemas.
 */
export function generateErd(tables: TableSchema[]): string {
  const lines: string[] = ['erDiagram'];

  for (const table of tables) {
    lines.push(`  ${table.table} {`);
    for (const col of table.columns) {
      lines.push(`    ${formatColumn(col, table)}`);
    }
    lines.push('  }');
  }

  // Collect FK relationships
  for (const table of tables) {
    for (const col of table.columns) {
      if (col.references) {
        const rel = formatRelationship(table.table, col);
        lines.push(`  ${rel}`);
      }
    }
  }

  return lines.join('\n') + '\n';
}

function formatColumn(col: ColumnDef, table: TableSchema): string {
  const parts = [col.type, col.name];

  // Determine PK status
  const isPk = col.primary_key || (table.primary_key && table.primary_key.includes(col.name));
  const isFk = !!col.references;

  if (isPk) parts.push('PK');
  if (isFk) parts.push('FK');

  if (col.comment) {
    parts.push(`"${col.comment}"`);
  }

  return parts.join(' ');
}

function formatRelationship(tableName: string, col: ColumnDef): string {
  const ref = col.references!;
  const isNullable = col.nullable === true;
  const isUnique = col.unique === true;

  // Parent side: ||  (exactly one) or |o (zero or one, if child FK is nullable)
  // Child side:  || (exactly one, if unique) or o{ (zero or more)
  let parentSide: string;
  let childSide: string;

  if (isNullable) {
    parentSide = '|o';
  } else {
    parentSide = '||';
  }

  if (isUnique) {
    childSide = '||';
  } else {
    childSide = 'o{';
  }

  return `${ref.table} ${parentSide}--${childSide} ${tableName} : "${col.name}"`;
}
