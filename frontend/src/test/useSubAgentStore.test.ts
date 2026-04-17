import { describe, it, expect, beforeEach } from 'vitest';
import { useSubAgentStore } from '../store/useSubAgentStore';
import { act } from 'react-dom/test-utils';

const makeAgent = (overrides = {}) => ({
  acpSessionId: 'acp-1',
  parentSessionId: 'parent-1',
  index: 0,
  name: 'Test Agent',
  prompt: 'Do something',
  agent: 'agent-dev',
  ...overrides,
});

describe('useSubAgentStore', () => {
  beforeEach(() => {
    act(() => { useSubAgentStore.setState({ agents: [] }); });
  });

  it('addAgent adds entry with defaults', () => {
    act(() => { useSubAgentStore.getState().addAgent(makeAgent()); });
    const agent = useSubAgentStore.getState().agents[0];
    expect(agent).toMatchObject({
      acpSessionId: 'acp-1',
      name: 'Test Agent',
      status: 'running',
      tokens: '',
      thoughts: '',
      toolSteps: [],
      permission: null,
    });
  });

  it('completeAgent sets status to completed', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().completeAgent('acp-1');
    });
    expect(useSubAgentStore.getState().agents[0].status).toBe('completed');
  });

  it('appendToken appends to correct agent', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addAgent(makeAgent({ acpSessionId: 'acp-2' }));
      useSubAgentStore.getState().appendToken('acp-1', 'hello');
      useSubAgentStore.getState().appendToken('acp-1', ' world');
    });
    expect(useSubAgentStore.getState().agents[0].tokens).toBe('hello world');
    expect(useSubAgentStore.getState().agents[1].tokens).toBe('');
  });

  it('appendThought appends to correct agent', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addAgent(makeAgent({ acpSessionId: 'acp-2' }));
      useSubAgentStore.getState().appendThought('acp-2', 'thinking');
    });
    expect(useSubAgentStore.getState().agents[0].thoughts).toBe('');
    expect(useSubAgentStore.getState().agents[1].thoughts).toBe('thinking');
  });

  it('addToolStep adds tool step', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addToolStep('acp-1', 'tool-1', 'Read file');
    });
    expect(useSubAgentStore.getState().agents[0].toolSteps).toEqual([
      { id: 'tool-1', title: 'Read file', status: 'in_progress' },
    ]);
  });

  it('updateToolStep updates status and output', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addToolStep('acp-1', 'tool-1', 'Read file');
      useSubAgentStore.getState().updateToolStep('acp-1', 'tool-1', 'done', 'file contents');
    });
    const step = useSubAgentStore.getState().agents[0].toolSteps[0];
    expect(step.status).toBe('done');
    expect(step.output).toBe('file contents');
  });

  it('setPermission sets permission on agent', () => {
    const perm = { id: 1, sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }] };
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().setPermission('acp-1', perm);
    });
    expect(useSubAgentStore.getState().agents[0].permission).toEqual(perm);
  });

  it('clearPermission clears permission', () => {
    const perm = { id: 1, sessionId: 's1', options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }] };
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().setPermission('acp-1', perm);
      useSubAgentStore.getState().clearPermission('acp-1');
    });
    expect(useSubAgentStore.getState().agents[0].permission).toBeNull();
  });

  it('clearForParent removes only matching parent', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addAgent(makeAgent({ acpSessionId: 'acp-2', parentSessionId: 'parent-2' }));
      useSubAgentStore.getState().clearForParent('parent-1');
    });
    const agents = useSubAgentStore.getState().agents;
    expect(agents).toHaveLength(1);
    expect(agents[0].parentSessionId).toBe('parent-2');
  });

  it('clear removes all', () => {
    act(() => {
      useSubAgentStore.getState().addAgent(makeAgent());
      useSubAgentStore.getState().addAgent(makeAgent({ acpSessionId: 'acp-2' }));
      useSubAgentStore.getState().clear();
    });
    expect(useSubAgentStore.getState().agents).toEqual([]);
  });
});
