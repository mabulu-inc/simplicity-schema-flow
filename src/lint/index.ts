/**
 * Lint — static analysis rules on migration plans.
 *
 * Analyzes a PlanResult for dangerous patterns and produces warnings.
 */

import type { PlanResult } from '../planner/index.js';

// ─── Types ──────────────────────────────────────────────────────

export type LintSeverity = 'warning' | 'info';

export interface LintWarning {
  rule: string;
  severity: LintSeverity;
  objectName: string;
  message: string;
  sql: string;
}

export interface LintResult {
  warnings: LintWarning[];
  summary: {
    total: number;
    bySeverity: Record<LintSeverity, number>;
  };
}

// ─── Volatile defaults ──────────────────────────────────────────

const VOLATILE_DEFAULTS = [
  /\bnow\s*\(/i,
  /\bcurrent_timestamp\b/i,
  /\bcurrent_date\b/i,
  /\bcurrent_time\b/i,
  /\brandom\s*\(/i,
  /\bgen_random_uuid\s*\(/i,
  /\buuid_generate_v[14]\s*\(/i,
  /\bclock_timestamp\s*\(/i,
  /\bstatement_timestamp\s*\(/i,
  /\btimeofday\s*\(/i,
];

function hasVolatileDefault(sql: string): boolean {
  // Extract the DEFAULT clause
  const match = sql.match(/DEFAULT\s+(.+?)$/i);
  if (!match) return false;
  const defaultExpr = match[1];
  return VOLATILE_DEFAULTS.some((re) => re.test(defaultExpr));
}

// ─── Narrowing types ────────────────────────────────────────────

const NARROWING_PATTERNS = [
  /\bvarchar\s*\(\d+\)/i, // varchar(N) is narrower than text
];

function isTypeNarrowing(sql: string): boolean {
  const typeMatch = sql.match(/TYPE\s+(.+?)$/i);
  if (!typeMatch) return false;
  const newType = typeMatch[1].trim();
  return NARROWING_PATTERNS.some((re) => re.test(newType));
}

// ─── FK column extraction ───────────────────────────────────────

function extractFkColumn(sql: string): string | null {
  const match = sql.match(/FOREIGN\s+KEY\s*\((\w+)\)/i);
  return match ? match[1] : null;
}

function indexCoversColumn(sql: string, column: string): boolean {
  // Match column in index definition, e.g., ON table (column) or ON table (column, ...)
  const match = sql.match(/\(\s*([^)]+)\s*\)/);
  if (!match) return false;
  const cols = match[1].split(',').map((c) => c.trim().split(/\s+/)[0]);
  return cols[0]?.toLowerCase() === column.toLowerCase();
}

// ─── Column name extraction ─────────────────────────────────────

function extractDroppedColumn(sql: string): string | null {
  const match = sql.match(/DROP\s+COLUMN\s+(?:IF\s+EXISTS\s+)?(\w+)/i);
  return match ? match[1] : null;
}

function extractAddedColumn(sql: string): string | null {
  const match = sql.match(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)/i);
  return match ? match[1] : null;
}

// ─── Main lintPlan ──────────────────────────────────────────────

export function lintPlan(plan: PlanResult): LintResult {
  const warnings: LintWarning[] = [];
  const allOps = [...plan.operations, ...plan.blocked];

  for (const op of allOps) {
    // drop-table
    if (op.type === 'drop_table') {
      warnings.push({
        rule: 'drop-table',
        severity: 'warning',
        objectName: op.objectName,
        message: `Dropping table "${op.objectName}" causes irreversible data loss`,
        sql: op.sql,
      });
    }

    // drop-column
    if (op.type === 'drop_column') {
      warnings.push({
        rule: 'drop-column',
        severity: 'warning',
        objectName: op.objectName,
        message: `Dropping column on "${op.objectName}" causes data loss`,
        sql: op.sql,
      });
    }

    // set-not-null-direct
    if (op.type === 'alter_column' && /SET\s+NOT\s+NULL/i.test(op.sql)) {
      // Check if there's a corresponding CHECK constraint in the plan for the same table
      const hasCheck = allOps.some(
        (o) =>
          (o.type === 'add_check' || o.type === 'add_check_not_valid') &&
          o.objectName === op.objectName &&
          /IS\s+NOT\s+NULL/i.test(o.sql),
      );
      if (!hasCheck) {
        warnings.push({
          rule: 'set-not-null-direct',
          severity: 'warning',
          objectName: op.objectName,
          message: `Direct SET NOT NULL on "${op.objectName}" without safe CHECK constraint pattern; may cause long lock`,
          sql: op.sql,
        });
      }
    }

    // add-column-with-default (volatile)
    if (op.type === 'add_column' && hasVolatileDefault(op.sql)) {
      warnings.push({
        rule: 'add-column-with-default',
        severity: 'warning',
        objectName: op.objectName,
        message: `Adding column with volatile default on "${op.objectName}" may lock table on older PostgreSQL versions`,
        sql: op.sql,
      });
    }

    // type-change and type-narrowing
    if (op.type === 'alter_column' && /\bTYPE\s+/i.test(op.sql)) {
      warnings.push({
        rule: 'type-change',
        severity: 'warning',
        objectName: op.objectName,
        message: `Changing column type on "${op.objectName}" may require a full table rewrite`,
        sql: op.sql,
      });

      if (isTypeNarrowing(op.sql)) {
        warnings.push({
          rule: 'type-narrowing',
          severity: 'warning',
          objectName: op.objectName,
          message: `Narrowing column type on "${op.objectName}" may cause data loss`,
          sql: op.sql,
        });
      }
    }

    // missing-fk-index
    if (op.type === 'add_foreign_key_not_valid' || op.type === 'add_foreign_key') {
      const fkCol = extractFkColumn(op.sql);
      if (fkCol) {
        const hasIndex = allOps.some(
          (o) => o.type === 'add_index' && o.objectName === op.objectName && indexCoversColumn(o.sql, fkCol),
        );
        if (!hasIndex) {
          warnings.push({
            rule: 'missing-fk-index',
            severity: 'info',
            objectName: op.objectName,
            message: `Foreign key column "${fkCol}" on "${op.objectName}" has no index; may cause slow joins/cascades`,
            sql: op.sql,
          });
        }
      }
    }
  }

  // rename-detection: drop_column + add_column on same table
  const drops = allOps.filter((o) => o.type === 'drop_column');
  const adds = allOps.filter((o) => o.type === 'add_column');
  for (const drop of drops) {
    for (const add of adds) {
      if (drop.objectName === add.objectName) {
        const droppedCol = extractDroppedColumn(drop.sql);
        const addedCol = extractAddedColumn(add.sql);
        if (droppedCol && addedCol && droppedCol !== addedCol) {
          warnings.push({
            rule: 'rename-detection',
            severity: 'info',
            objectName: drop.objectName,
            message: `Possible rename detected on "${drop.objectName}": dropping "${droppedCol}" and adding "${addedCol}". Consider using expand/contract instead.`,
            sql: `${drop.sql}; ${add.sql}`,
          });
        }
      }
    }
  }

  const bySeverity: Record<LintSeverity, number> = { warning: 0, info: 0 };
  for (const w of warnings) {
    bySeverity[w.severity]++;
  }

  return {
    warnings,
    summary: {
      total: warnings.length,
      bySeverity,
    },
  };
}
