import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStreamStore } from '../store/useStreamStore';
import { useChatStore } from '../store/useChatStore';
import { useSystemStore } from '../store/useSystemStore';

// Mock stores
vi.mock('../store/useChatStore', () => ({
  useChatStore: {
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

vi.mock('../store/useSystemStore', () => ({
  useSystemStore: {
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

describe('useStreamStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamStore.setState({
      streamQueues: {},
      activeMsgIdByAcp: {},
      isProcessActiveByAcp: {},
      displayedContentByMsg: {},
      settledLengthByMsg: {},
      typewriterInterval: null,
    });
  });

  describe('ensureAssistantMessage', () => {
    it('does nothing if session not found', () => {
      (useChatStore.getState as any).mockReturnValue({ sessions: [] });
      useStreamStore.getState().ensureAssistantMessage('s1');
      expect(useStreamStore.getState().activeMsgIdByAcp['s1']).toBeUndefined();
    });

    it('creates message if it does not exist', () => {
      (useChatStore.getState as any).mockReturnValue({ sessions: [{ acpSessionId: 's1', messages: [] }] });
      useStreamStore.getState().ensureAssistantMessage('s1');
      const msgId = useStreamStore.getState().activeMsgIdByAcp['s1'];
      expect(msgId).toBeDefined();
      expect(useChatStore.setState).toHaveBeenCalled();
    });
  });

  describe('onStreamThought', () => {
    it('queues a thought', () => {
      (useChatStore.getState as any).mockReturnValue({ sessions: [{ acpSessionId: 's1', messages: [] }] });
      useStreamStore.getState().onStreamThought({ sessionId: 's1', text: 'Thinking...' });
      const queue = useStreamStore.getState().streamQueues['s1'];
      expect(queue).toHaveLength(1);
      expect(queue[0]).toEqual({ type: 'thought', data: 'Thinking...' });
    });
  });

  describe('onStreamToken', () => {
    it('queues a token and adds divider if needed', () => {
      (useChatStore.getState as any).mockReturnValue({ sessions: [{ acpSessionId: 's1', messages: [] }] });
      useStreamStore.setState({
        isProcessActiveByAcp: { 's1': true },
        activeMsgIdByAcp: { 's1': 'm1' },
        displayedContentByMsg: { 'm1': 'Some text' }
      });
      useStreamStore.getState().onStreamToken({ sessionId: 's1', text: 'more text' });
      const queue = useStreamStore.getState().streamQueues['s1'];
      expect(queue[0].data).toContain(':::RESPONSE_DIVIDER:::');
    });
  });

  describe('onStreamEvent', () => {
    it('queues an event', () => {
      (useChatStore.getState as any).mockReturnValue({ sessions: [{ acpSessionId: 's1', messages: [] }] });
      const event = { sessionId: 's1', type: 'tool_start', id: 't1', title: 'Tool' } as any;
      useStreamStore.getState().onStreamEvent(event);
      const queue = useStreamStore.getState().streamQueues['s1'];
      expect(queue[0]).toEqual({ type: 'event', data: event });
    });
  });

  describe('onStreamDone', () => {
    it('handles stream completion and flushes queue', () => {
      vi.useFakeTimers();
      (useChatStore.getState as any).mockReturnValue({ 
        sessions: [{ acpSessionId: 's1', messages: [], id: 'u1' }],
        fetchStats: vi.fn(),
      });
      (useSystemStore.getState as any).mockReturnValue({ compactingBySession: {}, notificationSound: false });
      
      useStreamStore.getState().onStreamDone(null, { sessionId: 's1' });
      
      // Fast forward time to trigger the interval check
      vi.advanceTimersByTime(100);
      
      expect(useChatStore.setState).toHaveBeenCalled();
      vi.useRealTimers();
    });
  });

  describe('processBuffer', () => {
    it('handles priority flush of non-token items', () => {
      const scrollToBottom = vi.fn();
      (useChatStore.getState as any).mockReturnValue({ 
        sessions: [{ 
          acpSessionId: 's1', 
          messages: [{ id: 'm1', timeline: [] }] 
        }] 
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 's1': 'm1' },
        streamQueues: { 's1': [
          { type: 'event', data: { type: 'tool_start', id: 't1', title: 'Tool' } },
          { type: 'thought', data: 'Hmm' }
        ] }
      });

      useStreamStore.getState().processBuffer(scrollToBottom);
      expect(useChatStore.setState).toHaveBeenCalled();
    });

    it('handles token batching and typewriter effect', () => {
      const scrollToBottom = vi.fn();
      (useChatStore.getState as any).mockReturnValue({ 
        sessions: [{ 
          acpSessionId: 's1', 
          messages: [{ id: 'm1', timeline: [] }] 
        }] 
      });
      useStreamStore.setState({
        activeMsgIdByAcp: { 's1': 'm1' },
        streamQueues: { 's1': [
          { type: 'token', data: 'Hello ' },
          { type: 'token', data: 'World' }
        ] }
      });

      useStreamStore.getState().processBuffer(scrollToBottom);
      const state = useStreamStore.getState();
      expect(state.displayedContentByMsg['m1']).toBeDefined();
    });

    it('clears interval if no queues', () => {
      const scrollToBottom = vi.fn();
      const interval = setTimeout(() => {}, 1000) as any;
      useStreamStore.setState({ typewriterInterval: interval, streamQueues: {} });
      useStreamStore.getState().processBuffer(scrollToBottom);
      expect(useStreamStore.getState().typewriterInterval).toBeNull();
    });
  });
});
