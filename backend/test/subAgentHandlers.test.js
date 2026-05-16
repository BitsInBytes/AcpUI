import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSubAgentHandlers, { emitSubAgentSnapshotsForSession } from '../sockets/subAgentHandlers.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';
import * as db from '../database.js';

vi.mock('../mcp/subAgentInvocationManager.js', () => ({
  subAgentInvocationManager: {
    getSnapshotsForParent: vi.fn(),
    cancelInvocation: vi.fn()
  }
}));

vi.mock('../services/providerRuntimeManager.js', () => ({
  default: {
    getRuntime: vi.fn()
  }
}));

vi.mock('../database.js', () => ({
  getSessionByAcpId: vi.fn().mockResolvedValue(null),
  getSubAgentInvocationsForParent: vi.fn().mockResolvedValue([]),
  getSubAgentInvocationWithAgents: vi.fn().mockResolvedValue(null)
}));

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

describe('subAgentHandlers', () => {
  let mockSocket;

  beforeEach(() => {
    mockSocket = { on: vi.fn(), emit: vi.fn(), join: vi.fn() };
    providerRuntimeManager.getRuntime.mockReturnValue({ providerId: 'resolved-provider' });
    db.getSessionByAcpId.mockResolvedValue(null);
    db.getSubAgentInvocationsForParent.mockResolvedValue([]);
    db.getSubAgentInvocationWithAgents.mockResolvedValue(null);
    vi.clearAllMocks();
  });

  it('registers cancel_subagents handler and resolves provider runtime before cancelling', async () => {
    registerSubAgentHandlers(null, mockSocket);
    const handler = mockSocket.on.mock.calls.find(call => call[0] === 'cancel_subagents')[1];

    await handler({ providerId: 'provider-a', invocationId: 'inv-1' });

    expect(providerRuntimeManager.getRuntime).toHaveBeenCalledWith('provider-a');
    expect(subAgentInvocationManager.cancelInvocation).toHaveBeenCalledWith('resolved-provider', 'inv-1');
  });

  it('ignores cancel_subagents without invocationId', async () => {
    registerSubAgentHandlers(null, mockSocket);
    const handler = mockSocket.on.mock.calls.find(call => call[0] === 'cancel_subagents')[1];

    await handler({ providerId: 'provider-a' });

    expect(providerRuntimeManager.getRuntime).not.toHaveBeenCalled();
    expect(subAgentInvocationManager.cancelInvocation).not.toHaveBeenCalled();
  });

  it('emits sub_agent_snapshot for each running sub-agent matching parentAcpSessionId', async () => {
    subAgentInvocationManager.getSnapshotsForParent.mockReturnValue([
      { acpId: 'sub-1', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'spawning', uiId: 'ui-1', parentUiId: 'pui-1', invocationId: 'inv-1', index: 0, name: 'A1', prompt: 'hi', agent: 'dev', model: 'fast' },
      { acpId: 'sub-2', providerId: 'prov-b', parentAcpSessionId: 'parent-1', status: 'running' },
      { acpId: 'sub-3', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'prompting', uiId: 'ui-3', parentUiId: 'pui-1', invocationId: 'inv-1', index: 1, name: 'A2', prompt: 'hello', agent: 'dev', model: 'fast' }
    ]);

    await emitSubAgentSnapshotsForSession(mockSocket, { sessionId: 'parent-1', providerId: 'prov-a' });

    expect(mockSocket.emit).toHaveBeenCalledTimes(2);
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({
      acpSessionId: 'sub-1',
      parentAcpSessionId: 'parent-1',
      status: 'spawning'
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({
      acpSessionId: 'sub-3',
      parentAcpSessionId: 'parent-1',
      status: 'prompting'
    }));
    expect(mockSocket.join).toHaveBeenCalledWith('session:sub-1');
    expect(mockSocket.join).toHaveBeenCalledWith('session:sub-3');
    expect(mockSocket.join).not.toHaveBeenCalledWith('session:sub-2');
  });

  it('emits DB-backed invocation snapshots when in-memory snapshots are missing', async () => {
    subAgentInvocationManager.getSnapshotsForParent.mockReturnValue([]);
    db.getSessionByAcpId.mockResolvedValue({ id: 'parent-ui', provider: 'prov-a' });
    db.getSubAgentInvocationsForParent.mockResolvedValue([{ invocationId: 'inv-db' }]);
    db.getSubAgentInvocationWithAgents.mockResolvedValue({
      provider: 'prov-a',
      invocationId: 'inv-db',
      parentAcpSessionId: 'parent-1',
      parentUiId: 'parent-ui',
      status: 'running',
      totalCount: 2,
      completedCount: 1,
      statusToolName: 'ux_check_subagents',
      agents: [
        { acpSessionId: 'sub-active', uiId: 'sub-ui-1', index: 0, name: 'A1', prompt: 'hi', agent: 'dev', model: 'fast', status: 'running' },
        { acpSessionId: 'sub-done', uiId: 'sub-ui-2', index: 1, name: 'A2', prompt: 'done', agent: 'dev', model: 'fast', status: 'completed' }
      ]
    });

    await emitSubAgentSnapshotsForSession(mockSocket, { sessionId: 'parent-1', providerId: 'prov-a' });

    expect(db.getSubAgentInvocationsForParent).toHaveBeenCalledWith('prov-a', 'parent-ui', 'parent-1');
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_invocation_status', expect.objectContaining({
      invocationId: 'inv-db',
      parentAcpSessionId: 'parent-1',
      parentUiId: 'parent-ui',
      status: 'running'
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({
      acpSessionId: 'sub-active',
      invocationId: 'inv-db',
      totalCount: 2,
      completedCount: 1
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({
      acpSessionId: 'sub-done',
      status: 'completed'
    }));
    expect(mockSocket.join).toHaveBeenCalledWith('session:sub-active');
    expect(mockSocket.join).not.toHaveBeenCalledWith('session:sub-done');
  });

  it('replays DB-backed invocation snapshots by parent ACP session when parent UI row is unavailable', async () => {
    subAgentInvocationManager.getSnapshotsForParent.mockReturnValue([]);
    db.getSessionByAcpId.mockResolvedValue(null);
    db.getSubAgentInvocationsForParent.mockResolvedValue([{ invocationId: 'inv-db' }]);
    db.getSubAgentInvocationWithAgents.mockResolvedValue({
      provider: 'prov-a',
      invocationId: 'inv-db',
      parentAcpSessionId: 'parent-1',
      parentUiId: null,
      status: 'running',
      totalCount: 1,
      completedCount: 0,
      statusToolName: 'ux_check_subagents',
      agents: [
        { acpSessionId: 'sub-active', uiId: 'sub-ui-1', index: 0, name: 'A1', prompt: 'hi', agent: 'dev', model: 'fast', status: 'running' }
      ]
    });

    await emitSubAgentSnapshotsForSession(mockSocket, { sessionId: 'parent-1', providerId: 'prov-a' });

    expect(db.getSubAgentInvocationsForParent).toHaveBeenCalledWith('prov-a', null, 'parent-1');
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_invocation_status', expect.objectContaining({
      invocationId: 'inv-db',
      parentAcpSessionId: 'parent-1',
      parentUiId: null,
      status: 'running'
    }));
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({
      acpSessionId: 'sub-active',
      parentAcpSessionId: 'parent-1',
      parentUiId: null,
      invocationId: 'inv-db'
    }));
  });

  it('does not emit when sessionId is null', () => {
    emitSubAgentSnapshotsForSession(mockSocket, { sessionId: null });
    expect(subAgentInvocationManager.getSnapshotsForParent).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
