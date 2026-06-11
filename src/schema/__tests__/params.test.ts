import { describe, it, expect } from 'vitest';
import { interpolateParamString, interpolateMixin, interpolateFunctionBody } from '../params.js';
import type { MixinSchema, FunctionSchema } from '../types.js';

describe('interpolateParamString', () => {
  it('substitutes known params', () => {
    expect(interpolateParamString("current_setting('{{guc}}')", { guc: 'app.id' }, 'ctx')).toBe(
      "current_setting('app.id')",
    );
  });

  it('leaves a string without placeholders unchanged', () => {
    expect(interpolateParamString('plain text', {}, 'ctx')).toBe('plain text');
  });

  it('throws on an unknown param, naming the context', () => {
    expect(() => interpolateParamString('{{missing}}', {}, 'function "f"')).toThrow(
      /function "f": references unknown or unset mixin param "\{\{missing\}\}"/,
    );
  });
});

describe('interpolateMixin', () => {
  it('substitutes params into nested column references and drops the params field', () => {
    const mixin: MixinSchema = {
      mixin: 'audit',
      params: { user_table: { default: 'users' }, user_pk: { default: 'user_id' } },
      columns: [{ name: 'created_by', type: 'bigint', references: { table: '{{user_table}}', column: '{{user_pk}}' } }],
    };
    const result = interpolateMixin(mixin, { user_table: 'accounts', user_pk: 'account_id' });
    expect(result.params).toBeUndefined();
    expect(result.columns![0].references).toEqual({ table: 'accounts', column: 'account_id' });
  });

  it('JSON-escapes param values containing quotes', () => {
    const mixin: MixinSchema = {
      mixin: 'm',
      columns: [{ name: 'c', type: 'text', default: '{{val}}' }],
    };
    const result = interpolateMixin(mixin, { val: `O'Brien "x"` });
    expect(result.columns![0].default).toBe(`O'Brien "x"`);
  });

  it('throws when a placeholder has no resolved value', () => {
    const mixin: MixinSchema = { mixin: 'm', columns: [{ name: 'c', type: '{{t}}' }] };
    expect(() => interpolateMixin(mixin, {})).toThrow(/mixin "m": references unknown or unset mixin param "\{\{t\}\}"/);
  });

  it('leaves {{...}} prose in the mixin comment inert', () => {
    const mixin: MixinSchema = {
      mixin: 'audit',
      params: { user_table: { default: 'users' } },
      comment: 'Interpolates {{user_table}} and {{undeclared}} into columns.',
      columns: [{ name: 'changed_by', type: 'bigint', references: { table: '{{user_table}}', column: 'user_id' } }],
    };
    const result = interpolateMixin(mixin, { user_table: 'accounts' });
    expect(result.comment).toBe('Interpolates {{user_table}} and {{undeclared}} into columns.');
    expect(result.columns![0].references).toEqual({ table: 'accounts', column: 'user_id' });
  });

  it('leaves {{...}} prose in a nested column comment inert', () => {
    const mixin: MixinSchema = {
      mixin: 'audit',
      columns: [{ name: 'changed_by', type: '{{t}}', comment: 'Set via {{actor_guc}}, see docs.' }],
    };
    const result = interpolateMixin(mixin, { t: 'bigint' });
    expect(result.columns![0].type).toBe('bigint');
    expect(result.columns![0].comment).toBe('Set via {{actor_guc}}, see docs.');
  });

  it('does not interpolate the mixin name itself', () => {
    const mixin: MixinSchema = { mixin: '{{nope}}', columns: [{ name: 'c', type: 'text' }] };
    const result = interpolateMixin(mixin, {});
    expect(result.mixin).toBe('{{nope}}');
  });
});

describe('interpolateFunctionBody', () => {
  const base: FunctionSchema = { name: 'f', language: 'sql', returns: 'text', body: '' };

  it('substitutes params in the body', () => {
    const fn = { ...base, body: "SELECT current_setting('{{guc}}')" };
    expect(interpolateFunctionBody(fn, { guc: 'app.who' }).body).toBe("SELECT current_setting('app.who')");
  });

  it('returns the same function untouched when the body has no placeholders', () => {
    const fn = { ...base, body: 'SELECT 1' };
    expect(interpolateFunctionBody(fn, {})).toBe(fn);
  });
});
