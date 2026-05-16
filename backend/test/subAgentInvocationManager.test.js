import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SubAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

async function flushMicrotasks(times = 5) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

function snapshotFromManager(manager, invocationId) {
  const inv = manager.invocations.get(invocationId);
  if (!inv) return null;
  return {
    provider: inv.providerId,
    invocationId: inv.invocationId,
    parentAcpSessionId: inv.parentAcpSessionId,
    parentUiId: inv.parentUiId,
    status: inv.status,
    statusToolName: inv.statusToolName,
    totalCount: inv.requests.length,
    completedCount: [...inv.agents.values()].filter(agent => agent.status === 'completed').length,
    agents: [...inv.agents.values()].map(agent => ({
      acpSessionId: agent.acpId,
      uiId: agent.uiId,
      index: agent.index,
      name: agent.name,
      status: agent.status,
      resultText: agent.response,
      errorText: agent.error
    }))
  };
}

describe('SubAgentInvocationManager', () => {
  let deps;
  let manager;
  let mockIo;
  let mockDb;
  let mockAcpClient;
  let savedSessions;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIo = { emit: vi.fn(), fetchSockets: vi.fn().mockResolvedValue([]) };
    savedSessions = new Map();
    mockDb = {
      getSessionByAcpId: vi.fn().mockImplementation(async (...args) => {
        const acpId = args.length === 2 ? args[1] : args[0];
        if (acpId === 'parent-acp') return { id: 'parent-ui' };
        return savedSessions.get(acpId) || null;
      }),
      getAllSessions: vi.fn().mockResolvedValue([]),
      saveSession: vi.fn().mockImplementation(async (session) => {
        if (session?.acpSessionId) savedSessions.set(session.acpSessionId, JSON.parse(JSON.stringify(session)));
      }),
      deleteSession: vi.fn().mockResolvedValue(),
      getActiveSubAgentInvocationForParent: vi.fn().mockResolvedValue(null),
      createSubAgentInvocation: vi.fn().mockResolvedValue(),
      addSubAgentInvocationAgent: vi.fn().mockResolvedValue(),
      updateSubAgentInvocationStatus: vi.fn().mockResolvedValue(),
      updateSubAgentInvocationAgentStatus: vi.fn().mockResolvedValue(),
      getSubAgentInvocationWithAgents: vi.fn().mockResolvedValue(null),
      deleteSubAgentInvocationsForParent: vi.fn().mockResolvedValue()
    };
    mockAcpClient = {
      providerId: 'provider-a',
      getProviderId: vi.fn().mockReturnValue('provider-a'),
      _sessionStreamPersistenceDb: mockDb,
      transport: {
        sendRequest: vi.fn().mockImplementation(async (method) => {
          if (method === 'session/new') return { sessionId: 'sub-acp-1' };
          if (method === 'session/prompt') {
            const meta = mockAcpClient.sessionMetadata.get('sub-acp-1');
            if (meta) meta.lastResponseBuffer = 'test response';
            return {};
          }
          return {};
        }),
      },
      sessionMetadata: new Map(),
      lastSubAgentParentAcpId: 'parent-acp'
    };

    deps = {
      io: mockIo,
      db: mockDb,
      acpClientFactory: vi.fn().mockReturnValue(mockAcpClient),
      getProvider: vi.fn().mockReturnValue({ id: 'provider-a', config: { defaultSubAgentName: 'dev', models: {} } }),
      getProviderModule: vi.fn().mockResolvedValue({
        buildSessionParams: vi.fn().mockReturnValue({}),
        setInitialAgent: vi.fn().mockResolvedValue()
      }),
      log: vi.fn(),
      now: vi.fn().mockReturnValue(12345),
      cleanupFn: vi.fn(),
      bindMcpProxyFn: vi.fn(),
      getMcpServersFn: vi.fn().mockReturnValue([]),
      resolveModelSelectionFn: vi.fn().mockReturnValue({ modelId: 'test-model' }),
      modelOptionsFromProviderConfigFn: vi.fn().mockReturnValue([])
    };

    manager = new SubAgentInvocationManager(deps);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('starts asynchronously and returns completed results through the status call', async () => {
    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    await vi.runAllTimersAsync();
    const result = await resultPromise;
    expect(result.content[0].text).toContain('ux_check_subagents');
    expect(result.content[0].text).toContain('ux_abort_subagents');
    expect(result.content[0].text).toContain('waitForCompletion');

    await flushMicrotasks();
    expect(deps.cleanupFn).toHaveBeenCalledWith('sub-acp-1', 'provider-a');

    const invocationId = [...manager.invocations.keys()][0];
    mockDb.getSubAgentInvocationWithAgents.mockImplementation((_providerId, id) => snapshotFromManager(manager, id));
    const status = await manager.getInvocationStatus({ providerId: 'provider-a', invocationId, waitTimeoutMs: 0 });
    expect(status.content[0].text).toContain('test response');
    expect(status.content[0].text).toContain('completed');
  });

  it('persists the sub-agent prompt and finalizes the child transcript', async () => {
    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    await vi.runAllTimersAsync();
    await resultPromise;
    await flushMicrotasks();

    const saved = savedSessions.get('sub-acp-1');
    expect(saved.messages[0]).toEqual(expect.objectContaining({ role: 'user', content: 'do task' }));
    expect(saved.messages[1]).toEqual(expect.objectContaining({ role: 'assistant', isStreaming: false }));
    expect(saved.messages[1].timeline).not.toContainEqual(expect.objectContaining({ content: '_Thinking..._' }));
  });

  it('returns active status immediately with non-wait and abort instructions', async () => {
    mockDb.getSubAgentInvocationWithAgents.mockResolvedValue({
      provider: 'provider-a',
      invocationId: 'inv-active',
      status: 'running',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      completedCount: 0,
      agents: [{ acpSessionId: 'sub-acp-1', index: 0, name: 'agent 1', status: 'running' }]
    });

    const result = await manager.getInvocationStatus({ providerId: 'provider-a', invocationId: 'inv-active', waitTimeoutMs: 0 });

    expect(result.content[0].text).toContain('Still running');
    expect(result.content[0].text).toContain('waitForCompletion');
    expect(result.content[0].text).toContain('ux_abort_subagents');
  });

  it('formats cancelled agents as aborted in status output', async () => {
    mockDb.getSubAgentInvocationWithAgents.mockResolvedValue({
      provider: 'provider-a',
      invocationId: 'inv-aborted',
      status: 'cancelled',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      completedCount: 0,
      agents: [{ acpSessionId: 'sub-acp-1', index: 0, name: 'agent 1', status: 'cancelled' }]
    });

    const result = await manager.getInvocationStatus({ providerId: 'provider-a', invocationId: 'inv-aborted', waitTimeoutMs: 0 });

    expect(result.content[0].text).toContain('Aborted agents');
    expect(result.content[0].text).toContain('ux_abort_subagents');
  });

  it('returns a clear message when status is requested for a missing invocation', async () => {
    mockDb.getSubAgentInvocationWithAgents.mockResolvedValue(null);

    const result = await manager.getInvocationStatus({ providerId: 'provider-a', invocationId: 'inv-missing', waitTimeoutMs: 0 });

    expect(result.content[0].text).toContain('Sub-agent invocation not found');
    expect(result.content[0].text).toContain('inv-missing');
  });

  it('cancels a DB-backed invocation when it is no longer in memory', async () => {
    mockDb.getSubAgentInvocationWithAgents.mockResolvedValue({
      provider: 'provider-a',
      invocationId: 'inv-db',
      status: 'running',
      totalCount: 2,
      completedCount: 1,
      agents: [
        { acpSessionId: 'sub-complete', status: 'completed' },
        { acpSessionId: 'sub-running', status: 'running' }
      ]
    });

    await manager.cancelInvocation('provider-a', 'inv-db');

    expect(mockDb.updateSubAgentInvocationStatus).toHaveBeenCalledWith('provider-a', 'inv-db', 'cancelled', expect.objectContaining({
      totalCount: 2,
      completedCount: 1,
      completedAt: 12345
    }));
    expect(mockDb.updateSubAgentInvocationAgentStatus).toHaveBeenCalledTimes(1);
    expect(mockDb.updateSubAgentInvocationAgentStatus).toHaveBeenCalledWith('provider-a', 'inv-db', 'sub-running', expect.objectContaining({
      status: 'cancelled',
      errorText: 'Cancelled',
      completedAt: 12345
    }));
  });

  it('cleans prior sub-agent sessions, attachments, and invocation rows for a parent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-subagent-cleanup-'));
    const attachmentsRoot = path.join(root, 'provider-a');
    const attachmentDir = path.join(attachmentsRoot, 'sub-ui-old');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'note.txt'), 'old attachment', 'utf8');
    manager.getAttachmentsRootFn = vi.fn().mockReturnValue(attachmentsRoot);
    mockDb.getAllSessions.mockResolvedValue([
      { id: 'sub-ui-old', acpSessionId: 'sub-acp-old', isSubAgent: true, forkedFrom: 'parent-ui', provider: 'provider-a' },
      { id: 'regular-ui', acpSessionId: 'regular-acp', isSubAgent: false, forkedFrom: 'parent-ui', provider: 'provider-a' },
      { id: 'other-sub-ui', acpSessionId: 'other-sub-acp', isSubAgent: true, forkedFrom: 'other-parent', provider: 'provider-a' }
    ]);

    try {
      await manager.cleanupPreviousInvocationsForParent('provider-a', 'parent-ui');

      expect(deps.cleanupFn).toHaveBeenCalledWith('sub-acp-old', 'provider-a', 'subagent-replacement');
      expect(mockDb.deleteSession).toHaveBeenCalledWith('sub-ui-old');
      expect(mockDb.deleteSession).not.toHaveBeenCalledWith('regular-ui');
      expect(mockDb.deleteSession).not.toHaveBeenCalledWith('other-sub-ui');
      expect(mockDb.deleteSubAgentInvocationsForParent).toHaveBeenCalledWith('provider-a', 'parent-ui');
      expect(fs.existsSync(attachmentDir)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('joins an active invocation when the idempotency key repeats', async () => {
    const first = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      idempotencyKey: 'repeat-key-active'
    });

    const second = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      idempotencyKey: 'repeat-key-active'
    });

    await vi.runAllTimersAsync();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.content[0].text).toContain('ux_check_subagents');
    expect(secondResult.content[0].text).toContain('ux_check_subagents');
    expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
  });

  it('returns a cached result when a completed invocation key repeats', async () => {
    const args = {
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      idempotencyKey: 'repeat-key-completed'
    };

    const first = manager.runInvocation(args);
    await vi.runAllTimersAsync();
    const firstResult = await first;
    const secondResult = await manager.runInvocation(args);

    expect(firstResult.content[0].text).toContain('ux_check_subagents');
    expect(secondResult).toEqual(firstResult);
    expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
  });

  it('prunes completed invocation and idempotency entries after TTL while preserving active idempotency promises', () => {
    let nowValue = 1_000;
    manager = new SubAgentInvocationManager({
      ...deps,
      now: () => nowValue,
      completedInvocationTtlMs: 50,
      completedInvocationMaxEntries: 10,
      idempotencyTtlMs: 50,
      idempotencyMaxEntries: 10
    });

    manager.invocations.set('inv-old', {
      invocationId: 'inv-old',
      providerId: 'provider-a',
      status: 'completed',
      completedAt: 900,
      waiters: new Set()
    });
    manager.idempotentInvocations.set('key-old', { result: { ok: true }, completedAt: 900 });
    manager.idempotentInvocations.set('key-active', { promise: Promise.resolve({ ok: true }), startedAt: 900 });

    nowValue = 1_000;
    manager.pruneCompletedState();

    expect(manager.invocations.has('inv-old')).toBe(false);
    expect(manager.idempotentInvocations.has('key-old')).toBe(false);
    expect(manager.idempotentInvocations.has('key-active')).toBe(true);
  });

  it('prunes oldest completed invocation and idempotency entries when max-size limits are exceeded', () => {
    manager = new SubAgentInvocationManager({
      ...deps,
      now: () => 250,
      completedInvocationTtlMs: 10_000,
      completedInvocationMaxEntries: 1,
      idempotencyTtlMs: 10_000,
      idempotencyMaxEntries: 1
    });

    manager.invocations.set('inv-old', {
      invocationId: 'inv-old',
      providerId: 'provider-a',
      status: 'completed',
      completedAt: 100,
      waiters: new Set()
    });
    manager.invocations.set('inv-new', {
      invocationId: 'inv-new',
      providerId: 'provider-a',
      status: 'completed',
      completedAt: 200,
      waiters: new Set()
    });

    manager.idempotentInvocations.set('key-old', { result: { ok: true }, completedAt: 100 });
    manager.idempotentInvocations.set('key-new', { result: { ok: true }, completedAt: 200 });

    manager.pruneCompletedState();

    expect(manager.invocations.has('inv-old')).toBe(false);
    expect(manager.invocations.has('inv-new')).toBe(true);
    expect(manager.idempotentInvocations.has('key-old')).toBe(false);
    expect(manager.idempotentInvocations.has('key-new')).toBe(true);
  });

  it('reports the active invocation instead of starting another batch for the same parent chat', async () => {
    mockDb.getActiveSubAgentInvocationForParent.mockResolvedValueOnce({
      invocationId: 'inv-active',
      statusToolName: 'ux_check_subagents',
      status: 'running',
      completedCount: 1,
      totalCount: 2
    });

    const result = await manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp'
    });

    expect(result.content[0].text).toContain('already has sub-agents running');
    expect(result.content[0].text).toContain('inv-active');
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalledWith('session/new', expect.anything());
  });

  it('persists a parent invocation marker without a parent tool call id', async () => {
    mockDb.getSessionByAcpId.mockImplementation(async (...args) => {
      const acpId = args.length === 2 ? args[1] : args[0];
      if (acpId === 'parent-acp') {
        return {
          id: 'parent-ui',
          acpSessionId: 'parent-acp',
          provider: 'provider-a',
          messages: [{ id: 'assistant-1', role: 'assistant', content: '', timeline: [] }]
        };
      }
      return savedSessions.get(acpId) || null;
    });

    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp'
    });

    await vi.runAllTimersAsync();
    await resultPromise;

    const savedParent = savedSessions.get('parent-acp');
    const marker = savedParent?.messages?.[0]?.timeline?.find(step => step.type === 'tool')?.event;
    expect(marker).toEqual(expect.objectContaining({
      id: expect.stringMatching(/^subagents-inv-12345-/),
      invocationId: expect.stringMatching(/^inv-12345-/),
      toolName: 'ux_invoke_subagents',
      canonicalName: 'ux_invoke_subagents',
      status: 'completed'
    }));
    expect(savedParent?.messages?.[0]?.isStreaming).not.toBe(true);
  });

  it('cleans active idempotency state when invocation setup rejects', async () => {
    mockDb.getSessionByAcpId.mockRejectedValueOnce(new Error('lookup failed'));

    await expect(manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      idempotencyKey: 'reject-key'
    })).rejects.toThrow('lookup failed');

    expect(manager.idempotentInvocations.has('reject-key')).toBe(false);
  });

  it('uses explicit parent ACP session before stale client parent tracking', async () => {
    mockAcpClient.lastSubAgentParentAcpId = 'stale-parent-acp';

    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'explicit-parent-acp'
    });

    await vi.runAllTimersAsync();
    await resultPromise;

    expect(mockDb.getSessionByAcpId).toHaveBeenCalledWith('provider-a', 'explicit-parent-acp');
    expect(mockDb.getSessionByAcpId).not.toHaveBeenCalledWith('provider-a', 'stale-parent-acp');
  });

  it('cancelAllForParent calls abortFn and sends session/cancel to sub-agents', async () => {
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'sub-acp-1' };
      if (method === 'session/prompt') return new Promise(() => {}); // hang
      return {};
    });
    
    const runPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    // Let session/new start
    await vi.advanceTimersByTimeAsync(10);
    
    mockAcpClient.transport.sendNotification = vi.fn();
    const rejectFn = vi.fn();
    mockAcpClient.transport.pendingRequests = new Map([
      ['1', { params: { sessionId: 'sub-acp-1' }, reject: rejectFn }]
    ]);

    await manager.cancelAllForParent('parent-acp', 'provider-a');

    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sub-acp-1' });
    expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));

    await vi.runAllTimersAsync();
    const result = await runPromise;
    expect(result.content[0].text).toContain('ux_check_subagents');
  });

  it('cancelAllForParent cascades through nested sub-agent invocations', async () => {
    mockAcpClient.transport.sendNotification = vi.fn();
    const directAbort = vi.fn();
    const nestedAbort = vi.fn();
    const deepAbort = vi.fn();

    manager.trackSubAgentParent('provider-a', 'child-acp', 'parent-acp');
    manager.trackSubAgentParent('provider-a', 'grandchild-acp', 'child-acp');
    manager.trackSubAgentParent('provider-a', 'great-grandchild-acp', 'grandchild-acp');

    manager.invocations.set('inv-direct', {
      invocationId: 'inv-direct',
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      agents: new Map([['child-acp', { acpId: 'child-acp', status: 'running' }]]),
      abortFn: directAbort
    });
    manager.invocations.set('inv-nested', {
      invocationId: 'inv-nested',
      providerId: 'provider-a',
      parentAcpSessionId: 'child-acp',
      agents: new Map([['grandchild-acp', { acpId: 'grandchild-acp', status: 'running' }]]),
      abortFn: nestedAbort
    });
    manager.invocations.set('inv-deep', {
      invocationId: 'inv-deep',
      providerId: 'provider-a',
      parentAcpSessionId: 'grandchild-acp',
      agents: new Map([['great-grandchild-acp', { acpId: 'great-grandchild-acp', status: 'running' }]]),
      abortFn: deepAbort
    });

    await manager.cancelAllForParent('parent-acp', 'provider-a');

    expect(directAbort).toHaveBeenCalled();
    expect(nestedAbort).toHaveBeenCalled();
    expect(deepAbort).toHaveBeenCalled();
    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'child-acp' });
    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'grandchild-acp' });
    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'great-grandchild-acp' });
  });

  it('aborts and cancels sub-agents when the tool call abort signal fires during setup', async () => {
    let created = 0;
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') {
        created += 1;
        return { sessionId: `sub-acp-${created}` };
      }
      if (method === 'session/prompt') return new Promise(() => {}); // hang
      return {};
    });
    mockAcpClient.transport.sendNotification = vi.fn();
    const controller = new AbortController();

    const runPromise = manager.runInvocation({
      requests: [
        { prompt: 'do task', name: 'agent 1' },
        { prompt: 'do more', name: 'agent 2' }
      ],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      abortSignal: controller.signal
    });

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await flushMicrotasks();

    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sub-acp-1' });

    await vi.runAllTimersAsync();
    const result = await runPromise;
    expect(result.content[0].text).toContain('ux_check_subagents');
    expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
  });

  it('cancelAllForParent handles errors when sending notification', async () => {
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'sub-acp-1' };
      if (method === 'session/prompt') return new Promise(() => {}); // hang
      return {};
    });
    
    manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    await vi.advanceTimersByTimeAsync(10);
    
    mockAcpClient.transport.sendNotification = vi.fn().mockImplementation(() => {
      throw new Error('Send failed');
    });

    await manager.cancelAllForParent('parent-acp', 'provider-a');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Error sending cancel to sub-agent sub-acp-1: Send failed'));
  });

  it('trackSubAgentParent ignores calls with any null/undefined argument', () => {
    manager.trackSubAgentParent(null, 'child-acp', 'parent-acp');
    manager.trackSubAgentParent('provider-a', null, 'parent-acp');
    manager.trackSubAgentParent('provider-a', 'child-acp', null);
    manager.trackSubAgentParent(undefined, 'child-acp', 'parent-acp');
    expect(manager.subAgentParentLinks.size).toBe(0);
  });

  it('cancelInvocationRecord is idempotent - double-cancel does not re-trigger abortFn', async () => {
    const abortFn = vi.fn();
    const inv = {
      invocationId: 'inv-idempotent',
      providerId: 'provider-a',
      status: 'running',
      agents: new Map(),
      abortFn,
      completedAt: null
    };

    await manager.cancelInvocationRecord(inv);
    expect(abortFn).toHaveBeenCalledTimes(1);
    expect(inv.status).toBe('cancelled');

    await manager.cancelInvocationRecord(inv);
    expect(abortFn).toHaveBeenCalledTimes(1); // not called again
    expect(inv.status).toBe('cancelled');
  });

  it('collectDescendantAcpSessionIds returns an empty set when parentAcpSessionId is null', () => {
    manager.trackSubAgentParent('provider-a', 'child-acp', 'some-parent');
    const result = manager.collectDescendantAcpSessionIds(null, 'provider-a');
    expect(result.size).toBe(0);
  });

  it('collectDescendantAcpSessionIds excludes sessions from a different provider', () => {
    manager.trackSubAgentParent('provider-a', 'child-a', 'parent-acp');
    manager.trackSubAgentParent('provider-b', 'child-b', 'parent-acp');

    const result = manager.collectDescendantAcpSessionIds('parent-acp', 'provider-a');
    expect(result.has('parent-acp')).toBe(true);
    expect(result.has('child-a')).toBe(true);
    expect(result.has('child-b')).toBe(false);
  });

  it('immediately aborts when abortSignal is already aborted before spawning starts', async () => {
    mockAcpClient.transport.sendNotification = vi.fn();
    const controller = new AbortController();
    controller.abort(); // already aborted before runInvocation is called

    const runPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      abortSignal: controller.signal
    });

    await vi.runAllTimersAsync();
    const result = await runPromise;

    expect(result.content[0].text).toContain('ux_check_subagents');
    // No ACP session should have been created — the abort fires before any spawn
    expect(mockAcpClient.transport.sendRequest).not.toHaveBeenCalledWith('session/new', expect.anything());
  });

  it('collectDescendantAcpSessionIds includes agents from child invocations without explicit parent links', () => {
    manager.trackSubAgentParent('provider-a', 'child-acp', 'parent-acp');
    manager.invocations.set('inv-child', {
      invocationId: 'inv-child',
      providerId: 'provider-a',
      parentAcpSessionId: 'child-acp',
      agents: new Map([['agent-acp', { acpId: 'agent-acp', status: 'running' }]])
    });

    const result = manager.collectDescendantAcpSessionIds('parent-acp', 'provider-a');

    expect(result.has('parent-acp')).toBe(true);
    expect(result.has('child-acp')).toBe(true);
    expect(result.has('agent-acp')).toBe(true);
  });

  it('records setup failure when no sub-agent is configured', async () => {
    const invocationRecord = {
      invocationId: 'inv-no-agent',
      providerId: 'provider-a',
      agents: new Map(),
      status: 'running',
      waiters: new Set()
    };

    const resultPromise = manager.spawnAgent({
      invocationRecord,
      req: { prompt: 'do task', name: 'agent 1' },
      index: 0,
      provider: { config: {} },
      resolvedProviderId: 'provider-a',
      acpClient: mockAcpClient,
      parentAcpSessionId: 'parent-acp',
      parentUiId: 'parent-ui',
      modelId: null,
      resolvedModelKey: null,
      quickModelOptions: []
    });
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toEqual({ error: 'No agent configured' });
    expect(mockDb.addSubAgentInvocationAgent).toHaveBeenCalledWith(expect.objectContaining({
      invocationId: 'inv-no-agent',
      status: 'failed',
      errorText: 'No agent configured'
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('sub_agent_completed', expect.objectContaining({
      acpSessionId: 'setup-failed-inv-no-agent-0',
      status: 'failed'
    }));
  });

  it('marks an agent cancelled when prompt failure follows invocation cancellation', async () => {
    const agentRecord = {
      acpId: 'sub-acp-1',
      index: 0,
      status: 'running',
      prompt: 'do task'
    };
    const invocationRecord = {
      invocationId: 'inv-cancelled-prompt',
      providerId: 'provider-a',
      cancelled: false,
      status: 'running',
      agents: new Map([['sub-acp-1', agentRecord]]),
      waiters: new Set()
    };
    mockAcpClient.transport.sendRequest.mockImplementationOnce(async () => {
      invocationRecord.cancelled = true;
      throw new Error('cancel race');
    });

    await manager.startAgentPrompt({ invocationRecord, agentRecord, acpClient: mockAcpClient });

    expect(agentRecord.status).toBe('cancelled');
    expect(mockDb.updateSubAgentInvocationAgentStatus).toHaveBeenCalledWith('provider-a', 'inv-cancelled-prompt', 'sub-acp-1', expect.objectContaining({
      status: 'cancelled',
      errorText: 'Cancelled'
    }));
    expect(mockIo.emit).toHaveBeenCalledWith('sub_agent_completed', expect.objectContaining({
      invocationId: 'inv-cancelled-prompt',
      status: 'cancelled'
    }));
  });

  it('sendWithTimeout rejects immediately when invocation is already cancelled', async () => {
    await expect(manager.sendWithTimeout(
      { transport: { sendRequest: vi.fn().mockResolvedValue({}) } },
      'session/new',
      {},
      30000,
      { cancelled: true }
    )).rejects.toThrow('Cancelled');
  });

  it('joins all sockets when parent ACP session is unknown', async () => {
    const sockets = [
      { join: vi.fn(), rooms: new Set() },
      { join: vi.fn(), rooms: new Set(['session:other']) }
    ];
    mockIo.fetchSockets.mockResolvedValueOnce(sockets);

    await manager.joinSubAgentRoom(null, 'sub-acp-1');

    expect(sockets[0].join).toHaveBeenCalledWith('session:sub-acp-1');
    expect(sockets[1].join).toHaveBeenCalledWith('session:sub-acp-1');
    expect(deps.log).toHaveBeenCalledWith('[SUB-AGENT] Warning: parent ACP session unknown, joining all sockets');
  });

  it('joins only sockets watching the parent ACP session', async () => {
    const sockets = [
      { join: vi.fn(), rooms: new Set(['session:parent-acp']) },
      { join: vi.fn(), rooms: new Set(['session:other']) }
    ];
    mockIo.fetchSockets.mockResolvedValueOnce(sockets);

    await manager.joinSubAgentRoom('parent-acp', 'sub-acp-1');

    expect(sockets[0].join).toHaveBeenCalledWith('session:sub-acp-1');
    expect(sockets[1].join).not.toHaveBeenCalled();
  });

  it('waits for invocation changes and removes waiters after notification', async () => {
    const invocation = { invocationId: 'inv-wait', waiters: new Set() };
    manager.invocations.set('inv-wait', invocation);

    const waitPromise = manager.waitForInvocationChange('inv-wait', 1000, null);
    await flushMicrotasks();
    expect(invocation.waiters.size).toBe(1);

    manager.notifyInvocationChanged('inv-wait');
    await waitPromise;

    expect(invocation.waiters.size).toBe(0);
  });

  it('returns missing invocation if a status snapshot disappears while waiting', async () => {
    deps.now
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(5);
    mockDb.getSubAgentInvocationWithAgents
      .mockResolvedValueOnce({
        provider: 'provider-a',
        invocationId: 'inv-vanished',
        status: 'running',
        totalCount: 1,
        completedCount: 0,
        agents: [{ acpSessionId: 'sub-acp-1', index: 0, status: 'running' }]
      })
      .mockResolvedValueOnce(null);

    const statusPromise = manager.getInvocationStatus({
      providerId: 'provider-a',
      invocationId: 'inv-vanished',
      waitTimeoutMs: 100,
      pollIntervalMs: 10
    });
    await vi.advanceTimersByTimeAsync(10);

    const result = await statusPromise;
    expect(result.content[0].text).toContain('Sub-agent invocation not found');
    expect(result.content[0].text).toContain('inv-vanished');
  });

  it('formats failed agents in status output', () => {
    const result = manager.buildStatusResult({
      invocationId: 'inv-failed',
      status: 'failed',
      statusToolName: 'ux_check_subagents',
      totalCount: 1,
      completedCount: 0,
      agents: [{ index: 0, name: 'agent 1', status: 'failed', errorText: 'boom' }]
    });

    expect(result.content[0].text).toContain('Failed agents');
    expect(result.content[0].text).toContain('Agent 1: agent 1 - boom');
  });

  it('returns unavailable for missing runtime dependencies before starting agents', async () => {
    const noIoManager = new SubAgentInvocationManager({ ...deps, io: null });
    let result = await noIoManager.runInvocation({ requests: [{ prompt: 'do task' }], providerId: 'provider-a' });
    expect(result.content[0].text).toContain('Sub-agent system not available');

    deps.acpClientFactory.mockReturnValueOnce(null);
    result = await manager.runInvocation({ requests: 'not-an-array', providerId: 'provider-a' });
    expect(result.content[0].text).toContain('Sub-agent system not available');
  });

  it('getSnapshotsForParent skips other parents and terminal agents', () => {
    manager.invocations.set('inv-other-parent', {
      parentAcpSessionId: 'other-parent',
      agents: new Map([['other-acp', { acpId: 'other-acp', status: 'running' }]])
    });
    manager.invocations.set('inv-terminal', {
      parentAcpSessionId: 'parent-acp',
      agents: new Map([['done-acp', { acpId: 'done-acp', status: 'completed' }]])
    });

    expect(manager.getSnapshotsForParent('parent-acp')).toEqual([]);
  });

  it('cleans prior sub-agent sessions when cleanup and attachments are absent', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acpui-subagent-empty-cleanup-'));
    manager.getAttachmentsRootFn = vi.fn().mockReturnValue(root);
    mockDb.getAllSessions.mockResolvedValue([
      { id: 'sub-ui-empty', acpSessionId: null, isSubAgent: true, forkedFrom: 'parent-ui' }
    ]);

    try {
      await manager.cleanupPreviousInvocationsForParent('provider-a', 'parent-ui');

      expect(deps.cleanupFn).not.toHaveBeenCalled();
      expect(manager.getAttachmentsRootFn).toHaveBeenCalledWith('provider-a');
      expect(mockDb.deleteSession).toHaveBeenCalledWith('sub-ui-empty');
      expect(mockDb.deleteSubAgentInvocationsForParent).toHaveBeenCalledWith('provider-a', 'parent-ui');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('handles status helper edge paths', async () => {
    const missingId = await manager.getInvocationStatus({ providerId: 'provider-a', invocationId: '', waitTimeoutMs: 0 });
    expect(missingId.content[0].text).toContain('invocationId is required');

    expect(manager.isSnapshotTerminal({ status: 'completed' })).toBe(true);
    expect(manager.isSnapshotTerminal({ status: 'running' })).toBe(false);
    expect(manager.isSnapshotTerminal(null)).toBe(false);

    const aborted = new AbortController();
    aborted.abort();
    await manager.waitForInvocationChange('missing-invocation', 100, aborted.signal);
    await manager.waitForInvocationChange('missing-invocation', 0, null);

    const waitPromise = manager.waitForInvocationChange('missing-invocation', 10, null);
    await vi.advanceTimersByTimeAsync(10);
    await waitPromise;
  });

  it('cancelInvocation handles active records and missing or agentless snapshots', async () => {
    const abortFn = vi.fn();
    manager.invocations.set('inv-memory', {
      invocationId: 'inv-memory',
      providerId: 'provider-a',
      status: 'running',
      agents: new Map(),
      abortFn,
      waiters: new Set()
    });

    await manager.cancelInvocation('provider-a', 'inv-memory');
    expect(abortFn).toHaveBeenCalled();

    mockDb.getSubAgentInvocationWithAgents.mockResolvedValueOnce(null);
    await manager.cancelInvocation('provider-a', 'inv-missing-db');

    mockDb.getSubAgentInvocationWithAgents.mockResolvedValueOnce({
      provider: 'provider-a',
      invocationId: 'inv-agentless',
      totalCount: 0,
      completedCount: 0
    });
    await manager.cancelInvocation('provider-a', 'inv-agentless');

    expect(mockDb.updateSubAgentInvocationStatus).toHaveBeenCalledWith('provider-a', 'inv-agentless', 'cancelled', expect.objectContaining({
      totalCount: 0,
      completedCount: 0
    }));
  });

  it('cancelInvocationRecord skips terminal, setup-failed, and no-id agents while preserving unmatched pending requests', async () => {
    mockAcpClient.transport.sendNotification = vi.fn();
    const pendingReject = vi.fn();
    mockAcpClient.transport.pendingRequests = new Map([
      ['pending-other', { params: { sessionId: 'other-acp' }, reject: pendingReject }]
    ]);
    const inv = {
      invocationId: 'inv-edge-cancel',
      providerId: 'provider-a',
      status: 'running',
      agents: new Map([
        ['done-acp', { acpId: 'done-acp', status: 'completed', index: 0 }],
        ['setup-failed-inv-edge-cancel-1', { acpId: 'setup-failed-inv-edge-cancel-1', status: 'running', index: 1 }],
        ['missing-acp', { acpId: null, status: 'running', index: 2 }],
        ['real-acp', { acpId: 'real-acp', status: 'running', index: 3 }]
      ]),
      waiters: new Set()
    };

    await manager.cancelInvocationRecord(inv);

    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledTimes(1);
    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'real-acp' });
    expect(pendingReject).not.toHaveBeenCalled();
    expect(inv.agents.get('done-acp').status).toBe('completed');
    expect(mockDb.updateSubAgentInvocationAgentStatus).toHaveBeenCalledWith('provider-a', 'inv-edge-cancel', 'setup-failed-inv-edge-cancel-1', expect.objectContaining({ status: 'cancelled' }));
    expect(mockDb.updateSubAgentInvocationAgentStatus).toHaveBeenCalledWith('provider-a', 'inv-edge-cancel', null, expect.objectContaining({ status: 'cancelled' }));
  });

  it('formats status output with fallback names, messages, and tool names', () => {
    const result = manager.buildStatusResult({
      invocationId: 'inv-mixed-fallbacks',
      status: 'running',
      agents: [
        { index: 0, status: 'completed', resultText: '' },
        { index: 1, status: 'failed', errorText: '' },
        { index: 2, status: 'cancelled' },
        { index: 3, status: 'running' }
      ]
    });
    const text = result.content[0].text;
    expect(text).toContain('Status tool: ux_check_subagents');
    expect(text).toContain('## Agent 1: Sub-agent');
    expect(text).toContain('(no response)');
    expect(text).toContain('Agent 2: Sub-agent - Failed');
    expect(text).toContain('Agent 3: Sub-agent');
    expect(text).toContain('Agent 4: Sub-agent (running)');

    const noAgents = manager.buildStatusResult({ invocationId: 'inv-empty', status: 'completed' });
    expect(noAgents.content[0].text).toContain('Completed: 0 / 0');
    expect(noAgents.content[0].text).toContain('All sub-agents are now terminal');

    const active = manager.buildActiveInvocationResult({
      invocationId: 'inv-active-default',
      status: 'running',
      completedCount: 0,
      totalCount: 1
    });
    expect(active.content[0].text).toContain('Status tool: ux_check_subagents');
  });

  it('getSnapshotsForParent returns active agents', async () => {
    mockAcpClient.transport.sendRequest.mockImplementation(async (method) => {
      if (method === 'session/new') return { sessionId: 'sub-acp-1' };
      if (method === 'session/prompt') return new Promise(() => {}); // hang
      return {};
    });
    
    manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    await vi.advanceTimersByTimeAsync(10);
    
    const snapshots = manager.getSnapshotsForParent('parent-acp');
    expect(snapshots.length).toBe(1);
    expect(snapshots[0].acpId).toBe('sub-acp-1');
  });
});
