import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARSER_KEY_SETS } from '../schema/parser.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PARSER_SRC = path.resolve(here, '../schema/parser.ts');
const DOCS_ROOT = path.resolve(here, '../../docs-site/src/content/docs');

function allMarkdown(dir: string): string {
  let out = '';
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out += allMarkdown(p);
    else if (entry.name.endsWith('.md') || entry.name.endsWith('.mdx')) out += '\n' + fs.readFileSync(p, 'utf-8');
  }
  return out;
}

// Keys intentionally not documented under their own name — each is an alias of,
// or replaced by, something that IS documented. Anything else missing from the
// docs is a real gap and should be documented, not added here.
const DOC_EXEMPT = new Set<string>([
  'description', // alias for `comment` (the documented spelling)
  'in', // alias for `member_of` (the canonical, documented spelling)
  'unique_constraints', // removed in 0.8.0; kept only to throw a migration error toward `indexes:`
]);

describe('parser key-set registry', () => {
  // The meta-guard: PARSER_KEY_SETS must list EVERY `*_KEYS` allowlist the
  // parser declares, so a new primitive's key set can't be added without being
  // registered (and therefore doc-checked) here.
  it('registers every *_KEYS allowlist declared in the parser', () => {
    const src = fs.readFileSync(PARSER_SRC, 'utf-8');
    const declared = [...src.matchAll(/(?:export )?const ([A-Z_]+_KEYS)\s*=/g)].map((m) => m[1]);
    expect(declared.length, 'source scan found no *_KEYS — the extractor is broken').toBeGreaterThan(25);
    const registered = new Set(Object.keys(PARSER_KEY_SETS));
    const unregistered = declared.filter((n) => !registered.has(n));
    expect(unregistered, `parser *_KEYS not registered in PARSER_KEY_SETS: ${unregistered.join(', ')}`).toEqual([]);
  });

  // Every configurable key, across every allowlist, must appear somewhere in the
  // docs — as a `code` mention or a `key:` in a YAML example. A new key cannot
  // ship undocumented.
  const docs = allMarkdown(DOCS_ROOT);
  const everyKey = [...new Set(Object.values(PARSER_KEY_SETS).flatMap((s) => [...s]))]
    .filter((k) => !DOC_EXEMPT.has(k))
    .sort();

  it('found a realistic number of keys (guards the registry/extractor)', () => {
    expect(everyKey.length).toBeGreaterThan(40);
  });

  it.each(everyKey)('documents the "%s" key somewhere in the docs', (key) => {
    const re = new RegExp('`' + key + '`|(?:^|\\s)' + key + ':');
    expect(re.test(docs), `key "${key}" is accepted by the parser but not documented anywhere in the docs`).toBe(true);
  });
});
