import { describe, it, expect, beforeEach } from 'vitest';
import { getProviderSessionKey, useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSystemStore (Deep Logic)', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({
        activeProviderId: 'p1',
        contextUsageBySession: {},
        providersById: { p1: { branding: { protocolPrefix: '_p1/' } } as any },
        compactingBySession: {},
        customCommands: []
      });
    });
  });

  it('setContextUsage updates session percentage by provider+session key', () => {
    act(() => { useSystemStore.getState().setContextUsage('p1', 's1', 45); });
    const key = getProviderSessionKey('p1', 's1');
    expect(useSystemStore.getState().contextUsageBySession[key]).toBe(45);
    expect(useSystemStore.getState().getContextUsage('p1', 's1')).toBe(45);
  });

  it('clamps context usage to UI-safe bounds', () => {
    act(() => {
      useSystemStore.getState().setContextUsage('p1', 'over', 125);
      useSystemStore.getState().setContextUsage('p1', 'under', -10);
    });
    expect(useSystemStore.getState().getContextUsage('p1', 'over')).toBe(100);
    expect(useSystemStore.getState().getContextUsage('p1', 'under')).toBe(0);
  });

  it('setCompacting tracks compaction state per provider+session key', () => {
    act(() => { useSystemStore.getState().setCompacting('p1', 's1', true); });
    const key = getProviderSessionKey('p1', 's1');
    expect(useSystemStore.getState().compactingBySession[key]).toBe(true);
    expect(useSystemStore.getState().getCompacting('p1', 's1')).toBe(true);
  });

  it('reads legacy unscoped context and compaction entries as a fallback', () => {
    act(() => {
      useSystemStore.setState({
        contextUsageBySession: { legacy: 33 },
        compactingBySession: { legacy: true }
      });
    });
    expect(useSystemStore.getState().getContextUsage('p1', 'legacy')).toBe(33);
    expect(useSystemStore.getState().hasContextUsage('p1', 'legacy')).toBe(true);
    expect(useSystemStore.getState().getCompacting('p1', 'legacy')).toBe(true);
  });

  it('keeps compaction state isolated for interleaved providers sharing a session id', () => {
    act(() => {
      useSystemStore.getState().setCompacting('claude', 'same-session', true);
      useSystemStore.getState().setCompacting('gemini', 'same-session', false);
    });
    expect(useSystemStore.getState().getCompacting('claude', 'same-session')).toBe(true);
    expect(useSystemStore.getState().getCompacting('gemini', 'same-session')).toBe(false);
  });

  it('keeps context usage isolated for interleaved providers sharing a session id', () => {
    act(() => {
      useSystemStore.getState().setContextUsage('claude', 'same-session', 12);
      useSystemStore.getState().setContextUsage('gemini', 'same-session', 78);
    });
    expect(useSystemStore.getState().getContextUsage('claude', 'same-session')).toBe(12);
    expect(useSystemStore.getState().getContextUsage('gemini', 'same-session')).toBe(78);
  });

  it('setCustomCommands updates state', () => {
    const cmds = [{ name: 'test', description: 'test' }];
    act(() => { useSystemStore.getState().setCustomCommands(cmds); });
    expect(useSystemStore.getState().customCommands).toEqual(cmds);
  });

  it('setProviderStatus handles missing resolvedProviderId', () => {
    act(() => {
        useSystemStore.setState({ activeProviderId: null, defaultProviderId: null });
        useSystemStore.getState().setProviderStatus({ providerId: 'default', sections: [] } as any, null);
    });
    expect(useSystemStore.getState().providerStatus?.providerId).toBe('default');
  });

  it('setProviderStatus correctly identifies active provider updates', () => {
      act(() => {
          useSystemStore.setState({ activeProviderId: 'p1' });
          useSystemStore.getState().setProviderStatus({ providerId: 'p1', sections: [] } as any, 'p1');
      });
      expect(useSystemStore.getState().providerStatus?.providerId).toBe('p1');
  });

  it('setSslError updates state', () => {
    act(() => { useSystemStore.getState().setSslError(true); });
    expect(useSystemStore.getState().sslError).toBe(true);
  });
});
