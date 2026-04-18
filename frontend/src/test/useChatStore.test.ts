import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../store/useChatStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useInputStore } from '../store/useInputStore';
import { useStreamStore } from '../store/useStreamStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react-dom/test-utils';

const getState = () => useChatStore.getState();

describe('useChatStore (Orchestrator)', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      connected: true,
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };

    act(() => {
      useSystemStore.setState({ socket: mockSocket, customCommands: [] });
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
    it('creates messages and emits prompt', () => {
      const uiId = 's1';
      const acpId = 'acp-1';
      const session = { id: uiId, acpSessionId: acpId, messages: [], provider: 'p1', model: 'm1' } as any;
      
      act(() => {
        useSessionLifecycleStore.setState({ sessions: [session], activeSessionId: uiId });
        useInputStore.getState().setInput(uiId, 'Hello');
        getState().handleSubmit(mockSocket);
      });

      expect(useSessionLifecycleStore.getState().sessions[0].messages).toHaveLength(2);
      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({ prompt: 'Hello', sessionId: acpId }));
      expect(useInputStore.getState().inputs[uiId]).toBe(''); // cleared
    });

    it('intercepts custom commands with prompt', () => {
      const uiId = 's1';
      const acpId = 'acp-1';
      const session = { id: uiId, acpSessionId: acpId, messages: [], provider: 'p1', model: 'm1' } as any;
      
      act(() => {
        useSystemStore.setState({ customCommands: [{ name: '/test', description: 'Test Command', prompt: 'Real Prompt' }] });
        useSessionLifecycleStore.setState({ sessions: [session], activeSessionId: uiId });
        useInputStore.getState().setInput(uiId, '/test');
        getState().handleSubmit(mockSocket);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({ prompt: 'Real Prompt' }));
    });
  });

  describe('handleCancel', () => {
    it('emits cancel_prompt', () => {
      const acpId = 'a1';
      act(() => {
        useSessionLifecycleStore.setState({ sessions: [{ id: 's1', acpSessionId: acpId, provider: 'p1' } as any], activeSessionId: 's1' });
        getState().handleCancel(mockSocket);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('cancel_prompt', { providerId: 'p1', sessionId: acpId });
    });
  });

  describe('handleRespondPermission', () => {
    it('updates permission step and emits to socket', () => {
      const session = {
        id: 's1', acpSessionId: 'acp-1', messages: [{
          id: 'm1', role: 'assistant', timeline: [
            { type: 'permission', request: { id: 99, toolCall: { toolCallId: 't1' } } }
          ]
        }]
      } as any;
      act(() => { useSessionLifecycleStore.setState({ sessions: [session] }); });

      getState().handleRespondPermission(mockSocket, 99, 'allow', 't1', 'acp-1');

      const updated = useSessionLifecycleStore.getState().sessions[0];
      expect((updated.messages[0].timeline![0] as any).response).toBe('allow');
      expect(mockSocket.emit).toHaveBeenCalledWith('respond_permission', expect.objectContaining({ id: 99 }));
    });
  });
});
