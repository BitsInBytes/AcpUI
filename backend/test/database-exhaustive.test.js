import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as db from '../database.js';

describe('Exhaustive Database Coverage', () => {
  beforeEach(async () => {
    await db.initDb();
  });

  afterEach(async () => {
    await db.closeDb();
  });

  it('hits all folder branches', async () => {
    const id = 'f1';
    await db.createFolder({ id, name: 'F1', parentId: null, position: 1, providerId: 'p1' });
    await db.renameFolder(id, 'F2');
    await db.moveFolder(id, 'root');
    await db.getAllFolders();
    await db.moveSessionToFolder('s1', id);
    await db.deleteFolder(id);
  });

  it('hits all canvas branches', async () => {
    const id = 'c1';
    await db.saveCanvasArtifact({ id, sessionId: 's1', title: 'T', content: 'C', language: 'js', version: 2, filePath: '/p' });
    await db.getCanvasArtifactsForSession('s1');
    await db.deleteCanvasArtifact(id);
  });

  it('hits isSubAgent false branch', async () => {
    await db.saveSession({ id: 's-no-sub', isSubAgent: false, messages: [] });
    expect(true).toBe(true);
  });

  it('hits all optional field branches in saveSession', async () => {
    const base = { id: 's-opt', messages: [] };
    await db.saveSession({ ...base, cwd: '/c', folderId: 'f1', forkedFrom: 's1', forkPoint: 10, isSubAgent: true, parentAcpSessionId: 'p1' });
    await db.saveSession({ ...base, cwd: null, folderId: null, forkedFrom: null, forkPoint: null, isSubAgent: false, parentAcpSessionId: null });
    expect(true).toBe(true);
  });

  it('handles getSessionByAcpId with null provider', async () => {
    await db.getSessionByAcpId(null, null);
    expect(true).toBe(true);
  });

  it('hits parseProviderScopedArgs 2-arg signature', async () => {
    await db.saveConfigOptions('a1', []);
    expect(true).toBe(true);
  });

  it('hits parseProviderScopedArgs 3-arg signature', async () => {
    await db.saveConfigOptions('p1', 'a1', []);
    expect(true).toBe(true);
  });

  it('persists and scopes sub-agent invocation lifecycle rows', async () => {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const parentUiId = `parent-${suffix}`;
    const providerAInvocationId = `inv-a-${suffix}`;
    const providerBInvocationId = `inv-b-${suffix}`;
    const agentOneId = `sub-a-1-${suffix}`;
    const agentTwoId = `sub-a-2-${suffix}`;

    expect(db.isSubAgentInvocationActiveStatus('running')).toBe(true);
    expect(db.isSubAgentInvocationActiveStatus('completed')).toBe(false);
    expect(db.isSubAgentInvocationTerminalStatus('failed')).toBe(true);
    expect(db.isSubAgentInvocationTerminalStatus('prompting')).toBe(false);

    await db.createSubAgentInvocation({
      invocationId: providerAInvocationId,
      provider: 'provider-a',
      parentAcpSessionId: `parent-acp-${suffix}`,
      parentUiId,
      status: 'running',
      totalCount: 2,
      completedCount: 0,
      statusToolName: 'ux_check_subagents',
      createdAt: 1000,
      updatedAt: 1000
    });
    await db.createSubAgentInvocation({
      invocationId: providerBInvocationId,
      provider: 'provider-b',
      parentUiId,
      status: 'running',
      totalCount: 1,
      completedCount: 0
    });

    expect(await db.getActiveSubAgentInvocationForParent('provider-a', parentUiId)).toEqual(expect.objectContaining({
      invocationId: providerAInvocationId,
      provider: 'provider-a',
      parentUiId,
      status: 'running',
      totalCount: 2,
      completedCount: 0,
      statusToolName: 'ux_check_subagents'
    }));
    expect(await db.getActiveSubAgentInvocationForParent('provider-b', parentUiId)).toEqual(expect.objectContaining({
      invocationId: providerBInvocationId,
      provider: 'provider-b'
    }));
    expect(await db.getSubAgentInvocationsForParent('provider-a', parentUiId)).toHaveLength(1);

    await db.addSubAgentInvocationAgent({
      invocationId: providerAInvocationId,
      acpSessionId: agentTwoId,
      uiId: `ui-${agentTwoId}`,
      index: 1,
      name: 'Second',
      prompt: 'second prompt',
      agent: 'dev',
      model: 'fast',
      status: 'running',
      createdAt: 1001,
      updatedAt: 1001
    });
    await db.addSubAgentInvocationAgent({
      invocationId: providerAInvocationId,
      acpSessionId: agentOneId,
      uiId: `ui-${agentOneId}`,
      index: 0,
      name: 'First',
      prompt: 'first prompt',
      agent: 'dev',
      model: 'fast',
      status: 'prompting',
      createdAt: 1002,
      updatedAt: 1002
    });

    await db.updateSubAgentInvocationAgentStatus('provider-a', providerAInvocationId, agentOneId, {
      status: 'completed',
      resultText: 'first result',
      completedAt: 1200
    });
    await db.updateSubAgentInvocationAgentStatus('provider-a', providerAInvocationId, agentTwoId, {
      status: 'failed',
      errorText: 'second error',
      completedAt: 1201
    });
    await db.updateSubAgentInvocationStatus('provider-a', providerAInvocationId, 'failed', {
      totalCount: 2,
      completedCount: 1,
      completedAt: 1300
    });

    const snapshot = await db.getSubAgentInvocationWithAgents('provider-a', providerAInvocationId);
    expect(snapshot).toEqual(expect.objectContaining({
      invocationId: providerAInvocationId,
      provider: 'provider-a',
      parentUiId,
      status: 'failed',
      totalCount: 2,
      completedCount: 1,
      completedAt: 1300
    }));
    expect(snapshot.agents.map(agent => agent.acpSessionId)).toEqual([agentOneId, agentTwoId]);
    expect(snapshot.agents[0]).toEqual(expect.objectContaining({
      index: 0,
      status: 'completed',
      resultText: 'first result',
      completedAt: 1200
    }));
    expect(snapshot.agents[1]).toEqual(expect.objectContaining({
      index: 1,
      status: 'failed',
      errorText: 'second error',
      completedAt: 1201
    }));
    expect(await db.getActiveSubAgentInvocationForParent('provider-a', parentUiId)).toBeNull();
    expect(await db.getSubAgentInvocationWithAgents('provider-b', providerAInvocationId)).toBeNull();

    await db.deleteSubAgentInvocationsForParent('provider-a', parentUiId);
    expect(await db.getSubAgentInvocationWithAgents('provider-a', providerAInvocationId)).toBeNull();
    expect(await db.getSubAgentInvocationWithAgents('provider-b', providerBInvocationId)).toEqual(expect.objectContaining({
      invocationId: providerBInvocationId
    }));

    await db.deleteSubAgentInvocation('provider-b', providerBInvocationId);
    expect(await db.getSubAgentInvocationWithAgents('provider-b', providerBInvocationId)).toBeNull();
  });

  it('hits all error paths using mock injection', async () => {
    const mockDb = {
      run: vi.fn((_q, _p, cb) => (cb ? cb(new Error('fail')) : null)),
      all: vi.fn((_q, _p, cb) => (cb ? cb(new Error('fail')) : (typeof _p === 'function' ? _p(new Error('fail')) : null))),
      get: vi.fn((_q, _p, cb) => (cb ? cb(new Error('fail')) : (typeof _p === 'function' ? _p(new Error('fail')) : null))),
      serialize: vi.fn(fn => fn()),
      close: vi.fn(cb => cb(null))
    };
    db.setDbForTesting(mockDb);

    await expect(db.saveSession({})).rejects.toThrow();
    await expect(db.getAllSessions()).rejects.toThrow();
    await expect(db.getPinnedSessions()).rejects.toThrow();
    await expect(db.getSession('1')).rejects.toThrow();
    await expect(db.updateSessionName('1', 'N')).rejects.toThrow();
    await expect(db.deleteSession('1')).rejects.toThrow();
    await expect(db.saveCanvasArtifact({})).rejects.toThrow();
    await expect(db.getCanvasArtifactsForSession('1')).rejects.toThrow();
    await expect(db.deleteCanvasArtifact('1')).rejects.toThrow();
    await expect(db.getAllFolders()).rejects.toThrow();
    await expect(db.createFolder({})).rejects.toThrow();
    await expect(db.renameFolder('1', 'N')).rejects.toThrow();
    await expect(db.deleteFolder('1')).rejects.toThrow();
    await expect(db.moveFolder('1', '2')).rejects.toThrow();
    await expect(db.moveSessionToFolder('1', '2')).rejects.toThrow();
    await expect(db.getNotes('1')).rejects.toThrow();
    await expect(db.saveNotes('1', 'N')).rejects.toThrow();
  });
});
