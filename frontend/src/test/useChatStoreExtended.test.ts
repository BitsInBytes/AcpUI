import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../store/useChatStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useInputStore } from '../store/useInputStore';
import { useStreamStore } from '../store/useStreamStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react-dom/test-utils';

const getState = () => useChatStore.getState();

describe('useChatStore Orchestration', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      connected: true,
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };

    act(() => {
      useSystemStore.setState({ socket: mockSocket, customCommands: [] } as any);
      useSessionLifecycleStore.setState({ 
        sessions: [],
        activeSessionId: null
      });
      useInputStore.setState({
        inputs: {},
        attachmentsMap: {}
      });
      useStreamStore.setState({
        activeMsgIdByAcp: {},
        isProcessActiveByAcp: {}
      });
    });
  });

  describe('handleSubmit', () => {
    it('does nothing if no activeSessionId', () => {
      act(() => {
        useSessionLifecycleStore.setState({ activeSessionId: null });
        getState().handleSubmit(mockSocket);
      });
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('does nothing if active session is warming up', () => {
      const s1 = { id: 's1', isWarmingUp: true } as any;
      act(() => {
        useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
        getState().handleSubmit(mockSocket);
      });
      expect(mockSocket.emit).not.toHaveBeenCalled();
    });

    it('uses overridePrompt and attachmentsOverride', () => {
      const s1 = { id: 's1', provider: 'p1', acpSessionId: 'a1', messages: [] } as any;
      act(() => {
        useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
        getState().handleSubmit(mockSocket, 'Override', [{ name: 'file' } as any]);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({
        prompt: 'Override',
        attachments: [{ name: 'file' }]
      }));
    });
  });

  describe('handleForkSession', () => {
    it('creates a forked session and switches to it', async () => {
      vi.useFakeTimers();
      const s1 = { 
        id: 's1', 
        name: 'Original', 
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        model: 'm1',
        currentModelId: 'm1',
        modelOptions: [],
        configOptions: [],
        provider: 'p1'
      } as any;

      mockSocket.emit.mockImplementation((event: string, _params: any, cb: any) => {
        if (event === 'fork_session') {
           cb({ success: true, newUiId: 'fork-1', newAcpId: 'acp-fork' });
        }
      });

      act(() => {
        useSessionLifecycleStore.setState({ sessions: [s1], activeSessionId: 's1' });
        getState().handleForkSession(mockSocket, 's1', 0);
      });

      const state = useSessionLifecycleStore.getState();
      expect(state.sessions).toHaveLength(2);
      expect(state.activeSessionId).toBe('fork-1');
      expect(state.sessions[1].name).toBe('Original (fork)');
      expect(state.sessions[1].forkedFrom).toBe('s1');

      // Should automatically submit acknowledgment message
      act(() => { vi.advanceTimersByTime(600); });
      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({
        prompt: expect.stringContaining('conversation fork'),
        sessionId: 'acp-fork'
      }));

      vi.useRealTimers();
    });
  });

  describe('handleRespondPermission', () => {
    it('updates specific permission step and emits save_snapshot', () => {
       const session = {
        id: 's1', acpSessionId: 'acp-1', messages: [{
          id: 'm1', role: 'assistant', timeline: [
            { type: 'permission', request: { id: 99, toolCall: {} } }
          ]
        }]
      } as any;
      act(() => { useSessionLifecycleStore.setState({ sessions: [session], activeSessionId: 's1' }); });

      getState().handleRespondPermission(mockSocket, 99, 'reject', undefined, 'acp-1');

      const updated = useSessionLifecycleStore.getState().sessions[0];
      expect((updated.messages[0].timeline![0] as any).response).toBe('reject');
      expect(mockSocket.emit).toHaveBeenCalledWith('respond_permission', expect.anything());
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.anything());
    });
  });
});
