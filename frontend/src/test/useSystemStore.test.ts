import { describe, it, expect, beforeEach } from 'vitest';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react-dom/test-utils';

describe('useSystemStore', () => {
  beforeEach(() => {
    act(() => {
      useSystemStore.setState({
        socket: null,
        connected: false,
        isEngineReady: false,
        backendBootId: null,
        sslError: false,
      });
    });
  });

  it('updates connection state', () => {
    act(() => {
      useSystemStore.getState().setConnected(true);
    });
    expect(useSystemStore.getState().connected).toBe(true);
  });

  it('updates engine readiness and boot ID', () => {
    act(() => {
      useSystemStore.getState().setIsEngineReady(true);
      useSystemStore.getState().setBackendBootId('test-boot');
    });
    expect(useSystemStore.getState().isEngineReady).toBe(true);
    expect(useSystemStore.getState().backendBootId).toBe('test-boot');
  });

  it('handles SSL errors', () => {
    act(() => {
      useSystemStore.getState().setSslError(true);
    });
    expect(useSystemStore.getState().sslError).toBe(true);
  });

  it('stores the socket instance', () => {
    const mockSocket = { id: 'test-socket' } as any;
    act(() => {
      useSystemStore.getState().setSocket(mockSocket);
    });
    expect(useSystemStore.getState().socket).toBe(mockSocket);
  });

  it('customCommands defaults to empty array', () => {
    expect(useSystemStore.getState().customCommands).toEqual([]);
  });

  it('setCustomCommands stores commands', () => {
    const cmds = [
      { name: '/deploy', description: 'Deploy app', prompt: 'Run deploy script' },
      { name: '/status', description: 'Check status' },
    ];
    act(() => {
      useSystemStore.getState().setCustomCommands(cmds);
    });
    expect(useSystemStore.getState().customCommands).toEqual(cmds);
  });
});
