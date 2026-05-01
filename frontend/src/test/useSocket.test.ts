import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { Socket } from 'socket.io-client';
import { useSystemStore } from '../store/useSystemStore';
import { useVoiceStore } from '../store/useVoiceStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useStreamStore } from '../store/useStreamStore';

// Mock the stores
vi.mock('../store/useSystemStore', () => ({
  useSystemStore: vi.fn(),
}));

vi.mock('../store/useVoiceStore', () => ({
  useVoiceStore: {
    getState: vi.fn(),
  },
}));

vi.mock('../store/useSessionLifecycleStore', () => ({
  useSessionLifecycleStore: {
    setState: vi.fn(),
    getState: vi.fn(),
  },
}));

vi.mock('../store/useStreamStore', () => ({
  useStreamStore: {
    getState: vi.fn(),
  },
}));

vi.mock('../utils/extensionRouter', () => ({
  routeExtension: vi.fn(),
}));
vi.mock('../utils/configOptions', () => ({
  mergeProviderConfigOptions: vi.fn(),
}));

const mockSocket = {
  on: vi.fn(),
  off: vi.fn(),
  emit: vi.fn(),
  connected: true,
} as unknown as Socket;

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

describe('useSocket hook', () => {
  let systemStoreState: any;
  let useSocket: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    
    const mod = await import('../hooks/useSocket');
    useSocket = mod.useSocket;

    systemStoreState = {
      connected: false,
      isEngineReady: false,
      backendBootId: '',
      sslError: null,
      setConnected: vi.fn(),
      setProviderReady: vi.fn(),
      setIsEngineReady: vi.fn(),
      setBackendBootId: vi.fn(),
      setWorkspaceCwds: vi.fn(),
      setProviders: vi.fn(),
      setProviderBranding: vi.fn((data: any) => {
        systemStoreState.branding = { ...systemStoreState.branding, ...data };
      }),
      setState: vi.fn((update: any) => {
        Object.assign(systemStoreState, typeof update === 'function' ? update(systemStoreState) : update);
      }),
      setDeletePermanent: vi.fn(),
      setNotificationSettings: vi.fn(),
      setCustomCommands: vi.fn(),
      setSlashCommands: vi.fn(),
      setContextUsage: vi.fn(),
      setProviderStatus: vi.fn(),
      setCompacting: vi.fn(),
      setSocket: vi.fn(),
      branding: { title: 'Test Title', protocolPrefix: '_provider/' },
      providersById: {},
      slashCommands: [],
      getBranding: vi.fn(() => systemStoreState.branding),
    };

    (useSystemStore as any).mockImplementation((selector: any) => selector(systemStoreState));
    (useSystemStore.getState = vi.fn(() => systemStoreState)) as any;
    (useSystemStore.setState = vi.fn((updater: any) => {
        const newState = typeof updater === 'function' ? updater(systemStoreState) : updater;
        Object.assign(systemStoreState, newState);
    })) as any;

    (useVoiceStore.getState as any).mockReturnValue({});
    (useSessionLifecycleStore.getState as any).mockReturnValue({ sessions: [] });
    (useStreamStore.getState as any).mockReturnValue({ streamQueues: {} });
  });

  it('initializes socket and sets up listeners', () => {
    const { result } = renderHook(() => useSocket());
    expect(result.current.socket).toBe(mockSocket);
    expect(mockSocket.on).toHaveBeenCalledWith('connect', expect.any(Function));
    expect(systemStoreState.setSocket).toHaveBeenCalledWith(mockSocket);
  });

  it('handles "connect" event', () => {
    renderHook(() => useSocket());
    const connectHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'connect')[1];
    connectHandler();
    expect(systemStoreState.setConnected).toHaveBeenCalledWith(true);
  });

  it('handles "ready" event with providerId', () => {
    renderHook(() => useSocket());
    const readyHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'ready')[1];
    readyHandler({ bootId: 'test-boot', providerId: 'test-provider' });
    expect(systemStoreState.setProviderReady).toHaveBeenCalledWith('test-provider', true);
    expect(systemStoreState.setBackendBootId).toHaveBeenCalledWith('test-boot');
  });

  it('handles "ready" event without providerId', () => {
    renderHook(() => useSocket());
    const readyHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'ready')[1];
    readyHandler({ bootId: 'test-boot' });
    expect(systemStoreState.setIsEngineReady).toHaveBeenCalledWith(true);
    expect(systemStoreState.setBackendBootId).toHaveBeenCalledWith('test-boot');
  });

  it('handles "voice_enabled" event', () => {
    const voiceStore = { setIsVoiceEnabled: vi.fn() };
    (useVoiceStore.getState as any).mockReturnValue(voiceStore);
    renderHook(() => useSocket());
    const voiceHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'voice_enabled')[1];
    voiceHandler({ enabled: true });
    expect(voiceStore.setIsVoiceEnabled).toHaveBeenCalledWith(true);
  });

  it('handles "branding" event', () => {
    renderHook(() => useSocket());
    const brandingHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'branding')[1];
    const brandingData = { providerId: 'p1', title: 'New Title' };
    
    const spy = vi.spyOn(document, 'title', 'set');
    brandingHandler(brandingData);
    expect(systemStoreState.setProviderBranding).toHaveBeenCalledWith(brandingData);
    expect(spy).toHaveBeenCalledWith('New Title');
  });

  it('handles "workspace_cwds" event', () => {
    renderHook(() => useSocket());
    const handler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'workspace_cwds')[1];
    const cwds = [{ path: '/a', label: 'A' }];
    handler({ cwds });
    expect(systemStoreState.setWorkspaceCwds).toHaveBeenCalledWith(cwds);
  });

  it('handles "providers" event', () => {
    renderHook(() => useSocket());
    const handler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'providers')[1];
    handler({ defaultProviderId: 'p1', providers: [{ id: 'p1', name: 'P1' }] });
    expect(systemStoreState.setProviders).toHaveBeenCalledWith('p1', [{ id: 'p1', name: 'P1' }]);
  });

  it('handles "sidebar_settings" event', () => {
    renderHook(() => useSocket());
    const handler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'sidebar_settings')[1];
    handler({ deletePermanent: true, notificationSound: true, notificationDesktop: false });
    expect(systemStoreState.setDeletePermanent).toHaveBeenCalledWith(true);
    expect(systemStoreState.setNotificationSettings).toHaveBeenCalledWith(true, false);
  });

  it('handles "custom_commands" event', () => {
    renderHook(() => useSocket());
    const handler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'custom_commands')[1];
    const commands = [{ name: 'test', description: 'desc', prompt: 'p' }];
    handler({ commands });
    expect(systemStoreState.setCustomCommands).toHaveBeenCalledWith(commands);
    expect(systemStoreState.setSlashCommands).toHaveBeenCalled();
  });

  it('handles "session_model_options" event', async () => {
    const { useSessionLifecycleStore } = await import('../store/useSessionLifecycleStore');
    renderHook(() => useSocket());
    const handler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'session_model_options')[1];
    
    handler({ sessionId: 's1', currentModelId: 'm1', modelOptions: [{ id: 'm1', name: 'M1' }] });
    expect(useSessionLifecycleStore.setState).toHaveBeenCalled();
  });

  describe('provider_extension event', () => {
    let extensionHandler: any;

    beforeEach(() => {
      renderHook(() => useSocket());
      extensionHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'provider_extension')[1];
    });

    it('handles "commands" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      (routeExtension as any).mockReturnValueOnce({ type: 'commands', commands: [{ name: '/fix' }] });
      extensionHandler({ method: 'test/listCommands', params: { providerId: 'p1' } });
      expect(systemStoreState.setSlashCommands).toHaveBeenCalled();
    });

    it('handles "metadata" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      (routeExtension as any).mockReturnValueOnce({ type: 'metadata', sessionId: 's1', contextUsagePercentage: 50 });
      extensionHandler({ method: 'test/metadata', params: { sessionId: 's1' } });
      expect(systemStoreState.setContextUsage).toHaveBeenCalledWith('s1', 50);
    });

    it('handles "provider_status" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      (routeExtension as any).mockReturnValueOnce({ type: 'provider_status', status: { status: 'busy' } });
      extensionHandler({ method: 'test/status', params: { providerId: 'p1' } });
      expect(systemStoreState.setProviderStatus).toHaveBeenCalledWith({ status: 'busy' }, 'p1');
    });

    it('handles "config_options" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      const { useSessionLifecycleStore } = await import('../store/useSessionLifecycleStore');
      (routeExtension as any).mockReturnValueOnce({ type: 'config_options', sessionId: 's1', options: [{ id: 'opt1' }], replace: false });
      extensionHandler({ method: 'test/config_options', params: { sessionId: 's1' } });
      expect(useSessionLifecycleStore.setState).toHaveBeenCalled();
    });

    it('handles "compaction_started" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      (routeExtension as any).mockReturnValueOnce({ type: 'compaction_started', sessionId: 's1' });
      extensionHandler({ method: 'test/compact_start', params: { sessionId: 's1' } });
      expect(systemStoreState.setCompacting).toHaveBeenCalledWith('s1', true);
    });

    it('handles "compaction_completed" extension', async () => {
      const { routeExtension } = await import('../utils/extensionRouter');
      const { useStreamStore } = await import('../store/useStreamStore');
      (routeExtension as any).mockReturnValueOnce({ type: 'compaction_completed', sessionId: 's1', summary: 'Cleaned up' });
      
      const streamStore = { onStreamToken: vi.fn(), streamQueues: {} };
      (useStreamStore.getState as any).mockReturnValue(streamStore);

      extensionHandler({ method: 'test/compact_done', params: { sessionId: 's1' } });
      expect(streamStore.onStreamToken).toHaveBeenCalled();
    });
  });

  it('handles "disconnect" event', () => {
    renderHook(() => useSocket());
    const disconnectHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'disconnect')[1];
    disconnectHandler();
    expect(systemStoreState.setConnected).toHaveBeenCalledWith(false);
  });

  it('handles "connect_error" event', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    renderHook(() => useSocket());
    const errorHandler = (mockSocket.on as any).mock.calls.find((call: any) => call[0] === 'connect_error')[1];
    errorHandler(new Error('failed'));
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});


