import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useChatStore } from '../store/useChatStore';
import { useStreamStore } from '../store/useStreamStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react-dom/test-utils';

// Helper to access the current state
const getState = () => useChatStore.getState();
const getStreamState = () => useStreamStore.getState();

describe('useChatStore', () => {
  let mockSocket: any;

  beforeEach(() => {
    mockSocket = {
      connected: true,
      emit: vi.fn(),
      on: vi.fn(),
      off: vi.fn()
    };

    act(() => {
      useSystemStore.setState({ socket: mockSocket });
      useChatStore.setState({
        sessions: [],
        activeSessionId: null,
        inputs: {},
        isInitiallyLoaded: false,
        isUrlSyncReady: false,
        lastStatsFetchByAcp: {}
      });
      useStreamStore.setState({
        streamQueues: {},
        activeMsgIdByAcp: {},
        isProcessActiveByAcp: {},
        displayedContentByMsg: {},
        typewriterInterval: null
      });
    });
  });

  it('initializes with default state', () => {
    const state = getState();
    expect(state.sessions).toEqual([]);
    expect(state.activeSessionId).toBeNull();
  });

  describe('Session Management', () => {
    it('handleNewChat creates a new session and emits save_snapshot', () => {
      act(() => {
        getState().handleNewChat(mockSocket, 'test-ui-id');
      });

      const state = getState();
      expect(state.sessions.length).toBe(1);
      expect(state.sessions[0].id).toBe('test-ui-id');
      expect(state.activeSessionId).toBe('test-ui-id');
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.any(Object));
    });

    it('handleNewChat respects defaultModel from branding', () => {
      act(() => {
        useSystemStore.setState({ branding: { ...useSystemStore.getState().branding, models: { default: 'fast' } } });
        getState().handleNewChat(mockSocket, 'test-ui-id-fast');
      });

      const state = getState();
      expect(state.sessions.find(s => s.id === 'test-ui-id-fast')?.model).toBe('fast');
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({
        model: 'fast'
      }));
    });

    it('handleSessionSelect updates activeSessionId', () => {
      const mockSession = { id: 's1', acpSessionId: 'acp-1', name: 'Test', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false };
      act(() => {
        useChatStore.setState({ sessions: [mockSession] });
        getState().handleSessionSelect(mockSocket, 's1');
      });

      expect(getState().activeSessionId).toBe('s1');
    });

    it('handleDeleteSession removes session and pivots activeSessionId', () => {
      const s1 = { id: 's1', name: 'S1', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a1' };
      const s2 = { id: 's2', name: 'S2', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a2' };
      
      act(() => {
        useChatStore.setState({ sessions: [s1, s2], activeSessionId: 's1' });
        getState().handleDeleteSession(mockSocket, 's1');
      });

      const state = getState();
      expect(state.sessions.length).toBe(1);
      expect(state.sessions[0].id).toBe('s2');
      expect(state.activeSessionId).toBe('s2');
      expect(mockSocket.emit).toHaveBeenCalledWith('delete_session', { uiId: 's1' });
    });

    it('handleDeleteSession creates a new chat with default CWD and agent when the last session is deleted', () => {
      const s1 = { id: 's1', name: 'Last', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a1' };
      const defaultCwd = '/default/cwd';
      const defaultAgent = 'default-agent';
      
      act(() => {
        useSystemStore.setState({ workspaceCwds: [{ label: 'Work', path: defaultCwd, agent: defaultAgent }] });
        useChatStore.setState({ sessions: [s1], activeSessionId: 's1' });
        getState().handleDeleteSession(mockSocket, 's1');
      });

      const state = getState();
      expect(state.sessions.length).toBe(1);
      expect(state.sessions[0].id).not.toBe('s1');
      expect(state.sessions[0].cwd).toBe(defaultCwd);
      expect(mockSocket.emit).toHaveBeenCalledWith('create_session', expect.objectContaining({
        cwd: defaultCwd,
        agent: defaultAgent
      }), expect.any(Function));
    });

    it('handleDeleteSession keeps active session when non-active session is deleted', () => {
      const s1 = { id: 's1', name: 'S1', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a1' };
      const s2 = { id: 's2', name: 'S2', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a2' };
      act(() => {
        useChatStore.setState({ sessions: [s1, s2], activeSessionId: 's1' });
        getState().handleDeleteSession(mockSocket, 's2');
      });

      expect(getState().activeSessionId).toBe('s1');
      expect(getState().sessions.length).toBe(1);
    });

    it('handleRenameSession updates name and emits save_snapshot', () => {
      const mockSession = { id: 's1', name: 'Old Name', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' };
      act(() => {
        useChatStore.setState({ sessions: [mockSession] });
        getState().handleRenameSession(mockSocket, 's1', 'New Name');
      });

      expect(getState().sessions[0].name).toBe('New Name');
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({ name: 'New Name' }));
    });

    it('handleTogglePin updates isPinned and sorts sessions', () => {
      const s1 = { id: 's1', acpSessionId: null, name: 'S1', isPinned: false, messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false };
      const s2 = { id: 's2', acpSessionId: null, name: 'S2', isPinned: false, messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false };      
      act(() => {
        useChatStore.setState({ sessions: [s1, s2] });
        getState().handleTogglePin(mockSocket, 's2');
      });

      const state = getState();
      expect(state.sessions[0].id).toBe('s2');
      expect(state.sessions[0].isPinned).toBe(true);
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({ id: 's2', isPinned: true }));
    });

    it('handleActiveSessionModelChange updates model and emits set_session_model', () => {
      const mockSession = { id: 's1', name: 'Test', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'acp-1' };
      act(() => {
        useChatStore.setState({ sessions: [mockSession], activeSessionId: 's1' });
        getState().handleActiveSessionModelChange(mockSocket, 'flagship');
      });

      expect(getState().sessions[0].model).toBe('flagship');
      expect(mockSocket.emit).toHaveBeenCalledWith('set_session_model', { uiId: 's1', model: 'flagship' }, expect.any(Function));
    });

    it('handleSetSessionOption updates session configOptions and emits set_session_option', () => {
      const uiId = 's1';
      const optionId = 'effort';
      const value = 'high';
      act(() => {
        useChatStore.setState({
          sessions: [{ id: uiId, name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: null, configOptions: [{ id: optionId, name: 'Effort', type: 'select', currentValue: 'low' }] }]
        });
        getState().handleSetSessionOption(mockSocket, uiId, optionId, value);
      });

      expect(getState().sessions[0].configOptions?.[0].currentValue).toBe(value);
      expect(mockSocket.emit).toHaveBeenCalledWith('set_session_option', { uiId, optionId, value });
    });

    it('handleCancel emits cancel_prompt', () => {
      const acpId = 'a1';
      act(() => {
        useChatStore.setState({ 
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [], model: 'balanced', isTyping: true, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleCancel(mockSocket);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('cancel_prompt', { sessionId: acpId });
    });

    it('addAttachment and removeAttachment update state', () => {
      const uiId = 's1';
      const attachment: any = { name: 'f1' };
      act(() => {
        getState().addAttachment(uiId, attachment);
      });
      expect(getState().attachmentsMap[uiId]).toContain(attachment);
      
      act(() => {
        getState().removeAttachment(uiId, 0);
      });
      expect(getState().attachmentsMap[uiId].length).toBe(0);
    });

    it('handleRestartProcess emits restart_process', () => {
      getState().handleRestartProcess(mockSocket);
      expect(mockSocket.emit).toHaveBeenCalledWith('restart_process');
    });

    it('handleUpdateModel updates session model', () => {
      act(() => {
        useChatStore.setState({ sessions: [{ id: 's1', model: 'balanced' } as any] });
        getState().handleUpdateModel('s1', 'flagship');
      });
      expect(getState().sessions[0].model).toBe('flagship');
    });

    it('fetchStats emits get_stats and updates session stats', async () => {
      const stats = { totalTokens: 100 };
      mockSocket.emit.mockImplementation((event: string, _payload: any, cb: any) => {
        if (event === 'get_stats') cb({ stats });
      });

      act(() => {
        useChatStore.setState({ sessions: [{ id: 's1', acpSessionId: 'a1', stats: {} } as any] });
      });

      const result = await getState().fetchStats(mockSocket, 'a1');
      expect(result.stats).toEqual(stats);
      expect(getState().sessions[0].stats).toEqual(stats);
    });

    it('handleSaveSession triggers a save_snapshot', () => {
      const mockSession = { id: 's1', name: 'T', messages: [], model: 'balanced' as const, isTyping: false, isWarmingUp: false, acpSessionId: 'a1' };
      act(() => {
        useChatStore.setState({ sessions: [mockSession], activeSessionId: 's1' });
        getState().handleSaveSession(mockSocket);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({ id: 's1' }));
    });

    it('onStreamEvent updates typing and permission state', () => {
      const acpId = 'a1';
      act(() => {
        useChatStore.setState({ sessions: [{ id: 's1', acpSessionId: acpId, messages: [], isTyping: false } as any] });
        getStreamState().onStreamEvent({ sessionId: acpId, type: 'permission_request' });
      });
      expect(getState().sessions[0].isTyping).toBe(true);
      expect(getState().sessions[0].isAwaitingPermission).toBe(true);
    });
  });

  describe('Initialization & Hydration', () => {
    it('handleInitialLoad merges db sessions and selects active one from URL', () => {
      const dbSessions = [
        { id: 's1', name: 'Chat 1', messages: [] },
        { id: 's2', name: 'Chat 2', messages: [] }
      ];
      
      const urlSpy = vi.spyOn(URLSearchParams.prototype, 'get').mockReturnValue('s2');
      
      mockSocket.emit.mockImplementation((event: string, cb: any) => {
        if (event === 'load_sessions') cb({ sessions: dbSessions });
      });

      act(() => {
        getState().handleInitialLoad(mockSocket, vi.fn());
      });

      const state = getState();
      expect(state.isInitiallyLoaded).toBe(true);
      expect(state.sessions.length).toBe(2);
      expect(state.activeSessionId).toBe('s2');
      
      urlSpy.mockRestore();
    });

    it('hydrateSession filters out thought bubbles and collapses tool calls', () => {
      const uiId = 'test-ui-id';
      const acpId = 'test-acp-id';
      
      const initialMessages: any[] = [
        {
          id: 'm1', role: 'assistant', content: 'First response',
          timeline: [
            { type: 'thought', content: 'Thinking 1' },
            { type: 'tool', event: { id: 't1', title: 'Tool 1', status: 'completed' } },
            { type: 'text', content: 'First response' }
          ]
        }
      ];

      mockSocket.emit.mockImplementation((event: string, _payload: any, cb: any) => {
        if (event === 'get_session_history') cb({ session: { id: uiId, acpSessionId: acpId, model: 'balanced', messages: initialMessages } });
        else if (event === 'create_session') cb({ sessionId: acpId });
      });

      act(() => {
        useChatStore.setState({ sessions: [{ id: uiId, acpSessionId: null, name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }] });
        getState().hydrateSession(mockSocket, uiId);
      });

      const session = getState().sessions.find(s => s.id === uiId);
      expect(session).toBeDefined();
      const messages = session!.messages;
      
      const m1 = messages.find(m => m.id === 'm1')!;
      expect(m1.timeline!.some(s => s.type === 'thought')).toBe(false);
      const toolStep = m1.timeline!.find(s => s.type === 'tool') as any;
      expect(toolStep).toBeDefined();
      expect(toolStep.isCollapsed).toBe(true);
    });
  });

  describe('Streaming Actions', () => {
    const sessionId = 'acp-1';
    const uiId = 's1';

    beforeEach(() => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: uiId, acpSessionId: sessionId, name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: uiId
        });
      });
    });

    it('onStreamThought initializes thought in queue', () => {
      act(() => {
        getStreamState().onStreamThought({ sessionId, text: 'Thinking' });
      });
      expect(getStreamState().streamQueues[sessionId]).toContainEqual({ type: 'thought', data: 'Thinking' });
    });

    it('onStreamToken adds token to queue', () => {
      act(() => {
        getStreamState().onStreamToken({ sessionId, text: 'Hello' });
      });
      expect(getStreamState().streamQueues[sessionId]).toContainEqual({ type: 'token', data: 'Hello' });
    });
  });

  describe('Bug Regressions', () => {
    it('handleSubmit should clear input for target uiId when overridePrompt is used', () => {
      const uiId = 's1';
      act(() => {
        useChatStore.setState({ 
          sessions: [{ id: uiId, acpSessionId: 'a1', name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: uiId,
          inputs: { [uiId]: 'Persistent Text' }
        });
        getState().handleSubmit(mockSocket, 'Override Text');
      });

      expect(getState().inputs[uiId]).toBe('');
    });
  });

  describe('handleNewChat', () => {
    it('creates session with cwd and agent', () => {
      getState().handleNewChat(mockSocket, undefined, '/mnt/c/repos', 'agent-dev');
      expect(getState().sessions).toHaveLength(1);
      expect(getState().sessions[0].cwd).toBe('/mnt/c/repos');
      expect(getState().sessions[0].isWarmingUp).toBe(true);
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.any(Object));
      expect(mockSocket.emit).toHaveBeenCalledWith('create_session', expect.objectContaining({ cwd: '/mnt/c/repos', agent: 'agent-dev' }), expect.any(Function));
    });

    it('does not create duplicate session with same id', () => {
      getState().handleNewChat(mockSocket, 'test-id');
      getState().handleNewChat(mockSocket, 'test-id');
      expect(getState().sessions).toHaveLength(1);
    });
  });

  describe('handleSessionSelect', () => {
    it('sets active session and clears unread', () => {
      useChatStore.setState({
        sessions: [
          { id: 's1', acpSessionId: 'acp-1', name: 'Chat', messages: [{ id: 'm1', role: 'user', content: 'hi' }], model: 'flagship', isTyping: false, isWarmingUp: false, hasUnreadResponse: true }
        ]
      });
      getState().handleSessionSelect(mockSocket, 's1');
      expect(getState().activeSessionId).toBe('s1');
      expect(getState().sessions[0].hasUnreadResponse).toBe(false);
    });
  });

  describe('handleDeleteSession', () => {
    it('deletes session and selects next', () => {
      useChatStore.setState({
        sessions: [
          { id: 's1', acpSessionId: null, name: 'A', messages: [], model: 'flagship', isTyping: false, isWarmingUp: false },
          { id: 's2', acpSessionId: null, name: 'B', messages: [], model: 'flagship', isTyping: false, isWarmingUp: false }
        ],
        activeSessionId: 's1'
      });
      getState().handleDeleteSession(mockSocket, 's1');
      expect(getState().sessions).toHaveLength(1);
      expect(getState().activeSessionId).toBe('s2');
    });
  });

  describe('handleTogglePin', () => {
    it('toggles pin and sorts', () => {
      useChatStore.setState({
        sessions: [
          { id: 's1', acpSessionId: null, name: 'A', messages: [], model: 'flagship', isTyping: false, isWarmingUp: false, isPinned: false },
          { id: 's2', acpSessionId: null, name: 'B', messages: [], model: 'flagship', isTyping: false, isWarmingUp: false, isPinned: false }
        ]
      });
      getState().handleTogglePin(mockSocket, 's2');
      expect(getState().sessions[0].id).toBe('s2');
      expect(getState().sessions[0].isPinned).toBe(true);
    });
  });

  describe('onStreamToken', () => {
    it('queues token and sets isTyping', () => {
      useChatStore.setState({
        sessions: [{ id: 's1', acpSessionId: 'acp-1', name: 'Chat', messages: [{ id: 'm1', role: 'assistant', content: '' }], model: 'flagship', isTyping: false, isWarmingUp: false }],
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 'acp-1': 'm1' }
      });
      getStreamState().onStreamToken({ sessionId: 'acp-1', text: 'hello' });
      expect(getStreamState().streamQueues['acp-1']).toHaveLength(1);
      expect(getState().sessions[0].isTyping).toBe(true);
    });
  });

  describe('onStreamDone', () => {
    it('clears isTyping and saves', () => {
      useChatStore.setState({
        sessions: [{ id: 's1', acpSessionId: 'acp-1', name: 'Chat', messages: [{ id: 'm1', role: 'assistant', content: 'hi', isStreaming: true }], model: 'flagship', isTyping: true, isWarmingUp: false }],
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 'acp-1': 'm1' },
        streamQueues: {}
      });
      getStreamState().onStreamDone(mockSocket, { sessionId: 'acp-1' });
      // Wait for the interval check
      return new Promise<void>(resolve => {
        setTimeout(() => {
          expect(getState().sessions[0].isTyping).toBe(false);
          resolve();
        }, 200);
      });
    });
  });

  describe('handleUpdateModel', () => {
    it('updates model and emits save', () => {
      useChatStore.setState({
        sessions: [{ id: 's1', acpSessionId: null, name: 'Chat', messages: [], model: 'flagship', isTyping: false, isWarmingUp: false }]
      });
      getState().handleUpdateModel('s1', 'balanced');
      expect(getState().sessions[0].model).toBe('balanced');
    });
  });

  describe('handleSubmit', () => {
    it('creates user + assistant messages, emits prompt, and clears input', () => {
      const uiId = 's1';
      const acpId = 'acp-1';
      act(() => {
        useChatStore.setState({
          sessions: [{ id: uiId, acpSessionId: acpId, name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: uiId,
          inputs: { [uiId]: 'Hello world' }
        });
        getState().handleSubmit(mockSocket);
      });

      const state = getState();
      expect(state.inputs[uiId]).toBe('');
      const session = state.sessions.find(s => s.id === uiId)!;
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0].role).toBe('user');
      expect(session.messages[0].content).toBe('Hello world');
      expect(session.messages[1].role).toBe('assistant');
      expect(session.messages[1].isStreaming).toBe(true);
      expect(session.isTyping).toBe(true);
      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({ prompt: 'Hello world', sessionId: acpId }));
    });

    it('does nothing when input is empty and no attachments', () => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1',
          inputs: { 's1': '' }
        });
        getState().handleSubmit(mockSocket);
      });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('prompt', expect.anything());
    });
  });

  describe('handleRenameSession', () => {
    it('updates session name and emits save_snapshot with new name', () => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'Old', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }]
        });
        getState().handleRenameSession(mockSocket, 's1', 'Renamed');
      });
      expect(getState().sessions[0].name).toBe('Renamed');
      expect(mockSocket.emit).toHaveBeenCalledWith('save_snapshot', expect.objectContaining({ name: 'Renamed' }));
    });
  });

  describe('onStreamThought', () => {
    it('queues thought data and sets isTyping', () => {
      const acpId = 'acp-1';
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'm1', role: 'assistant', content: '', timeline: [] }], model: 'balanced', isTyping: false, isWarmingUp: false }],
        });
        useStreamStore.setState({
          activeMsgIdByAcp: { [acpId]: 'm1' }
        });
        getStreamState().onStreamThought({ sessionId: acpId, text: 'Reasoning about X' });
      });

      const streamState = getStreamState();
      expect(streamState.streamQueues[acpId]).toContainEqual({ type: 'thought', data: 'Reasoning about X' });
      expect(getState().sessions[0].isTyping).toBe(true);
    });

    it('ignores calls with no sessionId', () => {
      act(() => {
        getStreamState().onStreamThought({ sessionId: '', text: 'test' });
      });
      expect(Object.keys(getStreamState().streamQueues)).toHaveLength(0);
    });
  });

  describe('onStreamEvent', () => {
    const acpId = 'acp-1';
    beforeEach(() => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'm1', role: 'assistant', content: '', timeline: [] }], model: 'balanced', isTyping: false, isWarmingUp: false }],
        });
        useStreamStore.setState({
          activeMsgIdByAcp: { [acpId]: 'm1' }
        });
      });
    });

    it('queues tool_start event', () => {
      act(() => {
        getStreamState().onStreamEvent({ sessionId: acpId, type: 'tool_start', id: 't1', title: 'Reading file' });
      });
      const queue = getStreamState().streamQueues[acpId];
      expect(queue).toHaveLength(1);
      expect(queue[0].type).toBe('event');
      expect(queue[0].data.type).toBe('tool_start');
    });

    it('queues tool_end event', () => {
      act(() => {
        getStreamState().onStreamEvent({ sessionId: acpId, type: 'tool_end', id: 't1', title: 'Reading file', status: 'completed', output: 'done' });
      });
      const queue = getStreamState().streamQueues[acpId];
      expect(queue).toHaveLength(1);
      expect(queue[0].data.type).toBe('tool_end');
      expect(queue[0].data.status).toBe('completed');
    });

    it('tool_start event preserves id and title for timeline creation', () => {
      act(() => {
        getStreamState().onStreamEvent({ sessionId: acpId, type: 'tool_start', id: 'tool-42', title: 'Writing to disk' });
      });
      const entry = getStreamState().streamQueues[acpId][0];
      expect(entry.data.id).toBe('tool-42');
      expect(entry.data.title).toBe('Writing to disk');
    });

    it('tool_end event preserves status and output for timeline update', () => {
      act(() => {
        getStreamState().onStreamEvent({ sessionId: acpId, type: 'tool_end', id: 'tool-42', title: 'Writing to disk', status: 'failed', output: 'Permission denied' });
      });
      const entry = getStreamState().streamQueues[acpId][0];
      expect(entry.data.status).toBe('failed');
      expect(entry.data.output).toBe('Permission denied');
    });
  });

  describe('processBuffer', () => {
    it('processes token queue items and calls scrollToBottom', () => {
      const acpId = 'acp-1';
      const scrollToBottom = vi.fn();
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'm1', role: 'assistant', content: '', timeline: [], isStreaming: true }], model: 'balanced', isTyping: true, isWarmingUp: false }],
        });
        useStreamStore.setState({
          activeMsgIdByAcp: { [acpId]: 'm1' },
          streamQueues: { [acpId]: [{ type: 'token', data: 'Hi' }] }
        });
        getStreamState().processBuffer(scrollToBottom);
      });

      expect(scrollToBottom).toHaveBeenCalled();
      const msg = getState().sessions[0].messages.find(m => m.id === 'm1')!;
      expect(msg.content).toBe('H');
    });

    it('processes event queue items for tool_start', () => {
      const acpId = 'acp-1';
      const scrollToBottom = vi.fn();
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'm1', role: 'assistant', content: '', timeline: [], isStreaming: true }], model: 'balanced', isTyping: true, isWarmingUp: false }],
        });
        useStreamStore.setState({
          activeMsgIdByAcp: { [acpId]: 'm1' },
          streamQueues: { [acpId]: [{ type: 'event', data: { sessionId: acpId, type: 'tool_start', id: 't1', title: 'Read file' } }] }
        });
        getStreamState().processBuffer(scrollToBottom);
      });

      const msg = getState().sessions[0].messages.find(m => m.id === 'm1')!;
      const toolStep = msg.timeline!.find(s => s.type === 'tool');
      expect(toolStep).toBeDefined();
      if (toolStep?.type === 'tool') {
        expect(toolStep.event.status).toBe('in_progress');
      }
    });

    it('processes event queue items for tool_end', () => {
      const acpId = 'acp-1';
      const scrollToBottom = vi.fn();
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'm1', role: 'assistant', content: '', timeline: [{ type: 'tool', event: { id: 't1', title: 'Read file', status: 'in_progress' }, isCollapsed: false }], isStreaming: true }], model: 'balanced', isTyping: true, isWarmingUp: false }],
        });
        useStreamStore.setState({
          activeMsgIdByAcp: { [acpId]: 'm1' },
          streamQueues: { [acpId]: [{ type: 'event', data: { sessionId: acpId, type: 'tool_end', id: 't1', title: 'Read file', status: 'completed', output: 'done' } }] }
        });
        getStreamState().processBuffer(scrollToBottom);
      });

      const msg = getState().sessions[0].messages.find(m => m.id === 'm1')!;
      const toolStep = msg.timeline!.find(s => s.type === 'tool') as any;
      expect(toolStep.event.status).toBe('completed');
      expect(toolStep.event.output).toBe('done');
    });



  describe('handleForkSession', () => {
    it('emits fork_session event with uiId and messageIndex', () => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'Chat', messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'hello' }], model: 'flagship', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleForkSession(mockSocket, 's1', 1);
      });
      expect(mockSocket.emit).toHaveBeenCalledWith('fork_session', { uiId: 's1', messageIndex: 1 }, expect.any(Function));
    });

    it('adds new session to store on success', () => {
      mockSocket.emit.mockImplementation((event: string, _payload: any, cb: any) => {
        if (event === 'fork_session') cb({ success: true, newUiId: 'fork-1', newAcpId: 'acp-fork-1' });
        if (event === 'get_stats') cb({ stats: {} });
      });

      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'Chat', messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'hello' }], model: 'flagship', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleForkSession(mockSocket, 's1', 1);
      });

      const forked = getState().sessions.find(s => s.id === 'fork-1');
      expect(forked).toBeDefined();
      expect(getState().activeSessionId).toBe('fork-1');
    });

    it('sets forkedFrom and forkPoint on new session', () => {
      mockSocket.emit.mockImplementation((event: string, _payload: any, cb: any) => {
        if (event === 'fork_session') cb({ success: true, newUiId: 'fork-1', newAcpId: 'acp-fork-1' });
        if (event === 'get_stats') cb({ stats: {} });
      });

      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'Chat', messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'hello' }], model: 'flagship', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleForkSession(mockSocket, 's1', 1);
      });

      const forked = getState().sessions.find(s => s.id === 'fork-1')!;
      expect(forked.forkedFrom).toBe('s1');
      expect(forked.forkPoint).toBe(1);
      expect(forked.name).toBe('Chat (fork)');
      expect(forked.messages).toHaveLength(2);
    });

    it('auto-sends fork context prompt after 500ms', () => {
      vi.useFakeTimers();
      mockSocket.emit.mockImplementation((event: string, _payload: any, cb: any) => {
        if (event === 'fork_session') cb({ success: true, newUiId: 'fork-1', newAcpId: 'acp-fork-1' });
        if (event === 'get_stats') cb({ stats: {} });
      });

      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'Chat', messages: [{ id: 'm1', role: 'user', content: 'hi' }, { id: 'm2', role: 'assistant', content: 'hello' }], model: 'flagship', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleForkSession(mockSocket, 's1', 1);
      });

      act(() => {
        vi.advanceTimersByTime(500);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({
        prompt: expect.stringContaining('conversation fork'),
        sessionId: 'acp-fork-1'
      }));
      
      vi.useRealTimers();
    });
  });

    it('clears typewriterInterval when queue is empty', () => {
      const scrollToBottom = vi.fn();
      act(() => {
        useChatStore.setState({ sessions: [] });
        useStreamStore.setState({
          streamQueues: {},
          typewriterInterval: 999 as any
        });
        getStreamState().processBuffer(scrollToBottom);
      });

      expect(getStreamState().typewriterInterval).toBeNull();
    });
  });

  describe('handleFileUpload', () => {
    it('reads files and adds to attachmentsMap', async () => {
      const mockFileData = 'data:text/plain;base64,SGVsbG8=';
      const OriginalFileReader = globalThis.FileReader;
      globalThis.FileReader = class MockFileReader {
        onload: any = null;
        readAsDataURL() {
          setTimeout(() => this.onload?.({ target: { result: mockFileData } }), 0);
        }
      } as any;

      const file = new File(['Hello'], 'test.txt', { type: 'text/plain' });
      await getState().handleFileUpload([file], 's1');

      const attachments = getState().attachmentsMap['s1'];
      expect(attachments).toHaveLength(1);
      expect(attachments[0].name).toBe('test.txt');
      expect(attachments[0].data).toBe('SGVsbG8=');

      globalThis.FileReader = OriginalFileReader;
    });

    it('does nothing with null files', async () => {
      useChatStore.setState({ attachmentsMap: {} });
      await getState().handleFileUpload(null, 's1');
      expect(getState().attachmentsMap['s1'] || []).toHaveLength(0);
    });
  });

  describe('ensureAssistantMessage', () => {
    it('creates assistant message if none exists for acpSessionId', () => {
      const acpId = 'acp-1';
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
        });
        useStreamStore.setState({ activeMsgIdByAcp: {} });
        getStreamState().ensureAssistantMessage(acpId);
      });

      const session = getState().sessions[0];
      expect(session.messages).toHaveLength(1);
      expect(session.messages[0].role).toBe('assistant');
      expect(session.messages[0].isStreaming).toBe(true);
      expect(getStreamState().activeMsgIdByAcp[acpId]).toBe(session.messages[0].id);
    });

    it('does not create duplicate if active message already exists', () => {
      const acpId = 'acp-1';
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: acpId, name: 'T', messages: [{ id: 'existing', role: 'assistant', content: '', timeline: [] }], model: 'balanced', isTyping: false, isWarmingUp: false }],
        });
        useStreamStore.setState({ activeMsgIdByAcp: { [acpId]: 'existing' } });
        getStreamState().ensureAssistantMessage(acpId);
      });

      expect(getState().sessions[0].messages).toHaveLength(1);
    });
  });

  describe('handleInitialLoad with empty sessions', () => {
    it('handles empty sessions without auto-creating', () => {
      mockSocket.emit.mockImplementation((event: string, ...args: any[]) => {
        if (event === 'load_sessions') {
          const cb = args[0];
          cb({ sessions: [] });
        } else if (event === 'create_session') {
          const cb = args[args.length - 1];
          if (typeof cb === 'function') cb({ sessionId: 'new-acp' });
        }
      });

      act(() => {
        useSystemStore.setState({ workspaceCwds: [{ label: 'default', path: '/home/user' }] });
        getState().handleInitialLoad(mockSocket, vi.fn());
      });

      const state = getState();
      expect(state.isInitiallyLoaded).toBe(true);
      expect(state.sessions.length).toBe(0);
      expect(state.activeSessionId).toBeNull();
    });
  });

  describe('setAttachments', () => {
    it('sets attachments for a session', () => {
      getState().setAttachments('s1', [{ name: 'file.txt', size: 100 }]);
      expect(getState().attachmentsMap['s1']).toHaveLength(1);
    });

    it('supports updater function', () => {
      useChatStore.setState({ attachmentsMap: { 's1': [{ name: 'a.txt', size: 1 }] } });
      getState().setAttachments('s1', prev => [...prev, { name: 'b.txt', size: 2 }]);
      expect(getState().attachmentsMap['s1']).toHaveLength(2);
    });
  });

  describe('Input management', () => {
    it('setInput stores per-session input text', () => {
      getState().setInput('s1', 'hello');
      expect(getState().inputs['s1']).toBe('hello');
      getState().setInput('s2', 'world');
      expect(getState().inputs['s2']).toBe('world');
    });
  });

  describe('setActiveSessionId', () => {
    it('updates URL when isUrlSyncReady', () => {
      const replaceSpy = vi.spyOn(window.history, 'replaceState');
      act(() => { useChatStore.setState({ isUrlSyncReady: true }); });
      getState().setActiveSessionId('s1');
      expect(getState().activeSessionId).toBe('s1');
      expect(replaceSpy).toHaveBeenCalled();
      replaceSpy.mockRestore();
    });

    it('clears URL param when id is null', () => {
      const replaceSpy = vi.spyOn(window.history, 'replaceState');
      act(() => { useChatStore.setState({ isUrlSyncReady: true }); });
      getState().setActiveSessionId(null);
      expect(replaceSpy).toHaveBeenCalled();
      replaceSpy.mockRestore();
    });
  });

  describe('handleRespondPermission', () => {
    it('updates permission response and emits to socket', () => {
      const session = {
        id: 's1', acpSessionId: 'acp-1', name: 'Test', messages: [{
          id: 'm1', role: 'assistant' as const, content: '', timeline: [
            { type: 'permission' as const, request: { id: 99, toolCall: { toolCallId: 'tc-1', title: 'test' }, options: [] }, isCollapsed: false }
          ]
        }], isTyping: true, isWarmingUp: false, model: 'flagship' as const
      };
      act(() => { useChatStore.setState({ sessions: [session] }); });

      getState().handleRespondPermission(mockSocket, 99, 'allow_once', 'tool-1', 'acp-1');

      const updated = getState().sessions[0];
      expect(updated.isAwaitingPermission).toBe(false);
      expect((updated.messages[0].timeline![0] as any).response).toBe('allow_once');
      expect(mockSocket.emit).toHaveBeenCalledWith('respond_permission', expect.objectContaining({ id: 99, optionId: 'allow_once' }));
    });

    it('does nothing with null socket', () => {
      getState().handleRespondPermission(null, 99, 'allow_once');
      // No error thrown
    });
  });

  describe('handleCancel edge cases', () => {
    it('does nothing when no active session', () => {
      act(() => {
        useChatStore.setState({ sessions: [], activeSessionId: null });
        getState().handleCancel(mockSocket);
      });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('cancel_prompt', expect.anything());
    });

    it('does nothing with null socket', () => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'T', messages: [], model: 'balanced', isTyping: true, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleCancel(null);
      });
      // No error thrown, no emit
    });

    it('does nothing when session has no acpSessionId', () => {
      act(() => {
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: null, name: 'T', messages: [], model: 'balanced', isTyping: true, isWarmingUp: false }],
          activeSessionId: 's1'
        });
        getState().handleCancel(mockSocket);
      });
      expect(mockSocket.emit).not.toHaveBeenCalledWith('cancel_prompt', expect.anything());
    });
  });

  describe('Custom command interception', () => {
    it('custom command with prompt sends the prompt text instead of the command name', () => {
      act(() => {
        useSystemStore.setState({
          customCommands: [{ name: '/deploy', description: 'Deploy', prompt: 'Run the deploy pipeline now' }]
        });
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1',
          inputs: { 's1': '/deploy' }
        });
        getState().handleSubmit(mockSocket);
      });

      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({
        prompt: 'Run the deploy pipeline now'
      }));
    });

    it('custom command without prompt falls through to normal handling', () => {
      act(() => {
        useSystemStore.setState({
          customCommands: [{ name: '/status', description: 'Check status' }]
        });
        useChatStore.setState({
          sessions: [{ id: 's1', acpSessionId: 'a1', name: 'T', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false }],
          activeSessionId: 's1',
          inputs: { 's1': '/status' }
        });
        getState().handleSubmit(mockSocket);
      });

      // Falls through — sent as-is since no prompt replacement
      expect(mockSocket.emit).toHaveBeenCalledWith('prompt', expect.objectContaining({
        prompt: '/status'
      }));
    });
  });

});
