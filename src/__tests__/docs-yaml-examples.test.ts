import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { parseTable } from '../schema/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_DOCS = path.resolve(here, '../../docs-site/src/content/docs/schema');

interface Block {
  file: string;
  index: number;
  body: string;
}

/** Extract every ```yaml fenced block from a markdown file. */
function yamlBlocks(file: string): Block[] {
  const md = fs.readFileSync(file, 'utf-8');
  const blocks: Block[] = [];
  const re = /```ya?ml\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(md)) !== null) {
    blocks.push({ file: path.basename(file), index: i++, body: m[1] });
  }
  return blocks;
}

/**
 * A self-contained table example: a root-level `table:` and `columns:`, not an
 * `extend:` fragment, and no `[...]` elision placeholder (docs sometimes elide
 * columns with `[...]` to focus on another block — that isn't a real table).
 */
function isCompleteTable(body: string): boolean {
  return /^table:/m.test(body) && /^columns:/m.test(body) && !/^extend:/m.test(body) && !body.includes('[...]');
}

const allBlocks = fs
  .readdirSync(SCHEMA_DOCS)
  .filter((f) => f.endsWith('.md'))
  .flatMap((f) => yamlBlocks(path.join(SCHEMA_DOCS, f)));

describe('docs YAML examples', () => {
  it('found YAML blocks to validate (guards against a broken extractor)', () => {
    expect(allBlocks.length).toBeGreaterThan(20);
  });

  // Every fenced block must be syntactically valid YAML. `!sql` is a schema-flow
  // custom tag; strip it for this structural check (parseTable handles it for
  // real). Catches indentation/syntax bugs in fragments too.
  it.each(allBlocks)('$file block #$index is valid YAML', ({ body }) => {
    expect(() => parseYaml(body.replace(/!sql\s+/g, ''))).not.toThrow();
  });

  // Every complete table example must actually parse as a table definition —
  // this is what catches a documented key/shape the parser doesn't accept (e.g.
  // a renamed field, or a composite-FK example in the wrong form).
  const tableBlocks = allBlocks.filter((b) => isCompleteTable(b.body));

  it('found complete table examples', () => {
    expect(tableBlocks.length).toBeGreaterThan(0);
  });

  it.each(tableBlocks)('$file table block #$index parses via parseTable', ({ body }) => {
    expect(() => parseTable(body)).not.toThrow();
  });
});
