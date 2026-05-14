import { describe, it, expect } from 'vitest';
import * as api from '../index.js';

describe('Public API surface', () => {
  it('exports core functions', () => {
    expect(typeof api.resolveConfig).toBe('function');
    expect(typeof api.withClient).toBe('function');
    expect(typeof api.withTransaction).toBe('function');
    expect(typeof api.closePool).toBe('function');
    expect(typeof api.testConnection).toBe('function');
    expect(typeof api.discoverSchemaFiles).toBe('function');
    expect(typeof api.createLogger).toBe('function');
  });

  it('exports schema parsing functions', () => {
    expect(typeof api.parseTable).toBe('function');
    expect(typeof api.parseEnum).toBe('function');
    expect(typeof api.parseFunction).toBe('function');
    expect(typeof api.parseView).toBe('function');
    expect(typeof api.parseRole).toBe('function');
    expect(typeof api.parseExtensions).toBe('function');
    expect(typeof api.parseMixin).toBe('function');
    expect(typeof api.parseSchemaFile).toBe('function');
    expect(typeof api.loadMixins).toBe('function');
    expect(typeof api.applyMixins).toBe('function');
  });

  it('exports introspection functions', () => {
    expect(typeof api.getExistingTables).toBe('function');
    expect(typeof api.getExistingEnums).toBe('function');
    expect(typeof api.getExistingFunctions).toBe('function');
    expect(typeof api.getExistingViews).toBe('function');
    expect(typeof api.getExistingMaterializedViews).toBe('function');
    expect(typeof api.getExistingRoles).toBe('function');
    expect(typeof api.introspectTable).toBe('function');
  });

  it('exports planner', () => {
    expect(typeof api.buildPlan).toBe('function');
  });

  it('exports executor', () => {
    expect(typeof api.execute).toBe('function');
    expect(typeof api.acquireAdvisoryLock).toBe('function');
    expect(typeof api.releaseAdvisoryLock).toBe('function');
  });

  it('exports drift detection', () => {
    expect(typeof api.detectDrift).toBe('function');
  });

  it('exports lint', () => {
    expect(typeof api.lintPlan).toBe('function');
  });

  it('exports rollback functions', () => {
    expect(typeof api.ensureSnapshotsTable).toBe('function');
    expect(typeof api.saveSnapshot).toBe('function');
    expect(typeof api.getLatestSnapshot).toBe('function');
    expect(typeof api.listSnapshots).toBe('function');
    expect(typeof api.deleteSnapshot).toBe('function');
    expect(typeof api.computeRollback).toBe('function');
    expect(typeof api.runDown).toBe('function');
  });

  it('exports expand/contract functions', () => {
    expect(typeof api.ensureExpandStateTable).toBe('function');
    expect(typeof api.planExpandColumn).toBe('function');
    expect(typeof api.runBackfill).toBe('function');
    expect(typeof api.runBackfillAll).toBe('function');
    expect(typeof api.runContract).toBe('function');
    expect(typeof api.runContractAll).toBe('function');
    expect(typeof api.getExpandStatus).toBe('function');
  });

  it('exports scaffold/generate functions', () => {
    expect(typeof api.generateFromDb).toBe('function');
    expect(typeof api.scaffoldInit).toBe('function');
    expect(typeof api.scaffoldPre).toBe('function');
    expect(typeof api.scaffoldPost).toBe('function');
    expect(typeof api.scaffoldMixin).toBe('function');
  });

  it('exports SQL generation', () => {
    expect(typeof api.generateSql).toBe('function');
  });

  it('exports ERD generation', () => {
    expect(typeof api.generateErd).toBe('function');
  });

  it('exports CLI pipeline functions', () => {
    expect(typeof api.runPipeline).toBe('function');
    expect(typeof api.initProject).toBe('function');
    expect(typeof api.getStatus).toBe('function');
  });

  it('exports LogLevel enum', () => {
    expect(api.LogLevel).toBeDefined();
  });

  it('exports pipeline convenience functions (PRD §13)', () => {
    expect(typeof api.runAll).toBe('function');
    expect(typeof api.runPre).toBe('function');
    expect(typeof api.runMigrate).toBe('function');
    expect(typeof api.runPost).toBe('function');
    expect(typeof api.runValidate).toBe('function');
    expect(typeof api.runBaseline).toBe('function');
  });

  it('exports file-path-based parsers (PRD §13)', () => {
    expect(typeof api.parseTableFile).toBe('function');
    expect(typeof api.parseFunctionFile).toBe('function');
    expect(typeof api.parseEnumFile).toBe('function');
    expect(typeof api.parseViewFile).toBe('function');
    expect(typeof api.parseRoleFile).toBe('function');
  });

  it('exports SQL generation helpers (PRD §13)', () => {
    expect(typeof api.generateSqlFile).toBe('function');
    expect(typeof api.formatMigrationSql).toBe('function');
  });
});
