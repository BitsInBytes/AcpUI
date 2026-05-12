import { create } from 'zustand';

/**
 * Parallel UI state for sub-agent sessions spawned by ux_invoke_subagents.
 *
 * Sub-agents have their own ACP sessions but are rendered in a compact panel
 * (not full chat tabs). This store tracks their streaming output, tool steps,
 * and permission requests independently from useChatStore, which only holds
 * the lightweight ChatSession shell for sub-agents.
 *
 * Lifecycle: parent calls clearForParent -> startInvocation -> addAgent per
 * sub-agent -> tokens/events stream in -> completeAgent and completeInvocation.
 */
export type SubAgentStatus = 'spawning' | 'prompting' | 'running' | 'waiting_permission' | 'cancelling' | 'completed' | 'failed' | 'cancelled';

export interface SubAgentInvocationEntry {
  invocationId: string;
  providerId: string;
  parentUiId: string | null;
  parentSessionId: string | null;
  statusToolName: string;
  totalCount: number;
  status: SubAgentStatus;
  startedAt: number;
  completedAt?: number | null;
}

export interface SubAgentEntry {
  providerId: string;
  acpSessionId: string;
  parentSessionId: string;
  /** Unique ID for the specific ux_invoke_subagents call that spawned this agent.
   *  Correlates agents to the ToolStep that owns them, enabling per-invocation
   *  filtering so historical turns each show their own agents. */
  invocationId: string;
  index: number;
  name: string;
  prompt: string;
  agent: string;
  status: SubAgentStatus;
  tokens: string;
  thoughts: string;
  toolSteps: { id: string; title: string; status: string; output?: string }[];
  permission: { id: number; sessionId: string; options: { optionId: string; name: string; kind: string }[]; toolCall?: { title: string; toolCallId?: string } } | null;
}

interface SubAgentState {
  invocations: SubAgentInvocationEntry[];
  agents: SubAgentEntry[];
  startInvocation: (entry: Omit<SubAgentInvocationEntry, 'status' | 'startedAt'> & { status?: SubAgentStatus; startedAt?: number }) => void;
  setInvocationStatus: (invocationId: string, status: SubAgentStatus) => void;
  completeInvocation: (invocationId: string, status: Extract<SubAgentStatus, 'completed' | 'failed' | 'cancelled'>) => void;
  isInvocationActive: (invocationId?: string | null) => boolean;
  clearInvocationsForParent: (parentUiIdOrSessionId: string) => void;
  addAgent: (entry: Omit<SubAgentEntry, 'status' | 'tokens' | 'thoughts' | 'toolSteps' | 'permission'>) => void;
  setStatus: (acpSessionId: string, status: SubAgentStatus) => void;
  completeAgent: (acpSessionId: string, status?: SubAgentStatus) => void;
  appendToken: (acpSessionId: string, text: string) => void;
  appendThought: (acpSessionId: string, text: string) => void;
  addToolStep: (acpSessionId: string, id: string, title: string) => void;
  updateToolStep: (acpSessionId: string, id: string, status: string, output?: string) => void;
  setPermission: (acpSessionId: string, permission: SubAgentEntry['permission']) => void;
  clearPermission: (acpSessionId: string) => void;
  clearForParent: (parentSessionId: string) => void;
  clear: () => void;
}

const ACTIVE_STATUSES = new Set<SubAgentStatus>(['spawning', 'prompting', 'running', 'waiting_permission', 'cancelling']);
const TERMINAL_STATUSES = new Set<SubAgentStatus>(['completed', 'failed', 'cancelled']);

function invocationStatusFromAgents(agents: SubAgentEntry[], invocationId: string): SubAgentStatus {
  const scoped = agents.filter(a => a.invocationId === invocationId);
  if (scoped.length === 0) return 'running';
  if (scoped.some(a => ACTIVE_STATUSES.has(a.status))) return 'running';
  if (scoped.some(a => a.status === 'failed')) return 'failed';
  if (scoped.some(a => a.status === 'cancelled')) return 'cancelled';
  return 'completed';
}

export const useSubAgentStore = create<SubAgentState>((set, get) => ({
  invocations: [],
  agents: [],
  startInvocation: (entry) => set(state => {
    const next: SubAgentInvocationEntry = {
      ...entry,
      status: entry.status || 'spawning',
      startedAt: entry.startedAt || Date.now(),
      completedAt: null
    };
    return {
      invocations: [next, ...state.invocations.filter(inv => inv.invocationId !== next.invocationId)]
    };
  }),
  setInvocationStatus: (invocationId, status) => set(state => ({
    invocations: state.invocations.map(inv => inv.invocationId === invocationId
      ? { ...inv, status, completedAt: TERMINAL_STATUSES.has(status) ? Date.now() : inv.completedAt }
      : inv)
  })),
  completeInvocation: (invocationId, status) => set(state => ({
    invocations: state.invocations.map(inv => inv.invocationId === invocationId
      ? { ...inv, status, completedAt: Date.now() }
      : inv)
  })),
  isInvocationActive: (invocationId) => {
    if (!invocationId) return false;
    const invocation = get().invocations.find(inv => inv.invocationId === invocationId);
    if (invocation && ACTIVE_STATUSES.has(invocation.status)) return true;
    return get().agents.some(agent => agent.invocationId === invocationId && ACTIVE_STATUSES.has(agent.status));
  },
  clearInvocationsForParent: (parentUiIdOrSessionId) => set(state => ({
    invocations: state.invocations.filter(inv => inv.parentUiId !== parentUiIdOrSessionId && inv.parentSessionId !== parentUiIdOrSessionId)
  })),
  addAgent: (entry) => set(state => ({
    agents: [...state.agents.filter(a => a.acpSessionId !== entry.acpSessionId), { ...entry, status: 'spawning', tokens: '', thoughts: '', toolSteps: [], permission: null }]
  })),
  setStatus: (acpSessionId, status) => set(state => {
    const agents = state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, status } : a);
    const changedAgent = agents.find(a => a.acpSessionId === acpSessionId);
    const invocations = changedAgent
      ? state.invocations.map(inv => inv.invocationId === changedAgent.invocationId
        ? { ...inv, status: invocationStatusFromAgents(agents, inv.invocationId), completedAt: TERMINAL_STATUSES.has(invocationStatusFromAgents(agents, inv.invocationId)) ? Date.now() : inv.completedAt }
        : inv)
      : state.invocations;
    return { agents, invocations };
  }),
  completeAgent: (acpSessionId, status = 'completed') => set(state => {
    const agents = state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, status } : a);
    const changedAgent = agents.find(a => a.acpSessionId === acpSessionId);
    const invocations = changedAgent
      ? state.invocations.map(inv => inv.invocationId === changedAgent.invocationId
        ? { ...inv, status: invocationStatusFromAgents(agents, inv.invocationId), completedAt: TERMINAL_STATUSES.has(invocationStatusFromAgents(agents, inv.invocationId)) ? Date.now() : inv.completedAt }
        : inv)
      : state.invocations;
    return { agents, invocations };
  }),
  appendToken: (acpSessionId, text) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, tokens: a.tokens + text } : a)
  })),
  appendThought: (acpSessionId, text) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, thoughts: a.thoughts + text } : a)
  })),
  addToolStep: (acpSessionId, id, title) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId
      ? { ...a, toolSteps: [...a.toolSteps, { id, title, status: 'in_progress' }] }
      : a)
  })),
  updateToolStep: (acpSessionId, id, status, output) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId
      ? { ...a, toolSteps: a.toolSteps.map(t => t.id === id ? { ...t, status, output: output || t.output } : t) }
      : a)
  })),
  setPermission: (acpSessionId, permission) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, permission, status: permission ? 'waiting_permission' : a.status } : a)
  })),
  clearPermission: (acpSessionId) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, permission: null, status: a.status === 'waiting_permission' ? 'running' : a.status } : a)
  })),
  clearForParent: (parentSessionId) => set(state => ({
    agents: state.agents.filter(a => a.parentSessionId !== parentSessionId),
    invocations: state.invocations.filter(inv => inv.parentSessionId !== parentSessionId && inv.parentUiId !== parentSessionId)
  })),
  clear: () => set({ invocations: [], agents: [] }),
}));
