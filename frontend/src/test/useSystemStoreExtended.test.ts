import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSystemStore (extended)', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({
        activeProviderId: null,
        providersById: {},
        orderedProviderIds: [],
        readyByProviderId: {},
        branding: { assistantName: 'Assistant' } as any
      });
    });
  });

  it('setProviders updates nextActiveProviderId and active branding', () => {
    const providers = [
      { providerId: 'p1', label: 'P1', branding: { assistantName: 'Brand 1' }, ready: true },
      { providerId: 'p2', label: 'P2', branding: { assistantName: 'Brand 2' }, ready: false }
    ];
    
    act(() => {
      useSystemStore.getState().setProviders('p2', providers as any);
    });

    const state = useSystemStore.getState();
    expect(state.activeProviderId).toBe('p2');
    expect(state.branding.assistantName).toBe('Brand 2');
    expect(state.readyByProviderId['p1']).toBe(true);
    expect(state.readyByProviderId['p2']).toBe(false);
  });

  it('setProviderReady updates isEngineReady if it is the active provider', () => {
    act(() => {
       useSystemStore.setState({ activeProviderId: 'p1', isEngineReady: false });
       useSystemStore.getState().setProviderReady('p1', true);
    });
    expect(useSystemStore.getState().isEngineReady).toBe(true);

    act(() => {
       useSystemStore.getState().setProviderReady('other', false);
    });
    expect(useSystemStore.getState().isEngineReady).toBe(true); // remains true
  });

  it('setProviderStatus manages per-provider status', () => {
    act(() => {
      useSystemStore.getState().setProviderStatus({ providerId: 'p1', sections: [] } as any, 'p1');
    });

    expect(useSystemStore.getState().providerStatusByProviderId['p1'].providerId).toBe('p1');

    act(() => {
      useSystemStore.getState().setProviderStatus(null, 'p1');
    });
    expect(useSystemStore.getState().providerStatusByProviderId['p1']).toBeUndefined();
  });

  it('setSlashCommands updates active commands if provider is active', () => {
    const cmds = [{ name: '/test', description: 'test' }];
    act(() => {
       useSystemStore.setState({ activeProviderId: 'p1' });
       useSystemStore.getState().setSlashCommands(cmds, 'p1');
    });
    expect(useSystemStore.getState().slashCommands).toEqual(cmds);
    expect(useSystemStore.getState().slashCommandsByProviderId['p1']).toEqual(cmds);
  });
});
