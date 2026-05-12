import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { act } from 'react';

describe('useSubAgentStore (Pure Logic)', () => {
  beforeEach(() => {
    act(() => {
      useSubAgentStore.getState().clear();
    });
  });

  it('addAgent and completeAgent manage lifecycle', () => {
    act(() => {
      useSubAgentStore.getState().addAgent({
        providerId: 'p1',
        acpSessionId: 'a1',
        parentSessionId: 'parent-1',
        invocationId: 'inv-test-1',
        index: 0,
        name: 'Sub 1',
        prompt: '...',
        agent: 'generalist'
      });
    });

    expect(useSubAgentStore.getState().agents).toHaveLength(1);
    expect(useSubAgentStore.getState().agents[0].status).toBe('spawning');

    act(() => {
      useSubAgentStore.getState().completeAgent('a1');
    });
    expect(useSubAgentStore.getState().agents[0].status).toBe('completed');
  });

  it('tracks invocation lifecycle and derives status from agents', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));

    try {
      act(() => {
        useSubAgentStore.getState().startInvocation({
          invocationId: 'inv-lifecycle',
          providerId: 'p1',
          parentUiId: 'parent-ui',
          parentSessionId: 'parent-acp',
          statusToolName: 'ux_check_subagents',
          totalCount: 2,
          status: 'running'
        });
        useSubAgentStore.getState().addAgent({
          providerId: 'p1',
          acpSessionId: 'a1',
          parentSessionId: 'parent-acp',
          invocationId: 'inv-lifecycle',
          index: 0,
          name: 'Sub 1',
          prompt: 'one',
          agent: 'generalist'
        });
        useSubAgentStore.getState().addAgent({
          providerId: 'p1',
          acpSessionId: 'a2',
          parentSessionId: 'parent-acp',
          invocationId: 'inv-lifecycle',
          index: 1,
          name: 'Sub 2',
          prompt: 'two',
          agent: 'generalist'
        });
      });

      expect(useSubAgentStore.getState().isInvocationActive('inv-lifecycle')).toBe(true);

      act(() => {
        useSubAgentStore.getState().completeAgent('a1');
      });
      expect(useSubAgentStore.getState().invocations[0].status).toBe('running');
      expect(useSubAgentStore.getState().isInvocationActive('inv-lifecycle')).toBe(true);

      act(() => {
        useSubAgentStore.getState().completeAgent('a2', 'failed');
      });
      const invocation = useSubAgentStore.getState().invocations[0];
      expect(invocation.status).toBe('failed');
      expect(invocation.completedAt).toBeDefined();
      expect(useSubAgentStore.getState().isInvocationActive('inv-lifecycle')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('updates permission state and active status for waiting agents', () => {
    act(() => {
      useSubAgentStore.getState().addAgent({
        providerId: 'p1',
        acpSessionId: 'a1',
        parentSessionId: 'parent-1',
        invocationId: 'inv-permission',
        index: 0,
        name: 'Sub 1',
        prompt: '...',
        agent: 'generalist'
      });
      useSubAgentStore.getState().setPermission('a1', { id: 1, sessionId: 'a1', options: [] });
    });

    expect(useSubAgentStore.getState().agents[0].status).toBe('waiting_permission');
    expect(useSubAgentStore.getState().isInvocationActive('inv-permission')).toBe(true);

    act(() => {
      useSubAgentStore.getState().clearPermission('a1');
    });
    expect(useSubAgentStore.getState().agents[0].status).toBe('running');
    expect(useSubAgentStore.getState().agents[0].permission).toBeNull();
  });

  it('deduplicates agents and invocations by identifier', () => {
    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-dupe',
        providerId: 'p1',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'running',
        startedAt: 100
      });
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-dupe',
        providerId: 'p1',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 2,
        status: 'prompting',
        startedAt: 200
      });
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1', invocationId: 'inv-dupe', parentSessionId: 'parent-acp', name: 'Old' } as any);
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1', invocationId: 'inv-dupe', parentSessionId: 'parent-acp', name: 'New' } as any);
    });

    expect(useSubAgentStore.getState().invocations).toHaveLength(1);
    expect(useSubAgentStore.getState().invocations[0]).toEqual(expect.objectContaining({
      totalCount: 2,
      status: 'prompting',
      startedAt: 200
    }));
    expect(useSubAgentStore.getState().agents).toHaveLength(1);
    expect(useSubAgentStore.getState().agents[0].name).toBe('New');
  });

  it('clears invocations by parent ui id or parent session id', () => {
    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-parent-ui',
        providerId: 'p1',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 1
      });
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-other',
        providerId: 'p1',
        parentUiId: 'other-ui',
        parentSessionId: 'other-acp',
        statusToolName: 'ux_check_subagents',
        totalCount: 1
      });
      useSubAgentStore.getState().clearInvocationsForParent('parent-ui');
    });

    expect(useSubAgentStore.getState().invocations.map(inv => inv.invocationId)).toEqual(['inv-other']);

    act(() => {
      useSubAgentStore.getState().clearInvocationsForParent('other-acp');
    });
    expect(useSubAgentStore.getState().invocations).toEqual([]);
  });

  it('appendToken and appendThought update content', () => {
    act(() => {
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1' } as any);
      useSubAgentStore.getState().appendToken('a1', 'Hello');
      useSubAgentStore.getState().appendThought('a1', 'Think');
    });

    const agent = useSubAgentStore.getState().agents[0];
    expect(agent.tokens).toBe('Hello');
    expect(agent.thoughts).toBe('Think');
  });

  it('manage tool steps', () => {
    act(() => {
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1' } as any);
      useSubAgentStore.getState().addToolStep('a1', 't1', 'Tool 1');
    });
    expect(useSubAgentStore.getState().agents[0].toolSteps).toHaveLength(1);

    act(() => {
      useSubAgentStore.getState().updateToolStep('a1', 't1', 'success', 'done');
    });
    expect(useSubAgentStore.getState().agents[0].toolSteps[0].status).toBe('success');
  });

  it('manage permissions', () => {
    act(() => {
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1' } as any);
      useSubAgentStore.getState().setPermission('a1', { id: 1, sessionId: 'a1', options: [] });
    });
    expect(useSubAgentStore.getState().agents[0].permission).toBeDefined();

    act(() => {
      useSubAgentStore.getState().clearPermission('a1');
    });
    expect(useSubAgentStore.getState().agents[0].permission).toBeNull();
  });

  it('clearForParent removes only specific agents and matching invocations', () => {
    act(() => {
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-p1',
        providerId: 'p1',
        parentUiId: 'parent-ui-1',
        parentSessionId: 'p1',
        statusToolName: 'ux_check_subagents',
        totalCount: 1
      });
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-p2',
        providerId: 'p1',
        parentUiId: 'parent-ui-2',
        parentSessionId: 'p2',
        statusToolName: 'ux_check_subagents',
        totalCount: 1
      });
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a1', parentSessionId: 'p1' } as any);
      useSubAgentStore.getState().addAgent({ acpSessionId: 'a2', parentSessionId: 'p2' } as any);
      useSubAgentStore.getState().clearForParent('p1');
    });
    expect(useSubAgentStore.getState().agents).toHaveLength(1);
    expect(useSubAgentStore.getState().agents[0].acpSessionId).toBe('a2');
    expect(useSubAgentStore.getState().invocations.map(inv => inv.invocationId)).toEqual(['inv-p2']);
  });
});
