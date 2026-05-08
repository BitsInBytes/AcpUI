import { describe, it, expect, vi, beforeEach } from 'vitest';
import { emitSubAgentSnapshotsForSession } from '../sockets/subAgentHandlers.js';
import { subAgentInvocationManager } from '../mcp/subAgentInvocationManager.js';

vi.mock('../mcp/subAgentInvocationManager.js', () => ({
  subAgentInvocationManager: {
    getSnapshotsForParent: vi.fn()
  }
}));

describe('subAgentHandlers', () => {
  let mockSocket;

  beforeEach(() => {
    mockSocket = { emit: vi.fn() };
    vi.clearAllMocks();
  });

  it('emits sub_agent_snapshot for each running sub-agent matching parentAcpSessionId', () => {
    subAgentInvocationManager.getSnapshotsForParent.mockReturnValue([
      { acpId: 'sub-1', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'spawning', uiId: 'ui-1', parentUiId: 'pui-1', invocationId: 'inv-1', index: 0, name: 'A1', prompt: 'hi', agent: 'dev', model: 'fast' },
      { acpId: 'sub-2', providerId: 'prov-b', parentAcpSessionId: 'parent-1', status: 'running' }, // different provider
      { acpId: 'sub-3', providerId: 'prov-a', parentAcpSessionId: 'parent-1', status: 'prompting', uiId: 'ui-3', parentUiId: 'pui-1', invocationId: 'inv-1', index: 1, name: 'A2', prompt: 'hello', agent: 'dev', model: 'fast' }
    ]);

    emitSubAgentSnapshotsForSession(mockSocket, { sessionId: 'parent-1', providerId: 'prov-a' });

    expect(mockSocket.emit).toHaveBeenCalledTimes(2);
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({ acpSessionId: 'sub-1', status: 'spawning' }));
    expect(mockSocket.emit).toHaveBeenCalledWith('sub_agent_snapshot', expect.objectContaining({ acpSessionId: 'sub-3', status: 'prompting' }));
  });

  it('does not emit when sessionId is null', () => {
    emitSubAgentSnapshotsForSession(mockSocket, { sessionId: null });
    expect(subAgentInvocationManager.getSnapshotsForParent).not.toHaveBeenCalled();
    expect(mockSocket.emit).not.toHaveBeenCalled();
  });
});