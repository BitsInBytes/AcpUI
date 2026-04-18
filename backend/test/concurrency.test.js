import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { providerRuntimeManager } from '../services/providerRuntimeManager.js';
import { JsonRpcTransport } from '../services/jsonRpcTransport.js';
import { StreamController } from '../services/streamController.js';
import { PermissionManager } from '../services/permissionManager.js';
import { getProvider, getProviderModule } from '../services/providerLoader.js';

vi.mock('../database.js');
vi.mock('../services/providerLoader.js');
vi.mock('../services/logger.js');
vi.mock('child_process');

const mockProviders = [
  { id: 'p1', config: { name: 'P1', command: 'node', executable: { command: 'node', args: [], env: {} } } },
  { id: 'p2', config: { name: 'P2', command: 'node', executable: { command: 'node', args: [], env: {} } } },
  { id: 'p3', config: { name: 'P3', command: 'node', executable: { command: 'node', args: [], env: {} } } }
];

vi.mock('../services/providerRegistry.js', () => {
  let callCount = 0;
  return {
    getProviderEntries: () => mockProviders.map(p => ({ id: p.id })),
    getDefaultProviderId: () => 'p1',
    resolveProviderId: vi.fn(() => {
      callCount++;
      return `p${callCount}`;
    })
  };
});

// ─── Multi-Provider Isolation ───────────────────────────────────────────────

describe('Multi-Provider Concurrency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes multiple providers simultaneously without state leakage', async () => {
    const io = { emit: vi.fn(), to: vi.fn().mockReturnThis() };
    const bootId = 'boot-123';

    getProvider.mockImplementation((id) => mockProviders.find(p => p.id === id));
    getProviderModule.mockResolvedValue({
      prepareAcpEnvironment: (e) => e,
      performHandshake: async (client) => { client.isHandshakeComplete = true; }
    });

    await providerRuntimeManager.init(io, bootId);

    const r1 = providerRuntimeManager.getRuntime('p1');
    const r2 = providerRuntimeManager.getRuntime('p2');
    const r3 = providerRuntimeManager.getRuntime('p3');

    expect(r1.providerId).toBe('p1');
    expect(r2.providerId).toBe('p2');
    expect(r3.providerId).toBe('p3');
    expect(r1.client).not.toBe(r2.client);
    expect(r2.client).not.toBe(r3.client);
  });
});

// ─── JsonRpcTransport: Concurrent Request Correlation ───────────────────────

describe('JsonRpcTransport — concurrent request correlation', () => {
  let transport;
  let writtenMessages;

  beforeEach(() => {
    writtenMessages = [];
    transport = new JsonRpcTransport();
    transport.setProcess({
      stdin: { write: (data) => writtenMessages.push(JSON.parse(data.trim())) }
    });
  });

  it('assigns unique IDs to concurrent requests', () => {
    transport.sendRequest('session/prompt', { sessionId: 's1' });
    transport.sendRequest('session/prompt', { sessionId: 's2' });
    transport.sendRequest('session/new', { cwd: '/' });

    expect(writtenMessages[0].id).toBe(1);
    expect(writtenMessages[1].id).toBe(2);
    expect(writtenMessages[2].id).toBe(3);
  });

  it('resolves each promise with the response matching its ID, regardless of arrival order', async () => {
    const p1 = transport.sendRequest('session/prompt', { sessionId: 's1' });
    const p2 = transport.sendRequest('session/prompt', { sessionId: 's2' });
    const p3 = transport.sendRequest('session/new', {});

    // Simulate out-of-order responses from the ACP daemon
    const id2 = writtenMessages[1].id;
    const id3 = writtenMessages[2].id;
    const id1 = writtenMessages[0].id;

    transport.pendingRequests.get(id2).resolve({ sessionId: 's2-result' });
    transport.pendingRequests.get(id3).resolve({ sessionId: 'new-result' });
    transport.pendingRequests.get(id1).resolve({ sessionId: 's1-result' });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.sessionId).toBe('s1-result');
    expect(r2.sessionId).toBe('s2-result');
    expect(r3.sessionId).toBe('new-result');
  });

  it('rejects only the correct request when one fails', async () => {
    const p1 = transport.sendRequest('session/prompt', { sessionId: 's1' });
    const p2 = transport.sendRequest('session/prompt', { sessionId: 's2' });

    const id1 = writtenMessages[0].id;
    const id2 = writtenMessages[1].id;

    transport.pendingRequests.get(id1).reject(new Error('session s1 failed'));
    transport.pendingRequests.get(id2).resolve({ ok: true });

    await expect(p1).rejects.toThrow('session s1 failed');
    await expect(p2).resolves.toEqual({ ok: true });
  });

  it('rejects all pending requests on reset without affecting each other', async () => {
    const p1 = transport.sendRequest('session/prompt', { sessionId: 's1' });
    const p2 = transport.sendRequest('session/prompt', { sessionId: 's2' });

    transport.reset();

    await expect(p1).rejects.toThrow('ACP process died unexpectedly');
    await expect(p2).rejects.toThrow('ACP process died unexpectedly');
    expect(transport.pendingRequests.size).toBe(0);
  });
});

// ─── StreamController: Cross-Session Isolation ──────────────────────────────

describe('StreamController — cross-session isolation', () => {
  let controller;

  beforeEach(() => {
    controller = new StreamController();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('chunks for session A do not reset session B drain timer', async () => {
    controller.beginDraining('A');
    controller.beginDraining('B');

    let resolvedA = false;
    let resolvedB = false;
    controller.waitForDrainToFinish('A', 1000).then(() => { resolvedA = true; });
    controller.waitForDrainToFinish('B', 1000).then(() => { resolvedB = true; });

    // Only session A receives chunks — keeps A draining, B should not be affected
    vi.advanceTimersByTime(800);
    controller.onChunk('A');
    vi.advanceTimersByTime(800);
    controller.onChunk('A');

    // B silence window (1000ms) has elapsed — B should be done
    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(resolvedB).toBe(true);
    expect(resolvedA).toBe(false); // A still getting chunks

    // A finally goes silent
    vi.advanceTimersByTime(1100);
    await Promise.resolve();
    expect(resolvedA).toBe(true);
  });

  it('onChunk for an unknown session does not throw or create state', () => {
    expect(() => controller.onChunk('nonexistent')).not.toThrow();
    expect(controller.drainingSessions.has('nonexistent')).toBe(false);
  });

  it('statsCapture buffers are fully isolated between sessions', () => {
    controller.statsCaptures.set('s1', { buffer: '' });
    controller.statsCaptures.set('s2', { buffer: '' });

    controller.statsCaptures.get('s1').buffer += 'title for s1';
    controller.statsCaptures.get('s2').buffer += 'title for s2';

    expect(controller.statsCaptures.get('s1').buffer).toBe('title for s1');
    expect(controller.statsCaptures.get('s2').buffer).toBe('title for s2');
  });

  it('beginDraining a session that is already draining clears old timer and resets state', async () => {
    controller.beginDraining('A');
    let firstResolved = false;
    const firstPromise = controller.waitForDrainToFinish('A', 500).then(() => { firstResolved = true; });

    // Re-drain the same session (e.g. rapid reload)
    vi.advanceTimersByTime(400); // almost at timeout
    controller.beginDraining('A'); // should clear the old timer
    let secondResolved = false;
    controller.waitForDrainToFinish('A', 500).then(() => { secondResolved = true; });

    vi.advanceTimersByTime(300); // old timer would have fired, new timer has not
    await Promise.resolve();
    expect(firstResolved).toBe(false); // old promise never resolved (state was cleared)
    expect(secondResolved).toBe(false);

    vi.advanceTimersByTime(300);
    await Promise.resolve();
    expect(secondResolved).toBe(true);
  });

  it('reset resolves all pending drains and clears all state simultaneously', async () => {
    controller.beginDraining('A');
    controller.beginDraining('B');
    controller.beginDraining('C');
    controller.statsCaptures.set('s1', { buffer: 'data' });

    const results = [];
    controller.waitForDrainToFinish('A', 9999).then(() => results.push('A'));
    controller.waitForDrainToFinish('B', 9999).then(() => results.push('B'));
    controller.waitForDrainToFinish('C', 9999).then(() => results.push('C'));

    controller.reset();
    await Promise.resolve();

    expect(results).toHaveLength(3);
    expect(controller.drainingSessions.size).toBe(0);
    expect(controller.statsCaptures.size).toBe(0);
  });
});

// ─── PermissionManager: Concurrent Permissions ──────────────────────────────

describe('PermissionManager — concurrent permission tracking', () => {
  let permissions;
  let mockIo;

  beforeEach(() => {
    permissions = new PermissionManager();
    mockIo = { to: vi.fn().mockReturnThis(), emit: vi.fn() };
  });

  it('tracks multiple pending permissions from different sessions independently', () => {
    permissions.handleRequest('req-1', { sessionId: 's1', toolCall: {} }, mockIo, 'p1');
    permissions.handleRequest('req-2', { sessionId: 's2', toolCall: {} }, mockIo, 'p1');
    permissions.handleRequest('req-3', { sessionId: 's3', toolCall: {} }, mockIo, 'p1');

    expect(permissions.pendingPermissions.get('s1')).toBe('req-1');
    expect(permissions.pendingPermissions.get('s2')).toBe('req-2');
    expect(permissions.pendingPermissions.get('s3')).toBe('req-3');
  });

  it('emits permission_request to the correct session room for each', () => {
    permissions.handleRequest('req-1', { sessionId: 's1' }, mockIo, 'p1');
    permissions.handleRequest('req-2', { sessionId: 's2' }, mockIo, 'p1');

    const rooms = mockIo.to.mock.calls.map(c => c[0]);
    expect(rooms).toContain('session:s1');
    expect(rooms).toContain('session:s2');
  });

  it('responding to one request removes only that session and leaves others intact', async () => {
    const mockTransport = { acpProcess: { stdin: { write: vi.fn() } } };

    permissions.handleRequest('req-1', { sessionId: 's1' }, mockIo, 'p1');
    permissions.handleRequest('req-2', { sessionId: 's2' }, mockIo, 'p1');
    permissions.handleRequest('req-3', { sessionId: 's3' }, mockIo, 'p1');

    await permissions.respond('req-2', 'approve', mockTransport);

    expect(permissions.pendingPermissions.has('s2')).toBe(false);
    expect(permissions.pendingPermissions.get('s1')).toBe('req-1');
    expect(permissions.pendingPermissions.get('s3')).toBe('req-3');
  });

  it('writes the correct JSON-RPC response payload to stdin', async () => {
    const writes = [];
    const mockTransport = { acpProcess: { stdin: { write: (d) => writes.push(JSON.parse(d.trim())) } } };

    permissions.handleRequest('req-42', { sessionId: 's1' }, mockIo, 'p1');
    await permissions.respond('req-42', 'option-b', mockTransport);

    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe('req-42');
    expect(writes[0].result.outcome.outcome).toBe('selected');
    expect(writes[0].result.outcome.optionId).toBe('option-b');
  });

  it('writes a cancelled outcome for reject-style options', async () => {
    const writes = [];
    const mockTransport = { acpProcess: { stdin: { write: (d) => writes.push(JSON.parse(d.trim())) } } };

    permissions.handleRequest('req-99', { sessionId: 's1' }, mockIo, 'p1');
    await permissions.respond('req-99', 'reject', mockTransport);

    expect(writes[0].result.outcome.outcome).toBe('cancelled');
  });

  it('reset clears all pending permissions', () => {
    permissions.handleRequest('req-1', { sessionId: 's1' }, mockIo, 'p1');
    permissions.handleRequest('req-2', { sessionId: 's2' }, mockIo, 'p1');

    permissions.reset();

    expect(permissions.pendingPermissions.size).toBe(0);
  });
});
