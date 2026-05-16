import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeStreamPersistence,
  getStreamResumeSnapshot,
  mergeJsonlMessagesPreservingIds,
  mergeSnapshotWithPersisted,
  persistStreamEvent,
  shouldUseJsonlMessages
} from '../services/sessionStreamPersistence.js';
import * as db from '../database.js';

vi.mock('../database.js', () => ({
  getSessionByAcpId: vi.fn(),
  saveSession: vi.fn().mockResolvedValue(undefined)
}));

vi.mock('../services/logger.js', () => ({ writeLog: vi.fn() }));

function makeClient(meta = {}) {
  return {
    providerId: 'test-provider',
    sessionMetadata: new Map([['acp-1', { usedTokens: 0, totalTokens: 0, toolCalls: 0, successTools: 0, ...meta }]])
  };
}

function makeSession(messages) {
  return {
    id: 'ui-1',
    acpSessionId: 'acp-1',
    provider: 'test-provider',
    messages
  };
}

describe('sessionStreamPersistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists token progress into the active assistant message', async () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: '', isStreaming: true, timeline: [{ type: 'thought', content: '_Thinking..._' }] }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', { type: 'token', text: 'Hi there' }, { force: true });

    expect(db.saveSession).toHaveBeenCalledWith(expect.objectContaining({
      messages: expect.arrayContaining([
        expect.objectContaining({
          id: 'a1',
          content: 'Hi there',
          isStreaming: true,
          timeline: [expect.objectContaining({ type: 'text', content: 'Hi there' })]
        })
      ])
    }));
  });

  it('targets meta.activeAssistantMessageId when stream chunks arrive before the placeholder is persisted', async () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a-prev', role: 'assistant', content: 'previous', isStreaming: false, timeline: [{ type: 'text', content: 'previous' }] }
    ]);
    const client = makeClient({ activeAssistantMessageId: 'a-new', turnStartTime: 1700000000000 });
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(client, 'acp-1', { type: 'token', text: 'new turn' }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[1]).toEqual(expect.objectContaining({
      id: 'a-prev',
      content: 'previous',
      isStreaming: false
    }));
    expect(saved.messages[2]).toEqual(expect.objectContaining({
      id: 'a-new',
      role: 'assistant',
      content: 'new turn',
      isStreaming: true,
      turnStartTime: 1700000000000,
      timeline: [{ type: 'text', content: 'new turn' }]
    }));
  });

  it('creates a new assistant when no explicit active id exists and latest assistant is completed', async () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a-prev', role: 'assistant', content: 'already done', isStreaming: false, timeline: [{ type: 'text', content: 'already done' }] }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', { type: 'token', text: 'fresh response' }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[1]).toEqual(expect.objectContaining({
      id: 'a-prev',
      content: 'already done',
      isStreaming: false
    }));
    expect(saved.messages[2]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'fresh response',
      isStreaming: true,
      timeline: [{ type: 'text', content: 'fresh response' }]
    }));
  });

  it('reuses the latest streaming assistant when no explicit active id exists', async () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a-prev', role: 'assistant', content: 'done', isStreaming: false, timeline: [{ type: 'text', content: 'done' }] },
      { id: 'a-live', role: 'assistant', content: 'partial ', isStreaming: true, timeline: [{ type: 'text', content: 'partial ' }] }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', { type: 'token', text: 'tail' }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages).toHaveLength(3);
    expect(saved.messages[2]).toEqual(expect.objectContaining({
      id: 'a-live',
      content: 'partial tail',
      isStreaming: true,
      timeline: [{ type: 'text', content: 'partial tail' }]
    }));
  });

  it('merges tool updates by id and preserves sticky fields', async () => {
    const session = makeSession([
      { id: 'a1', role: 'assistant', content: '', isStreaming: true, timeline: [] }
    ]);
    const client = makeClient();
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(client, 'acp-1', {
      type: 'tool_start',
      id: 'tool-1',
      title: 'Edit File',
      filePath: 'D:/repo/file.ts',
      canonicalName: 'edit_file',
      isFileOperation: true
    }, { force: true });
    await persistStreamEvent(client, 'acp-1', {
      type: 'tool_end',
      id: 'tool-1',
      status: 'completed',
      output: 'done'
    }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    const tool = saved.messages[0].timeline[0].event;
    expect(tool).toEqual(expect.objectContaining({
      id: 'tool-1',
      title: 'Edit File',
      filePath: 'D:/repo/file.ts',
      canonicalName: 'edit_file',
      isFileOperation: true,
      status: 'completed',
      output: 'done'
    }));
  });

  it('finalizes the active assistant only on terminal prompt lifecycle', async () => {
    const session = makeSession([
      { id: 'a1', role: 'assistant', content: 'done', isStreaming: true, timeline: [{ type: 'text', content: 'done' }] }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await finalizeStreamPersistence(makeClient(), 'acp-1');

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[0]).toEqual(expect.objectContaining({
      isStreaming: false,
      turnEndTime: expect.any(Number)
    }));
  });

  it('finalizes the explicit active assistant from metadata', async () => {
    const session = makeSession([
      { id: 'a-old', role: 'assistant', content: 'old stream', isStreaming: true, timeline: [{ type: 'text', content: 'old stream' }] },
      { id: 'a-target', role: 'assistant', content: 'target stream', isStreaming: true, timeline: [{ type: 'text', content: 'target stream' }] }
    ]);
    const client = makeClient({ activeAssistantMessageId: 'a-target' });
    db.getSessionByAcpId.mockResolvedValue(session);

    await finalizeStreamPersistence(client, 'acp-1');

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[1]).toEqual(expect.objectContaining({
      id: 'a-target',
      isStreaming: false,
      turnEndTime: expect.any(Number)
    }));
    expect(saved.messages[0]).toEqual(expect.objectContaining({
      id: 'a-old',
      isStreaming: true
    }));
  });

  it('persists thought and permission steps and returns a cloned resume snapshot', async () => {
    const session = makeSession([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        timeline: [{
          type: 'tool',
          event: { id: 'tool-1', status: 'in_progress', output: '' },
          isCollapsed: false
        }]
      }
    ]);
    const client = makeClient({ currentModelId: 'mock-model-id', usedTokens: 12, totalTokens: 100 });
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(client, 'acp-1', { type: 'thought', text: 'checking' }, { force: true });
    await persistStreamEvent(client, 'acp-1', { type: 'permission_request', id: 'perm-1', title: 'Approve?' }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.currentModelId).toBe('mock-model-id');
    expect(saved.stats).toEqual(expect.objectContaining({ usedTokens: 12, totalTokens: 100 }));
    expect(saved.messages[0].timeline).toEqual([
      expect.objectContaining({ type: 'tool', isCollapsed: true }),
      expect.objectContaining({ type: 'thought', content: 'checking', isCollapsed: false }),
      expect.objectContaining({ type: 'permission', request: expect.objectContaining({ id: 'perm-1' }) })
    ]);

    const snapshot = await getStreamResumeSnapshot(client, 'acp-1');
    expect(snapshot).toEqual(expect.objectContaining({
      providerId: 'test-provider',
      sessionId: 'acp-1',
      uiId: 'ui-1',
      message: expect.objectContaining({ id: 'a1' })
    }));

    snapshot.message.timeline[0].event.status = 'mutated';
    expect(saved.messages[0].timeline[0].event.status).toBe('in_progress');
  });

  it('prefers meta.activeAssistantMessageId for stream resume snapshots', async () => {
    const session = makeSession([
      { id: 'a-explicit', role: 'assistant', content: 'older stream', isStreaming: true, timeline: [{ type: 'text', content: 'older stream' }] },
      { id: 'a-latest', role: 'assistant', content: 'newer stream', isStreaming: true, timeline: [{ type: 'text', content: 'newer stream' }] }
    ]);
    const client = makeClient({ activeAssistantMessageId: 'a-explicit' });
    db.getSessionByAcpId.mockResolvedValue(session);

    const snapshot = await getStreamResumeSnapshot(client, 'acp-1');

    expect(snapshot?.message?.id).toBe('a-explicit');
    expect(snapshot?.message?.content).toBe('older stream');
  });

  it('creates an active assistant message when stream progress arrives before a placeholder exists', async () => {
    const session = makeSession([
      { id: 'u1', role: 'user', content: 'hello' }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', { type: 'token', text: 'Created by backend' }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      content: 'Created by backend',
      isStreaming: true,
      timeline: [{ type: 'text', content: 'Created by backend' }]
    }));
  });

  it('finalizes with error text and fails unresolved in-progress tools', async () => {
    const session = makeSession([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        timeline: [{
          type: 'tool',
          event: { id: 'tool-1', status: 'in_progress', output: '' },
          isCollapsed: false
        }]
      }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await finalizeStreamPersistence(makeClient(), 'acp-1', { errorText: 'Prompt failed' });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    expect(saved.messages[0]).toEqual(expect.objectContaining({
      content: 'Prompt failed',
      isStreaming: false,
      timeline: [
        expect.objectContaining({
          type: 'tool',
          event: expect.objectContaining({ status: 'failed', output: 'Aborted' })
        }),
        expect.objectContaining({ type: 'text', content: 'Prompt failed' })
      ]
    }));
  });

  it('protects richer persisted assistant content from stale snapshots', () => {
    const existing = makeSession([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: 'real answer', isStreaming: true, timeline: [{ type: 'text', content: 'real answer' }] }
    ]);
    const incoming = makeSession([
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: '', isStreaming: false, timeline: [{ type: 'thought', content: '_Thinking..._' }] }
    ]);

    const merged = mergeSnapshotWithPersisted(existing, incoming);

    expect(merged.messages[1]).toEqual(expect.objectContaining({
      content: 'real answer',
      isStreaming: false,
      timeline: [{ type: 'text', content: 'real answer' }]
    }));
  });

  it('does not copy a previous assistant answer into a new blank prompt placeholder', () => {
    const existing = makeSession([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'previous answer', isStreaming: false, timeline: [{ type: 'text', content: 'previous answer' }] }
    ]);
    const incoming = makeSession([
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'previous answer', isStreaming: false, timeline: [{ type: 'text', content: 'previous answer' }] },
      { id: 'u2', role: 'user', content: 'second' },
      { id: 'a2', role: 'assistant', content: '', isStreaming: true, timeline: [{ type: 'thought', content: '_Thinking..._' }] }
    ]);

    const merged = mergeSnapshotWithPersisted(existing, incoming);

    expect(merged.messages[3]).toEqual(expect.objectContaining({
      id: 'a2',
      content: '',
      isStreaming: true
    }));
  });

  it('allows same-length JSONL repair for a low-quality latest assistant while preserving ids', () => {
    const dbMessages = [
      { id: 'u1', role: 'user', content: 'hello' },
      { id: 'a1', role: 'assistant', content: '', timeline: [{ type: 'thought', content: '_Thinking..._' }] }
    ];
    const jsonlMessages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'real answer', timeline: [{ type: 'text', content: 'real answer' }] }
    ];

    expect(shouldUseJsonlMessages(dbMessages, jsonlMessages)).toBe(true);
    expect(mergeJsonlMessagesPreservingIds(dbMessages, jsonlMessages)[1]).toEqual(expect.objectContaining({
      id: 'a1',
      content: 'real answer'
    }));
  });

  it('preserves existing message ids when JSONL adds newer messages', () => {
    const dbMessages = [
      { id: 'u1', role: 'user', content: 'first' },
      { id: 'a1', role: 'assistant', content: 'partial', timeline: [{ type: 'text', content: 'partial' }] }
    ];
    const jsonlMessages = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'complete', timeline: [{ type: 'text', content: 'complete' }] },
      { role: 'user', content: 'follow-up' },
      { role: 'assistant', content: 'second answer', timeline: [{ type: 'text', content: 'second answer' }] }
    ];

    const merged = mergeJsonlMessagesPreservingIds(dbMessages, jsonlMessages);

    expect(merged).toHaveLength(4);
    expect(merged[0]).toEqual(expect.objectContaining({ id: 'u1', content: 'first' }));
    expect(merged[1]).toEqual(expect.objectContaining({ id: 'a1', content: 'complete' }));
    expect(merged[2].id).toBeUndefined();
    expect(merged[3].id).toBeUndefined();
  });

  it('preserves sticky sub-agent tool metadata when merging same-length JSONL messages', () => {
    const dbMessages = [
      { id: 'u1', role: 'user', content: 'spawn agents' },
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        timeline: [{
          type: 'tool',
          event: {
            id: 'tool-1',
            title: 'Invoke Subagents',
            status: 'completed',
            invocationId: 'inv-1',
            toolName: 'ux_invoke_subagents',
            canonicalName: 'ux_invoke_subagents',
            mcpToolName: 'ux_invoke_subagents',
            isAcpUxTool: true,
            toolCategory: 'sub_agent'
          }
        }]
      }
    ];
    const jsonlMessages = [
      { role: 'user', content: 'spawn agents' },
      {
        role: 'assistant',
        content: 'done',
        timeline: [{ type: 'tool', event: { id: 'tool-1', title: 'Invoke Subagents', status: 'completed' } }, { type: 'text', content: 'done' }]
      }
    ];

    const merged = mergeJsonlMessagesPreservingIds(dbMessages, jsonlMessages);
    expect(merged[1].timeline[0].event).toEqual(expect.objectContaining({
      invocationId: 'inv-1',
      toolName: 'ux_invoke_subagents',
      canonicalName: 'ux_invoke_subagents',
      mcpToolName: 'ux_invoke_subagents',
      isAcpUxTool: true,
      toolCategory: 'sub_agent'
    }));
  });

  it('lets terminal shell output replace an in-progress shell tool step', async () => {
    const session = makeSession([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        timeline: [{
          type: 'tool',
          event: {
            id: 'tool-1',
            title: 'Invoke Shell: Check Node',
            status: 'in_progress',
            shellRunId: 'shell-run-1',
            output: '',
            shellState: 'running'
          }
        }]
      }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', {
      type: 'tool_end',
      id: 'tool-1',
      status: 'completed',
      shellRunId: 'shell-run-1',
      shellState: 'exited',
      shellNeedsInput: false,
      output: 'v22.1.0'
    }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    const tool = saved.messages[0].timeline[0].event;
    expect(tool).toEqual(expect.objectContaining({
      status: 'completed',
      shellState: 'exited',
      shellNeedsInput: false,
      output: 'v22.1.0',
      endTime: expect.any(Number)
    }));
  });

  it('does not erase existing shell transcript when terminal completion has blank output', async () => {
    const session = makeSession([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        timeline: [{
          type: 'tool',
          event: {
            id: 'tool-1',
            title: 'Invoke Shell: Test',
            status: 'in_progress',
            shellRunId: 'shell-run-1',
            shellState: 'running',
            output: '$ npm test\nPASS\n'
          }
        }]
      }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', {
      type: 'tool_end',
      id: 'tool-1',
      status: 'completed',
      shellRunId: 'shell-run-1',
      output: ''
    }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    const tool = saved.messages[0].timeline[0].event;
    expect(tool).toEqual(expect.objectContaining({
      status: 'completed',
      shellState: 'exited',
      output: '$ npm test\nPASS\n'
    }));
  });

  it('marks a terminal shell tool as exited when the completion event has no shell state', async () => {
    const session = makeSession([
      {
        id: 'a1',
        role: 'assistant',
        content: '',
        isStreaming: true,
        timeline: [{
          type: 'tool',
          event: {
            id: 'tool-1',
            title: 'Invoke Shell: Check Node',
            status: 'in_progress',
            shellRunId: 'shell-run-1',
            shellState: 'running',
            shellNeedsInput: true,
            output: ''
          }
        }]
      }
    ]);
    db.getSessionByAcpId.mockResolvedValue(session);

    await persistStreamEvent(makeClient(), 'acp-1', {
      type: 'tool_end',
      id: 'tool-1',
      status: 'completed',
      output: 'v22.1.0',
      toolCategory: 'shell',
      isShellCommand: true
    }, { force: true });

    const saved = db.saveSession.mock.calls.at(-1)[0];
    const tool = saved.messages[0].timeline[0].event;
    expect(tool).toEqual(expect.objectContaining({
      status: 'completed',
      shellState: 'exited',
      shellNeedsInput: false,
      output: 'v22.1.0'
    }));
  });

  it('does not replace DB terminal tool output with weaker same-length JSONL', () => {
    const dbMessages = [
      { id: 'u1', role: 'user', content: 'node version' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'The Node version is v22.1.0.',
        timeline: [
          { type: 'tool', event: { id: 'tool-1', status: 'completed', output: 'v22.1.0' } },
          { type: 'text', content: 'The Node version is v22.1.0.' }
        ]
      }
    ];
    const jsonlMessages = [
      { role: 'user', content: 'node version' },
      { role: 'assistant', content: 'The Node version is v22.1.0.'.repeat(20), timeline: [{ type: 'text', content: 'The Node version is v22.1.0.'.repeat(20) }] }
    ];

    expect(shouldUseJsonlMessages(dbMessages, jsonlMessages)).toBe(false);
  });
});
