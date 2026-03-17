import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(__dirname, '..', '..');

describe('Idempotent pipeline documentation', () => {
  describe('PRD.md', () => {
    const prd = readFileSync(resolve(ROOT, 'docs', 'PRD.md'), 'utf-8');

    it('lists idempotency as a design principle', () => {
      expect(prd).toMatch(/[Ii]dempotent/);
    });

    it('describes the idempotency guarantee in the Design Principles section', () => {
      const designSection = prd.split(/^## /m).find((s) => s.startsWith('1.') || s.includes('Overview'));
      expect(designSection).toBeDefined();
      expect(designSection).toMatch(/[Ii]dempotent/);
    });

    it('explains that DDL statements are safe to re-run', () => {
      expect(prd).toMatch(/safe to re-run|no errors.*already exist|IF NOT EXISTS|IF EXISTS/i);
    });
  });

  describe('README.md', () => {
    const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf-8');

    it('mentions idempotent pipeline in features or description', () => {
      expect(readme).toMatch(/[Ii]dempotent/);
    });

    it('summarizes the idempotency guarantee', () => {
      expect(readme).toMatch(/idempotent.*pipeline|pipeline.*idempotent/i);
    });
  });
});
