import { describe, expect, it } from 'vitest';
import { collectInputObjects, firstStringValue, mergeInputObjects, parseMaybeJson } from '../services/tools/toolInputUtils.js';

describe('toolInputUtils', () => {
  it('parses JSON strings when possible', () => {
    expect(parseMaybeJson('{"ok":true}')).toEqual({ ok: true });
    expect(parseMaybeJson('not json')).toBe('not json');
  });

  it('collects nested argument objects without tool identity rules', () => {
    const objects = collectInputObjects({
      invocation: {
        tool: 'provider-owned-name',
        arguments: '{"description":"Run tests","command":"npm test"}'
      }
    });

    expect(objects).toEqual(expect.arrayContaining([
      expect.objectContaining({ invocation: expect.any(Object) }),
      expect.objectContaining({ tool: 'provider-owned-name' }),
      expect.objectContaining({ description: 'Run tests', command: 'npm test' })
    ]));
  });

  it('merges candidates and returns the first string value', () => {
    const candidates = collectInputObjects({ args: { command: ['npm', 'test'], cwd: 'D:/repo' } });

    expect(mergeInputObjects(candidates)).toEqual(expect.objectContaining({ command: ['npm', 'test'], cwd: 'D:/repo' }));
    expect(firstStringValue(candidates, ['command'])).toBe('npm test');
  });
});
