import { describe, it, expect, vi, beforeEach } from 'vitest';
import registerSubAgentHandlers, { emitSubAgentSnapshotsForSession } from '../sockets/subAgentHandlers.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';
import providerRuntimeManager from '../services/providerRuntimeManager.js';

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

vi.mock('../services/logger.js', () => ({
  writeLog: vi.fn()
}));

describe('subAgentHandlers', () => {
  let mockSocket;

  beforeEach(() => {
    mockSocket = { on: vi.fn(), emit: vi.fn() };
    providerRuntimeManager.getRuntime.mockReturnValue({ providerId: 'resolved-provider' });
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

  it('emits sub_agent_snapshot for each running sub-agent matching parentAcpSessionId', () => {
    subAgentInvocationManager.getSnapshotsForParent.mockReturnValue([
      { acpId: 'sub-1', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'spawning', uiId: 'ui-1', parentUiId: 'pui-1', invocationId: 'inv-1', index: 0, name: 'A1', prompt: 'hi', agent: 'dev', model: 'fast' },
      { acpId: 'sub-2', providerId: 'prov-b', parentAcpSessionId: 'parent-1', status: 'running' },
      { acpId: 'sub-3', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'prompting', uiId: 'ui-3', parentUiId: 'pui-1', invocationId: 'inv-1', index: 1, name: 'A2', prompt: 'hello', agent: 'dev', model: 'fast' }
    ]);

    emitSubAgentSnapshotsForSession(mockSocket, { sessionId: 'parent-1', providerId: 'prov-a' });

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
  });

  it('does not emit when sessionId is null', () => {
    emitSubAgentSnapshotsForSession(mockSocket, { sessionId: null });
    expect(subAgentInvocationManager.getSnapshotsForParent).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});
