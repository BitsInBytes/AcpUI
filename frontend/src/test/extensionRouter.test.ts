import { describe, it, expect } from 'vitest';
import { routeExtension } from '../utils/extensionRouter';
import type { SlashCommand } from '../store/useSystemStore';

const PREFIX = 'ext/';
const sysCmds: SlashCommand[] = [{ name: '/help', description: 'Show help' }];
const customCmds = [
  { name: '/deploy', description: 'Deploy app', prompt: 'run deploy' },
  { name: '/noop', description: 'No prompt' },
];

describe('routeExtension', () => {
  it('returns null for non-matching prefix', () => {
    expect(routeExtension('other/commands/available', {}, PREFIX, sysCmds, customCmds)).toBeNull();
  });

  it('routes commands/available with system + custom commands merged', () => {
    const result = routeExtension('ext/commands/available', { commands: [{ name: '/remote', description: 'Remote cmd' }] }, PREFIX, sysCmds, customCmds);
    expect(result).toEqual({
      type: 'commands',
      commands: [
        { name: '/help', description: 'Show help' },
        { name: '/deploy', description: 'Deploy app', meta: { local: true } },
        { name: '/remote', description: 'Remote cmd' },
      ],
    });
  });


  it('routes metadata with sessionId and percentage', () => {
    const result = routeExtension('ext/metadata', { sessionId: 's1', contextUsagePercentage: 42 }, PREFIX, sysCmds, customCmds);
    expect(result).toEqual({ type: 'metadata', sessionId: 's1', contextUsagePercentage: 42 });
  });

  it('routes compaction_started', () => {
    const result = routeExtension('ext/compaction/status', { sessionId: 's1', status: { type: 'started' } }, PREFIX, sysCmds, customCmds);
    expect(result).toEqual({ type: 'compaction_started', sessionId: 's1' });
  });

  it('routes compaction_completed with summary', () => {
    const result = routeExtension('ext/compaction/status', { sessionId: 's1', status: { type: 'completed' }, summary: 'Done' }, PREFIX, sysCmds, customCmds);
    expect(result).toEqual({ type: 'compaction_completed', sessionId: 's1', summary: 'Done' });
  });

  it('returns null for unknown extension type', () => {
    expect(routeExtension('ext/unknown', {}, PREFIX, sysCmds, customCmds)).toBeNull();
  });

  it('filters custom commands without prompt', () => {
    const result = routeExtension('ext/commands/available', { commands: [] }, PREFIX, sysCmds, customCmds);
    expect(result!.type === 'commands' && result!.commands.find(c => c.name === '/noop')).toBeUndefined();
  });

  it('routes config_options with various modes', () => {
    const opts = [{ id: 'opt1', type: 'select', currentValue: 'v1' }] as any;
    
    // replace mode
    const res1 = routeExtension('ext/config_options', { sessionId: 's1', options: opts, replace: true }, PREFIX, sysCmds, customCmds);
    expect(res1).toEqual({ type: 'config_options', sessionId: 's1', options: opts, replace: true, removeOptionIds: undefined });

    // mode: 'replace'
    const res2 = routeExtension('ext/config_options', { sessionId: 's1', options: opts, mode: 'replace' }, PREFIX, sysCmds, customCmds);
    expect(res2).toEqual({ type: 'config_options', sessionId: 's1', options: opts, replace: true, removeOptionIds: undefined });

    // removeOptionIds
    const res3 = routeExtension('ext/config_options', { sessionId: 's1', removeOptionIds: ['r1'] }, PREFIX, sysCmds, customCmds);
    expect(res3).toEqual({ type: 'config_options', sessionId: 's1', options: [], replace: false, removeOptionIds: ['r1'] });
  });

  it('handles compaction/status unknown types', () => {
    const res = routeExtension('ext/compaction/status', { status: { type: 'unknown' } }, PREFIX, sysCmds, customCmds);
    expect(res).toBeNull();
  });

  it('handles compaction/status without status object', () => {
    const res = routeExtension('ext/compaction/status', {}, PREFIX, sysCmds, customCmds);
    expect(res).toBeNull();
  });
});
