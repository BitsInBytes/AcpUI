/**
 * Multi-session streaming concurrency tests.
 *
 * Verifies that tokens, tool events, and stream lifecycle for one session
 * never bleed into another session, and that rapid session switching during
 * an active stream leaves both sessions in a consistent state.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useStreamStore } from '../store/useStreamStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';
import { useSystemStore } from '../store/useSystemStore';
import { act } from 'react';

const SESSION_A = { id: 'ui-a', acpSessionId: 'acp-a', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'p1' };
const SESSION_B = { id: 'ui-b', acpSessionId: 'acp-b', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'p1' };
const SESSION_C = { id: 'ui-c', acpSessionId: 'acp-c', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, provider: 'p1' };

// Static message IDs keep assertions deterministic under fake timers.
const MSG_A = 'static-msg-a';
const MSG_B = 'static-msg-b';
const MSG_C = 'static-msg-c';

function resetStores() {
  useStreamStore.setState({
    streamQueues: {},
    activeMsgIdByAcp: {},
    isProcessActiveByAcp: {},
    displayedContentByMsg: {},
    settledLengthByMsg: {},
    typewriterInterval: null
  });
  useSessionLifecycleStore.setState({
    sessions: [
      { ...SESSION_A },
      { ...SESSION_B },
      { ...SESSION_C }
    ] as any,
    activeSessionId: 'ui-a'
  });
  useSystemStore.setState({ compactingBySession: {}, branding: { models: {} } } as any);
}

/**
 * Pre-seeds each session with a static assistant message and activeMsgIdByAcp entry.
 * This keeps message selection deterministic for per-session routing assertions.
 */
function seedMessages() {
  const makeMsg = (id: string) => ({ id, role: 'assistant' as const, content: '', timeline: [], isStreaming: true });
  useStreamStore.setState(state => ({
    ...state,
    activeMsgIdByAcp: { 'acp-a': MSG_A, 'acp-b': MSG_B, 'acp-c': MSG_C },
    displayedContentByMsg: { [MSG_A]: '', [MSG_B]: '', [MSG_C]: '' }
  }));
  useSessionLifecycleStore.setState(state => ({
    sessions: state.sessions.map(s =>
      s.id === 'ui-a' ? { ...s, messages: [makeMsg(MSG_A)] } :
      s.id === 'ui-b' ? { ...s, messages: [makeMsg(MSG_B)] } :
      s.id === 'ui-c' ? { ...s, messages: [makeMsg(MSG_C)] } : s
    ) as any
  }));
}

describe('Multi-session stream isolation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    act(resetStores);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Token queue isolation ────────────────────────────────────────────────

  it('tokens for acp-a are queued under acp-a only — acp-b queue is unaffected', () => {
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: 'hello from A' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: ' world' });
    });

    const queues = useStreamStore.getState().streamQueues;
    expect(queues['acp-a']).toHaveLength(2);
    expect(queues['acp-b']).toBeUndefined();
    expect(queues['acp-c']).toBeUndefined();
  });

  it('tokens for two sessions are queued independently and in order', () => {
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: 'A1' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'B1' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: 'A2' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'B2' });
    });

    const queues = useStreamStore.getState().streamQueues;
    expect(queues['acp-a'].map((q: any) => q.data)).toEqual(['A1', 'A2']);
    expect(queues['acp-b'].map((q: any) => q.data)).toEqual(['B1', 'B2']);
  });

  // ── isTyping isolation ───────────────────────────────────────────────────

  it('isTyping on session A does not set isTyping on session B', () => {
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: 'streaming' });
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const a = sessions.find(s => s.id === 'ui-a')!;
    const b = sessions.find(s => s.id === 'ui-b')!;
    expect(a.isTyping).toBe(true);
    expect(b.isTyping).toBe(false);
  });

  it('both sessions can be isTyping simultaneously', () => {
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: 'A streaming' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'B streaming' });
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    expect(sessions.find(s => s.id === 'ui-a')!.isTyping).toBe(true);
    expect(sessions.find(s => s.id === 'ui-b')!.isTyping).toBe(true);
    expect(sessions.find(s => s.id === 'ui-c')!.isTyping).toBe(false);
  });

  // ── Message content isolation ────────────────────────────────────────────

  it('processBuffer writes tokens only to the correct session messages', () => {
    // Use text > 500 chars to bypass adaptive drip and trigger immediate flush
    const textA = 'response for A '.repeat(40); // 600 chars
    const textB = 'response for B '.repeat(40);
    act(seedMessages);
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: textA });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: textB });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const msgA = sessions.find(s => s.id === 'ui-a')!.messages[0];
    const msgB = sessions.find(s => s.id === 'ui-b')!.messages[0];

    expect(msgA?.content).toContain('response for A');
    expect(msgA?.content).not.toContain('response for B');
    expect(msgB?.content).toContain('response for B');
    expect(msgB?.content).not.toContain('response for A');
  });

  it('activeMsgIdByAcp maps each ACP session to the correct message placeholder', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('acp-a');
      vi.advanceTimersByTime(1);
      useStreamStore.getState().ensureAssistantMessage('acp-b');
    });

    const { activeMsgIdByAcp } = useStreamStore.getState();
    const sessions = useSessionLifecycleStore.getState().sessions;
    const msgA = sessions.find(s => s.id === 'ui-a')!.messages[0];
    const msgB = sessions.find(s => s.id === 'ui-b')!.messages[0];

    expect(activeMsgIdByAcp['acp-a']).toBeDefined();
    expect(activeMsgIdByAcp['acp-b']).toBeDefined();
    // Each acp session ID resolves to its own session's message
    expect(activeMsgIdByAcp['acp-a']).toBe(msgA?.id);
    expect(activeMsgIdByAcp['acp-b']).toBe(msgB?.id);
  });

  // ── onStreamDone isolation ───────────────────────────────────────────────

  it('onStreamDone for session A finalizes A but leaves B streaming', async () => {
    const mockSocket = { emit: vi.fn() } as any;
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('acp-a');
      useStreamStore.getState().ensureAssistantMessage('acp-b');
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'still going' });
    });

    act(() => {
      useStreamStore.getState().onStreamDone(mockSocket, { sessionId: 'acp-a' });
    });

    act(() => { vi.advanceTimersByTime(200); });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const msgA = sessions.find(s => s.id === 'ui-a')!.messages[0];
    const msgB = sessions.find(s => s.id === 'ui-b')!.messages[0];

    expect(msgA?.isStreaming).toBe(false);
    // Session B still has a streaming message (it hasn't received done)
    expect(msgB?.isStreaming).toBe(true);
  });

  // ── Rapid session switch mid-stream ──────────────────────────────────────

  it('tokens for inactive session are still queued and not lost when user switches away', () => {
    act(() => {
      // Session A is active, B starts streaming in the background
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'background chunk 1' });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'background chunk 2' });

      // User switches to C
      useSessionLifecycleStore.getState().setActiveSessionId('ui-c');

      // B keeps receiving tokens while C is active
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: 'background chunk 3' });
    });

    // All 3 chunks must be queued — none were dropped due to session being inactive
    expect(useStreamStore.getState().streamQueues['acp-b']).toHaveLength(3);
  });

  it('switching back to a session that received tokens while inactive drains correctly', () => {
    const bgText = 'background response '.repeat(30); // > 500 chars for immediate flush
    act(() => {
      // Stream B while A is active
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: bgText });
      // Switch to B
      useSessionLifecycleStore.getState().setActiveSessionId('ui-b');
      // Process buffer now that B is active
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const msgB = sessions.find(s => s.id === 'ui-b')!.messages[0];
    expect(msgB?.content).toContain('background response');
  });

  // ── Tool event isolation ─────────────────────────────────────────────────

  it('tool events for session A do not create timeline entries in session B', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('acp-a');
      useStreamStore.getState().ensureAssistantMessage('acp-b');
      useStreamStore.getState().onStreamEvent({ sessionId: 'acp-a', type: 'tool_start', id: 't1', title: 'Read file' });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const timelineA = sessions.find(s => s.id === 'ui-a')!.messages[0]?.timeline ?? [];
    const timelineB = sessions.find(s => s.id === 'ui-b')!.messages[0]?.timeline ?? [];

    expect(timelineA.some((s: any) => s.type === 'tool')).toBe(true);
    expect(timelineB.some((s: any) => s.type === 'tool')).toBe(false);
  });

  it('concurrent tool events for different sessions are tracked independently', () => {
    act(() => {
      useStreamStore.getState().ensureAssistantMessage('acp-a');
      useStreamStore.getState().ensureAssistantMessage('acp-b');
      useStreamStore.getState().onStreamEvent({ sessionId: 'acp-a', type: 'tool_start', id: 'tool-a', title: 'Tool A' });
      useStreamStore.getState().onStreamEvent({ sessionId: 'acp-b', type: 'tool_start', id: 'tool-b', title: 'Tool B' });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const toolA = (sessions.find(s => s.id === 'ui-a')!.messages[0]?.timeline ?? []).find((s: any) => s.type === 'tool') as any;
    const toolB = (sessions.find(s => s.id === 'ui-b')!.messages[0]?.timeline ?? []).find((s: any) => s.type === 'tool') as any;

    expect(toolA?.event.id).toBe('tool-a');
    expect(toolA?.event.title).toBe('Tool A');
    expect(toolB?.event.id).toBe('tool-b');
    expect(toolB?.event.title).toBe('Tool B');
  });

  // ── Three-session simultaneous streaming ─────────────────────────────────

  it('three sessions streaming simultaneously all accumulate content independently', () => {
    // Use text > 500 chars per session to bypass adaptive drip and get immediate flush
    const textA = 'Alpha content '.repeat(40);
    const textB = 'Beta content '.repeat(40);
    const textC = 'Gamma content '.repeat(40);
    act(seedMessages);
    act(() => {
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-a', text: textA });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-b', text: textB });
      useStreamStore.getState().onStreamToken({ sessionId: 'acp-c', text: textC });
      useStreamStore.getState().processBuffer(vi.fn());
    });

    const sessions = useSessionLifecycleStore.getState().sessions;
    const contentA = sessions.find(s => s.id === 'ui-a')!.messages[0]?.content ?? '';
    const contentB = sessions.find(s => s.id === 'ui-b')!.messages[0]?.content ?? '';
    const contentC = sessions.find(s => s.id === 'ui-c')!.messages[0]?.content ?? '';

    expect(contentA).toContain('Alpha content');
    expect(contentB).toContain('Beta content');
    expect(contentC).toContain('Gamma content');
    // No cross-contamination
    expect(contentA).not.toContain('Beta content');
    expect(contentA).not.toContain('Gamma content');
    expect(contentB).not.toContain('Alpha content');
    expect(contentC).not.toContain('Alpha content');
  });
});
