import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VALID_COMMANDS } from '../cli/args.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const COMMANDS_DOC = path.resolve(here, '../../docs-site/src/content/docs/cli/commands.md');

// `help` is the implicit default command (bare `schema-flow` / `--help`); it's
// documented by the page's own existence, not a `### schema-flow help` heading.
const NOT_DOCUMENTED_AS_HEADING = new Set(['help']);

/** Top-level command names from each `### \`schema-flow <cmd> …\`` heading. */
function documentedCommands(markdown: string): Set<string> {
  const cmds = new Set<string>();
  for (const line of markdown.split('\n')) {
    // First token after `schema-flow` that starts with a letter — i.e. a command,
    // not a global flag like `--version`.
    const m = line.match(/^#{2,4}\s+`schema-flow\s+([a-z][a-z-]*)/);
    if (m) cmds.add(m[1]);
  }
  return cmds;
}

describe('docs / CLI commands sync', () => {
  it('documents every command the CLI accepts (and nothing it does not)', () => {
    const markdown = fs.readFileSync(COMMANDS_DOC, 'utf-8');
    const documented = documentedCommands(markdown);

    const expected = VALID_COMMANDS.filter((c) => !NOT_DOCUMENTED_AS_HEADING.has(c));

    const missingFromDocs = expected.filter((c) => !documented.has(c));
    expect(missingFromDocs, `CLI commands missing from cli/commands.md: ${missingFromDocs.join(', ')}`).toEqual([]);

    const valid = new Set<string>(VALID_COMMANDS);
    const invented = [...documented].filter((c) => !valid.has(c));
    expect(invented, `commands documented but not accepted by the CLI: ${invented.join(', ')}`).toEqual([]);
  });
});
