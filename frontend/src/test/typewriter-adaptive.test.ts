import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStreamStore } from '../store/useStreamStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

vi.mock('../store/useSessionLifecycleStore', () => ({
  useSessionLifecycleStore: {
    getState: vi.fn(),
    setState: vi.fn(),
  },
}));

describe('Typewriter Adaptive Speed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useStreamStore.setState({
      streamQueues: {},
      activeMsgIdByAcp: {},
      displayedContentByMsg: {},
      settledLengthByMsg: {},
      typewriterInterval: null,
    });
  });

  it('should increase speed when buffer is large', () => {
    const scrollToBottom = vi.fn();
    const acpId = 's1';
    const msgId = 'm1';
    
    (useSessionLifecycleStore.getState as any).mockReturnValue({ 
      sessions: [{ 
        acpSessionId: acpId, 
        messages: [{ id: msgId, timeline: [] }] 
      }] 
    });

    // Case 1: Small buffer (< 100 chars)
    const smallText = 'Hello world'; // 11 chars
    useStreamStore.setState({
      activeMsgIdByAcp: { [acpId]: msgId },
      streamQueues: { [acpId]: [{ type: 'token', data: smallText }] }
    });

    useStreamStore.getState().processBuffer(scrollToBottom);
    let displayed = useStreamStore.getState().displayedContentByMsg[msgId];
    // For 11 chars, Math.max(1, Math.ceil(11 / 5)) = 3 chars per tick
    expect(displayed.length).toBe(3);

    // Reset
    useStreamStore.setState({ displayedContentByMsg: {}, streamQueues: {} });

    // Case 2: Medium buffer (> 100 chars)
    const mediumText = 'a'.repeat(150);
    useStreamStore.setState({
      activeMsgIdByAcp: { [acpId]: msgId },
      streamQueues: { [acpId]: [{ type: 'token', data: mediumText }] }
    });

    useStreamStore.getState().processBuffer(scrollToBottom);
    displayed = useStreamStore.getState().displayedContentByMsg[msgId];
    // For 150 chars, Math.ceil(150 / 3) = 50 chars per tick
    expect(displayed.length).toBe(50);

    // Reset
    useStreamStore.setState({ displayedContentByMsg: {}, streamQueues: {} });

    // Case 3: Huge buffer (> 500 chars)
    const hugeText = 'b'.repeat(1000);
    useStreamStore.setState({
      activeMsgIdByAcp: { [acpId]: msgId },
      streamQueues: { [acpId]: [{ type: 'token', data: hugeText }] }
    });

    useStreamStore.getState().processBuffer(scrollToBottom);
    displayed = useStreamStore.getState().displayedContentByMsg[msgId];
    // For > 500 chars, it should flush everything in one tick
    expect(displayed.length).toBe(1000);
  });

  it('should drip thoughts at adaptive speed', () => {
    const scrollToBottom = vi.fn();
    const acpId = 's1';
    const msgId = 'm1';
    
    (useSessionLifecycleStore.getState as any).mockReturnValue({ 
      sessions: [{ 
        acpSessionId: acpId, 
        messages: [{ id: msgId, timeline: [] }] 
      }] 
    });

    const thoughtText = 'Thinking hard about this problem...'; // 35 chars
    useStreamStore.setState({
      activeMsgIdByAcp: { [acpId]: msgId },
      streamQueues: { [acpId]: [{ type: 'thought', data: thoughtText }] }
    });

    useStreamStore.getState().processBuffer(scrollToBottom);
    
    // Verify that useSessionLifecycleStore.setState was called with partial thought
    const lastCall = (useSessionLifecycleStore.setState as any).mock.calls.pop();
    const updater = lastCall[0];
    const mockState = { sessions: [{ acpSessionId: acpId, messages: [{ id: msgId, timeline: [] }] }] };
    const updatedSessions = (typeof updater === 'function' ? updater(mockState) : updater).sessions;
    const timeline = updatedSessions[0].messages[0].timeline;
    const thoughtStep = timeline.find((s: any) => s.type === 'thought');
    
    // For 35 chars, Math.max(1, Math.ceil(35 / 5)) = 7 chars
    expect(thoughtStep.content.length).toBe(7);
    expect(thoughtText.startsWith(thoughtStep.content)).toBe(true);
  });
});
