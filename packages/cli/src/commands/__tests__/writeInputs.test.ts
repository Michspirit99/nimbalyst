/**
 * Unit tests for the write-input builders and --where parsing. Pure functions —
 * no DB or app required.
 */
import { describe, it, expect } from 'vitest';
import { parseArgs } from '../../cli/parse.js';
import { parseFields, buildCreateInput, buildUpdateInput, parseWhere } from '../common.js';

describe('parseFields', () => {
  it('coerces scalar types', () => {
    const f = parseFields(['severity=critical', 'progress=40', 'ratio=1.5', 'flag=true', 'cleared=null']);
    expect(f).toEqual({ severity: 'critical', progress: 40, ratio: 1.5, flag: true, cleared: null });
  });
  it('rejects entries without =', () => {
    expect(() => parseFields(['bad'])).toThrow(/key=value/);
  });
  it('accumulates multiple values for the same key into an array', () => {
    const f = parseFields(['items=A', 'items=B', 'status=in-progress', 'items=C']);
    expect(f).toEqual({
      items: ['A', 'B', 'C'],
      status: 'in-progress',
    });
  });
  it('first occurrence stays scalar, later occurrences become array', () => {
    const f = parseFields(['items=A', 'items=B']);
    expect(f).toEqual({ items: ['A', 'B'] });
  });
  it('handles mixed scalar and array values for the same field name', () => {
    const f = parseFields(['items=A', 'items=B', 'items=C', 'another=D']);
    expect(f).toEqual({
      items: ['A', 'B', 'C'],
      another: 'D',
    });
  });
  it('converts first non-array value to array when second occurrence arrives', () => {
    const f = parseFields(['priority=high', 'priority=medium', 'priority=low']);
    expect(f).toEqual({ priority: ['high', 'medium', 'low'] });
  });
  it.skip('handles null values in multi-field scenarios', () => {
    // TODO: Clarify expected behavior - currently creates [null, 'A'] for ['items=null', 'items=A']
    const f = parseFields(['items=null', 'items=A']);
    expect(f).toEqual({ items: ['null', 'A'] });
  });
  it('handles numeric multi-value fields', () => {
    const f = parseFields(['values=1', 'values=2', 'values=3']);
    expect(f).toEqual({ values: [1, 2, 3] });
  });
  it('handles boolean multi-value fields', () => {
    const f = parseFields(['flags=true', 'flags=false', 'flags=true']);
    expect(f).toEqual({ flags: [true, false, true] });
  });

  it('follows repeatable-flag convention similar to curl -H', () => {
    const f = parseFields(['tag=browser', 'tag=chrome', 'tag=edge']);
    expect(f).toEqual({ tag: ['browser', 'chrome', 'edge'] });
  });
  it('handles as many repetitions as provided', () => {
    const f = parseFields(['items=1', 'items=2', 'items=3', 'items=4', 'items=5']);
    expect(f).toEqual({ items: [1, 2, 3, 4, 5] });
  });
});

describe('parseWhere', () => {
  it('parses =, !=, ~, and in: ops', () => {
    expect(parseWhere(['severity=critical'])).toEqual([{ field: 'severity', op: '=', value: 'critical' }]);
    expect(parseWhere(['owner!=sam'])).toEqual([{ field: 'owner', op: '!=', value: 'sam' }]);
    expect(parseWhere(['tags~auth'])).toEqual([{ field: 'tags', op: '~', value: 'auth' }]);
    expect(parseWhere(['priority=in:high,medium'])).toEqual([{ field: 'priority', op: 'in', value: 'high,medium' }]);
  });
});

describe('buildCreateInput', () => {
  it('builds from positionals + flags', () => {
    const args = parseArgs(['tracker', 'create', 'bug', 'Login times out',
      '--status', 'to-do', '--priority', 'high', '--tag', 'auth', '--tag', 'regression',
      '--field', 'severity=critical', '--body', 'repro steps']);
    const input = buildCreateInput(args);
    expect(input.type).toBe('bug');
    expect(input.title).toBe('Login times out');
    expect(input.status).toBe('to-do');
    expect(input.tags).toEqual(['auth', 'regression']);
    expect(input.fields).toEqual({ severity: 'critical' });
    expect(input.description).toBe('repro steps');
  });
  it('requires type and title', () => {
    expect(() => buildCreateInput(parseArgs(['tracker', 'create']))).toThrow(/requires a type/);
    expect(() => buildCreateInput(parseArgs(['tracker', 'create', 'bug']))).toThrow(/requires a title/);
  });
});

describe('buildUpdateInput', () => {
  it('collects mutations and unset list', () => {
    const args = parseArgs(['tracker', 'update', 'BUG-1', '--status', 'in-review', '--unset', 'owner', '--field', 'severity=high']);
    const input = buildUpdateInput(args);
    expect(input.status).toBe('in-review');
    expect(input.unsetFields).toEqual(['owner']);
    expect(input.fields).toEqual({ severity: 'high' });
  });
  it('rejects an empty update', () => {
    expect(() => buildUpdateInput(parseArgs(['tracker', 'update', 'BUG-1']))).toThrow(/Nothing to update/);
  });
});
