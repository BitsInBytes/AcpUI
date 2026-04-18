import { create } from 'zustand';

/**
 * Parallel UI state for sub-agent sessions spawned by ux_invoke_subagents.
 *
 * Sub-agents have their own ACP sessions but are rendered in a compact panel
 * (not full chat tabs). This store tracks their streaming output, tool steps,
 * and permission requests independently from useChatStore, which only holds
 * the lightweight ChatSession shell for sub-agents.
 *
 * Lifecycle: parent calls clearForParent → addAgent per sub-agent → tokens/events
 * stream in → completeAgent when done.
 */
export interface SubAgentEntry {
  providerId: string;
  acpSessionId: string;
  parentSessionId: string;
  index: number;
  name: string;
  prompt: string;
  agent: string;
  status: 'running' | 'completed' | 'failed';
  tokens: string;
  thoughts: string;
  toolSteps: { id: string; title: string; status: string; output?: string }[];
  permission: { id: number; sessionId: string; options: { optionId: string; name: string; kind: string }[]; toolCall?: { title: string; toolCallId?: string } } | null;
}

interface SubAgentState {
  agents: SubAgentEntry[];
  addAgent: (entry: Omit<SubAgentEntry, 'status' | 'tokens' | 'thoughts' | 'toolSteps' | 'permission'>) => void;
  completeAgent: (acpSessionId: string) => void;
  appendToken: (acpSessionId: string, text: string) => void;
  appendThought: (acpSessionId: string, text: string) => void;
  addToolStep: (acpSessionId: string, id: string, title: string) => void;
  updateToolStep: (acpSessionId: string, id: string, status: string, output?: string) => void;
  setPermission: (acpSessionId: string, permission: SubAgentEntry['permission']) => void;
  clearPermission: (acpSessionId: string) => void;
  clearForParent: (parentSessionId: string) => void;
  clear: () => void;
}

export const useSubAgentStore = create<SubAgentState>((set) => ({
  agents: [],
  addAgent: (entry) => set(state => ({
    agents: [...state.agents, { ...entry, status: 'running', tokens: '', thoughts: '', toolSteps: [], permission: null }]
  })),
  completeAgent: (acpSessionId) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, status: 'completed' } : a)
  })),
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
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, permission } : a)
  })),
  clearPermission: (acpSessionId) => set(state => ({
    agents: state.agents.map(a => a.acpSessionId === acpSessionId ? { ...a, permission: null } : a)
  })),
  clearForParent: (parentSessionId) => set(state => ({
    agents: state.agents.filter(a => a.parentSessionId !== parentSessionId)
  })),
  clear: () => set({ agents: [] }),
}));
