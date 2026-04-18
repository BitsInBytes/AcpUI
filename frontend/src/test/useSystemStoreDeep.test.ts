import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react-dom/test-utils';

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

  it('setContextUsage updates session percentage', () => {
    act(() => { useSystemStore.getState().setContextUsage('s1', 45); });
    expect(useSystemStore.getState().contextUsageBySession['s1']).toBe(45);
  });

  it('setCompacting tracks compaction state per session', () => {
    act(() => { useSystemStore.getState().setCompacting('s1', true); });
    expect(useSystemStore.getState().compactingBySession['s1']).toBe(true);
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
