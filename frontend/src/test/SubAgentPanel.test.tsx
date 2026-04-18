import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import SubAgentPanel from '../components/SubAgentPanel';
import { useSubAgentStore } from '../store/useSubAgentStore';
import type { SubAgentEntry } from '../store/useSubAgentStore';
import { useSystemStore } from '../store/useSystemStore';
import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

const makeAgent = (overrides: Partial<SubAgentEntry> = {}): SubAgentEntry => ({
  providerId: 'provider-a',
  acpSessionId: 'acp-1',
  parentSessionId: 'parent-1',
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
      useSubAgentStore.setState({ agents: [] });
      useSystemStore.setState({ socket: null });
      useSessionLifecycleStore.setState({ sessions: [{ id: 's1', name: 'Test', messages: [], model: 'balanced', isTyping: false, isWarmingUp: false, acpSessionId: 'parent-1' }],
        activeSessionId: 's1', });
    });
  });

  it('renders nothing when no agents', () => {
    const { container } = render(<SubAgentPanel />);
    expect(container.firstChild).toBeNull();
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
    render(<SubAgentPanel />);
    expect(screen.getByText(/Research/)).toBeInTheDocument();
    expect(screen.getByText(/Implement/)).toBeInTheDocument();
    expect(screen.getByText('🟢')).toBeInTheDocument();
    expect(screen.getByText('✅')).toBeInTheDocument();
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
    render(<SubAgentPanel />);
    expect(screen.getByText('Read file')).toBeInTheDocument();
    expect(screen.getByText('Write file')).toBeInTheDocument();
    expect(screen.getByText('⏳')).toBeInTheDocument();
    expect(screen.getByText('✓')).toBeInTheDocument();
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
    render(<SubAgentPanel />);
    expect(screen.getByText(/Execute shell/)).toBeInTheDocument();
    expect(screen.getByText('Allow')).toBeInTheDocument();
    expect(screen.getByText('Deny')).toBeInTheDocument();
  });
});
