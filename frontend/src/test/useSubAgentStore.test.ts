import { describe, it, expect, beforeEach } from 'vitest';
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
    expect(useSubAgentStore.getState().agents[0].status).toBe('running');

    act(() => {
        useSubAgentStore.getState().completeAgent('a1');
    });
    expect(useSubAgentStore.getState().agents[0].status).toBe('completed');
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

  it('clearForParent removes only specific agents', () => {
    act(() => {
        useSubAgentStore.getState().addAgent({ acpSessionId: 'a1', parentSessionId: 'p1' } as any);
        useSubAgentStore.getState().addAgent({ acpSessionId: 'a2', parentSessionId: 'p2' } as any);
        useSubAgentStore.getState().clearForParent('p1');
    });
    expect(useSubAgentStore.getState().agents).toHaveLength(1);
    expect(useSubAgentStore.getState().agents[0].acpSessionId).toBe('a2');
  });
});
