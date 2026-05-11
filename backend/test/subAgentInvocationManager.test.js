import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SubAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

describe('SubAgentInvocationManager', () => {
  let deps;
  let manager;
  let mockIo;
  let mockDb;
  let mockAcpClient;

  beforeEach(() => {
    vi.useFakeTimers();
    mockIo = { emit: vi.fn(), fetchSockets: vi.fn().mockResolvedValue([]) };
    mockDb = {
      getSessionByAcpId: vi.fn().mockResolvedValue({ id: 'parent-ui' }),
      saveSession: vi.fn().mockResolvedValue()
    };
    mockAcpClient = {
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

  it('runs invocation successfully', async () => {
    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a'
    });

    await vi.runAllTimersAsync();
    
    const result = await resultPromise;
    expect(result.content[0].text).toContain('test response');
    expect(deps.cleanupFn).toHaveBeenCalledWith('sub-acp-1', 'provider-a');
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

    expect(firstResult.content[0].text).toContain('test response');
    expect(secondResult.content[0].text).toContain('test response');
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

    expect(firstResult.content[0].text).toContain('test response');
    expect(secondResult).toEqual(firstResult);
    expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
  });

  it('prunes expired completed invocation results before replay lookup', async () => {
    let now = 1000;
    deps.now = vi.fn(() => now);
    deps.completedInvocationTtlMs = 100;
    manager = new SubAgentInvocationManager(deps);
    manager.completedInvocations.set('expired-key', {
      result: { content: [{ type: 'text', text: 'old result' }] },
      completedAt: 800
    });

    const resultPromise = manager.runInvocation({
      requests: [{ prompt: 'do task', name: 'agent 1' }],
      providerId: 'provider-a',
      parentAcpSessionId: 'parent-acp',
      idempotencyKey: 'expired-key'
    });

    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result.content[0].text).toContain('test response');
    expect(mockAcpClient.transport.sendRequest.mock.calls.filter(call => call[0] === 'session/new')).toHaveLength(1);
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

    manager.cancelAllForParent('parent-acp', 'provider-a');

    expect(mockAcpClient.transport.sendNotification).toHaveBeenCalledWith('session/cancel', { sessionId: 'sub-acp-1' });
    expect(rejectFn).toHaveBeenCalledWith(expect.any(Error));

    await vi.runAllTimersAsync();
    const result = await runPromise;
    expect(result.content[0].text).toContain('Aborted');
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

    manager.cancelAllForParent('parent-acp', 'provider-a');
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('Error sending cancel to sub-agent sub-acp-1: Send failed'));
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
