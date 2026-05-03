import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

describe('useSystemStore (Pure Logic)', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({
        socket: null,
        connected: false,
        isEngineReady: false,
        activeProviderId: null,
        defaultProviderId: null,
        providersById: {},
        readyByProviderId: {},
        orderedProviderIds: [],
        slashCommandsByProviderId: {},
        providerStatusByProviderId: {},
        branding: { assistantName: 'Assistant' } as any
      });
    });
  });

  it('setProviders calculates active provider and branding', () => {
    const providers = [
      { providerId: 'p1', label: 'P1', branding: { assistantName: 'B1' }, ready: true },
      { providerId: 'p2', label: 'P2', branding: { assistantName: 'B2' }, ready: false }
    ];

    act(() => {
      useSystemStore.getState().setProviders('p1', providers as any);
    });

    const state = useSystemStore.getState();
    expect(state.activeProviderId).toBe('p1');
    expect(state.branding.assistantName).toBe('B1');
    expect(state.readyByProviderId['p2']).toBe(false);
  });

  it('setProviderBranding updates branding if provider is active', () => {
    act(() => {
        useSystemStore.setState({ activeProviderId: 'p1' });
        useSystemStore.getState().setProviderBranding({ providerId: 'p1', assistantName: 'Updated' } as any);
    });

    expect(useSystemStore.getState().branding.assistantName).toBe('Updated');
  });

  it('setSlashCommands handles per-provider scoping', () => {
    const cmds = [{ name: '/c1', description: 'desc' }];
    act(() => {
        useSystemStore.setState({ activeProviderId: 'p1' });
        useSystemStore.getState().setSlashCommands(cmds, 'p1');
    });

    expect(useSystemStore.getState().slashCommands).toEqual(cmds);
    expect(useSystemStore.getState().slashCommandsByProviderId['p1']).toEqual(cmds);

    act(() => {
        useSystemStore.getState().setSlashCommands([{ name: '/other', description: 'Other command' }], 'p2');
    });
    // Active provider p1 should still have /c1
    expect(useSystemStore.getState().slashCommands).toEqual(cmds);
    expect(useSystemStore.getState().slashCommandsByProviderId['p2']).toHaveLength(1);
  });

  it('setProviderStatus manages active status vs background status', () => {
    act(() => {
      useSystemStore.setState({ activeProviderId: 'p1' });
      useSystemStore.getState().setProviderStatus({ providerId: 'p1', sections: [] } as any, 'p1');
      useSystemStore.getState().setProviderStatus({ providerId: 'p2', sections: [] } as any, 'p2');
    });

    expect(useSystemStore.getState().providerStatus?.providerId).toBe('p1');
    expect(useSystemStore.getState().providerStatusByProviderId['p2'].providerId).toBe('p2');
  });

  it('setProviderReady updates isEngineReady state', () => {
    act(() => {
        useSystemStore.setState({ activeProviderId: 'p1', isEngineReady: false });
        useSystemStore.getState().setProviderReady('p1', true);
    });
    expect(useSystemStore.getState().isEngineReady).toBe(true);
  });
});
