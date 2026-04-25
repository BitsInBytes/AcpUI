import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import type { WorkspaceCwd } from '../types';

export interface SlashCommand {
  name: string;
  description: string;
  meta?: { inputType?: string; hint?: string; optionsMethod?: string; local?: boolean };
}

interface SystemState {
  socket: Socket | null;
  connected: boolean;
  isEngineReady: boolean;
  backendBootId: string | null;
  sslError: boolean;
  slashCommands: SlashCommand[];
  contextUsageBySession: Record<string, number>;
  compactingBySession: Record<string, boolean>;
  workspaceCwds: WorkspaceCwd[];
  deletePermanent: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  customCommands: { name: string; description: string; prompt?: string | null }[];
  branding: {
    assistantName: string;
    busyText: string;
    emptyChatMessage: string;
    notificationTitle: string;
    appHeader: string;
    sessionLabel: string;
    modelLabel: string;
    models?: {
      default?: string;
      flagship?: { id: string; displayName: string };
      balanced?: { id: string; displayName: string };
      fast?: { id: string; displayName: string };
    };
    defaultModel?: string;
    supportsAgentSwitching?: boolean;
    hooksText?: string;
    warmingUpText?: string;
    resumingText?: string;
    inputPlaceholder?: string;
    protocolPrefix?: string;
  };

  // Actions
  setSocket: (socket: Socket | null) => void;
  setConnected: (connected: boolean) => void;
  setIsEngineReady: (isReady: boolean) => void;
  setBackendBootId: (bootId: string | null) => void;
  setSslError: (error: boolean) => void;
  setSlashCommands: (commands: SlashCommand[]) => void;
  setContextUsage: (sessionId: string, pct: number) => void;
  setCompacting: (sessionId: string, compacting: boolean) => void;
  setWorkspaceCwds: (cwds: WorkspaceCwd[]) => void;
  setDeletePermanent: (val: boolean) => void;
  setNotificationSettings: (sound: boolean, desktop: boolean) => void;
  setCustomCommands: (commands: { name: string; description: string; prompt?: string | null }[]) => void;
}

export const useSystemStore = create<SystemState>((set) => ({
  socket: null,
  connected: false,
  isEngineReady: false,
  backendBootId: null,
  sslError: false,
  slashCommands: [],
  contextUsageBySession: {},
  compactingBySession: {},
  workspaceCwds: [],
  deletePermanent: false,
  notificationSound: true,
  notificationDesktop: false,
  customCommands: [],
  branding: {
    assistantName: 'Assistant',
    busyText: 'Working...',
    emptyChatMessage: 'Send a message to start.',
    notificationTitle: 'ACP UI',
    appHeader: 'ACP UI',
    sessionLabel: 'Session',
    modelLabel: 'Model',
  },

  setSocket: (socket) => set({ socket }),
  setConnected: (connected) => set({ connected }),
  setIsEngineReady: (isReady) => set({ isEngineReady: isReady }),
  setBackendBootId: (bootId) => set({ backendBootId: bootId }),
  setSslError: (error) => set({ sslError: error }),
  setSlashCommands: (commands) => set({ slashCommands: commands }),
  setContextUsage: (sessionId, pct) => set(state => ({ contextUsageBySession: { ...state.contextUsageBySession, [sessionId]: pct } })),
  setCompacting: (sessionId, compacting) => set(state => ({ compactingBySession: { ...state.compactingBySession, [sessionId]: compacting } })),
  setWorkspaceCwds: (cwds) => set({ workspaceCwds: cwds }),
  setDeletePermanent: (val) => set({ deletePermanent: val }),
  setNotificationSettings: (sound, desktop) => set({ notificationSound: sound, notificationDesktop: desktop }),
  setCustomCommands: (commands) => set({ customCommands: commands }),
}));
