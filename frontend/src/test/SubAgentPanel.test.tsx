import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import SubAgentPanel from '../components/SubAgentPanel';
import { useSubAgentStore } from '../store/useSubAgentStore';
import type { SubAgentEntry } from '../store/useSubAgentStore';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

const makeAgent = (overrides: Partial<SubAgentEntry> = {}): SubAgentEntry => ({
  providerId: 'provider-a',
  acpSessionId: 'acp-1',
  parentSessionId: 'parent-1',
  invocationId: 'inv-test-1',
  index: 0,
  name: 'Research',
  prompt: 'Do research',
  agent: 'agent-dev',
  status: 'running',
  tokens: '',
  thoughts: '',
  toolSteps: [],
  permission: null,
  ...overrides,
});

describe('SubAgentPanel', () => {
  beforeEach(() => {
    act(() => {
      useSubAgentStore.getState().clear();
      useSystemStore.setState({ socket: null });
      useSessionLifecycleStore.setState({
        sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'parent-1' }],
        activeSessionId: 's1',
      });
    });
  });

  it('renders nothing when no agents', () => {
    const { container } = render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when invocationId is undefined', () => {
    act(() => {
      useSubAgentStore.setState({ agents: [makeAgent()] });
    });
    const { container } = render(<SubAgentPanel />);
    expect(container.firstChild).toBeNull();
  });

  it('renders nothing when invocationId does not match any agent', () => {
    act(() => {
      useSubAgentStore.setState({ agents: [makeAgent({ invocationId: 'inv-other' })] });
    });
    const { container } = render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders only agents matching the invocationId', () => {
    act(() => {
      useSubAgentStore.setState({
        agents: [
          makeAgent({ invocationId: 'inv-test-1', name: 'Research' }),
          makeAgent({ acpSessionId: 'acp-other', invocationId: 'inv-other', name: 'OtherAgent', index: 0 }),
        ],
      });
    });
    render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(screen.getByText(/Research/)).toBeInTheDocument();
    expect(screen.queryByText(/OtherAgent/)).not.toBeInTheDocument();
  });

  it('renders agent cards with status and name', () => {
    act(() => {
      useSubAgentStore.setState({
        agents: [
          makeAgent(),
          makeAgent({ acpSessionId: 'acp-2', index: 1, name: 'Implement', status: 'completed' }),
        ],
      });
    });
    const { container } = render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(screen.getByText(/Research/)).toBeInTheDocument();
    expect(screen.getByText(/Implement/)).toBeInTheDocument();
    expect(container.querySelector('.sub-agent-status.running svg')).toBeInTheDocument();
    expect(container.querySelector('.sub-agent-status.completed svg')).toBeInTheDocument();
  });

  it('renders tool steps', () => {
    act(() => {
      useSubAgentStore.setState({
        agents: [makeAgent({
          toolSteps: [
            { id: 't1', title: 'Read file', status: 'in_progress' },
            { id: 't2', title: 'Write file', status: 'done' },
          ],
        })],
      });
    });
    const { container } = render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(screen.getByText('Read file')).toBeInTheDocument();
    expect(screen.getByText('Write file')).toBeInTheDocument();
    expect(container.querySelector('.sub-agent-tool.in_progress svg')).toBeInTheDocument();
    expect(container.querySelector('.sub-agent-tool.done svg')).toBeInTheDocument();
  });

  it('emits cancel_subagents and marks active invocation as cancelling', () => {
    const socket = { emit: vi.fn() };
    act(() => {
      useSystemStore.setState({ socket: socket as any });
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-test-1',
        providerId: 'provider-a',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-1',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'running'
      });
      useSubAgentStore.setState({ agents: [makeAgent()] });
    });

    render(<SubAgentPanel invocationId="inv-test-1" />);
    fireEvent.click(screen.getByRole('button', { name: /stop/i }));

    expect(socket.emit).toHaveBeenCalledWith('cancel_subagents', {
      providerId: 'provider-a',
      invocationId: 'inv-test-1'
    });
    expect(useSubAgentStore.getState().invocations[0].status).toBe('cancelling');
  });

  it('renders permission buttons', () => {
    act(() => {
      useSubAgentStore.setState({
        agents: [makeAgent({
          permission: {
            id: 1,
            sessionId: 's1',
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow' },
              { optionId: 'deny', name: 'Deny', kind: 'deny' },
            ],
            toolCall: { title: 'Execute shell' },
          },
        })],
      });
    });
    render(<SubAgentPanel invocationId="inv-test-1" />);
    expect(screen.getByText(/Execute shell/)).toBeInTheDocument();
    expect(screen.getByText('Allow')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
  });

  it('emits permission responses with the invocation provider and clears local permission', () => {
    const socket = { emit: vi.fn() };
    act(() => {
      useSystemStore.setState({ socket: socket as any });
      useSubAgentStore.getState().startInvocation({
        invocationId: 'inv-test-1',
        providerId: 'provider-a',
        parentUiId: 'parent-ui',
        parentSessionId: 'parent-1',
        statusToolName: 'ux_check_subagents',
        totalCount: 1,
        status: 'running'
      });
      useSubAgentStore.setState({
        agents: [makeAgent({
          permission: {
            id: 42,
            sessionId: 'acp-1',
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow' }],
            toolCall: { title: 'Execute shell', toolCallId: 'tool-1' },
          },
        })],
      });
    });

    render(<SubAgentPanel invocationId="inv-test-1" />);
    fireEvent.click(screen.getByText('Allow'));

    expect(socket.emit).toHaveBeenCalledWith('respond_permission', {
      providerId: 'provider-a',
      id: 42,
      sessionId: 'acp-1',
      optionId: 'allow',
      toolCallId: 'tool-1'
    });
    expect(useSubAgentStore.getState().agents[0].permission).toBeNull();
  });
});
