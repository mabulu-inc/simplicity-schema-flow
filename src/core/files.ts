/**
 * File discovery for simplicity-schema.
 *
 * Glob-based discovery of YAML and SQL files from the schema directory,
 * organized by phase (pre, schema, post).
 */

import { glob } from 'glob';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type Phase = 'pre' | 'schema' | 'post';

export interface SchemaFile {
  /** Relative path from baseDir (e.g., "tables/users.yaml") */
  relativePath: string;
  /** Absolute path on disk */
  absolutePath: string;
  /** Phase classification */
  phase: Phase;
  /** SHA-256 hash of file contents */
  hash: string;
}

export interface DiscoveredFiles {
  pre: SchemaFile[];
  schema: SchemaFile[];
  post: SchemaFile[];
}

/** Compute SHA-256 hash of a file's contents. */
export async function hashFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Discover all schema files in the given base directory.
 *
 * Directory structure:
 * - pre/*.sql        → phase "pre" (alphabetical order)
 * - tables/*.yaml    → phase "schema"
 * - enums/*.yaml     → phase "schema"
 * - functions/*.yaml → phase "schema"
 * - views/*.yaml     → phase "schema"
 * - roles/*.yaml     → phase "schema"
 * - mixins/*.yaml    → phase "schema"
 * - extensions.yaml  → phase "schema"
 * - post/*.sql       → phase "post" (alphabetical order)
 */
export async function discoverSchemaFiles(baseDir: string): Promise<DiscoveredFiles> {
  const abs = path.resolve(baseDir);

  const [preFiles, schemaFiles, postFiles] = await Promise.all([
    discoverPhaseFiles(abs, ['pre/*.sql'], 'pre'),
    discoverPhaseFiles(
      abs,
      [
        'tables/*.yaml',
        'enums/*.yaml',
        'functions/*.yaml',
        'views/*.yaml',
        'roles/*.yaml',
        'mixins/*.yaml',
        'extensions.yaml',
      ],
      'schema',
    ),
    discoverPhaseFiles(abs, ['post/*.sql'], 'post'),
  ]);

  return {
    pre: preFiles,
    schema: schemaFiles,
    post: postFiles,
  };
}

async function discoverPhaseFiles(baseDir: string, patterns: string[], phase: Phase): Promise<SchemaFile[]> {
  const allPaths: string[] = [];

  for (const pattern of patterns) {
    const matches = await glob(pattern, { cwd: baseDir, absolute: true });
    allPaths.push(...matches);
  }

  // Sort alphabetically by relative path for deterministic ordering
  allPaths.sort((a, b) => {
    const relA = path.relative(baseDir, a);
    const relB = path.relative(baseDir, b);
    return relA.localeCompare(relB);
  });

  const files: SchemaFile[] = [];
  for (const absPath of allPaths) {
    const hash = await hashFile(absPath);
    files.push({
      relativePath: path.relative(baseDir, absPath),
      absolutePath: absPath,
      phase,
      hash,
    });
  }

  return files;
}
