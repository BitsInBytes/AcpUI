import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import type { ProviderBranding, ProviderStatus, ProviderSummary, WorkspaceCwd } from '../types';
import type { BrandingModels } from '../utils/modelOptions';

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
  defaultProviderId: string | null;
  activeProviderId: string | null;
  orderedProviderIds: string[];
  providersById: Record<string, ProviderSummary>;
  readyByProviderId: Record<string, boolean>;
  sslError: boolean;
  slashCommands: SlashCommand[];
  slashCommandsByProviderId: Record<string, SlashCommand[]>;
  contextUsageBySession: Record<string, number>;
  providerStatus: ProviderStatus | null;
  providerStatusByProviderId: Record<string, ProviderStatus>;
  compactingBySession: Record<string, boolean>;
  workspaceCwds: WorkspaceCwd[];
  deletePermanent: boolean;
  notificationSound: boolean;
  notificationDesktop: boolean;
  customCommands: { name: string; description: string; prompt?: string | null }[];
  branding: {
    providerId?: string;
    assistantName: string;
    busyText: string;
    emptyChatMessage: string;
    notificationTitle: string;
    appHeader: string;
    sessionLabel: string;
    modelLabel: string;
    models?: BrandingModels;
    defaultModel?: string;
    supportsAgentSwitching?: boolean;
    hooksText?: string;
    warmingUpText?: string;
    resumingText?: string;
    inputPlaceholder?: string;
    protocolPrefix?: string;
    title?: string;
  };

  // Actions
  setSocket: (socket: Socket | null) => void;
  setConnected: (connected: boolean) => void;
  setIsEngineReady: (isReady: boolean) => void;
  setProviderReady: (providerId: string, isReady: boolean) => void;
  setBackendBootId: (bootId: string | null) => void;
  setProviders: (defaultProviderId: string | null, providers: ProviderSummary[]) => void;
  setProviderBranding: (branding: ProviderBranding) => void;
  setSslError: (error: boolean) => void;
  setSlashCommands: (commands: SlashCommand[], providerId?: string) => void;
  setContextUsage: (sessionId: string, pct: number) => void;
  setProviderStatus: (status: ProviderStatus | null, providerId?: string | null) => void;
  setCompacting: (sessionId: string, compacting: boolean) => void;
  setWorkspaceCwds: (cwds: WorkspaceCwd[]) => void;
  setDeletePermanent: (val: boolean) => void;
  setNotificationSettings: (sound: boolean, desktop: boolean) => void;
  setCustomCommands: (commands: { name: string; description: string; prompt?: string | null }[]) => void;
  getBranding: (providerId?: string | null) => SystemState['branding'];
}

export const useSystemStore = create<SystemState>((set, get) => ({
  socket: null,
  connected: false,
  isEngineReady: false,
  backendBootId: null,
  defaultProviderId: null,
  activeProviderId: null,
  orderedProviderIds: [],
  providersById: {},
  readyByProviderId: {},
  sslError: false,
  slashCommands: [],
  slashCommandsByProviderId: {},
  contextUsageBySession: {},
  providerStatus: null,
  providerStatusByProviderId: {},
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
  setProviderReady: (providerId, isReady) => set(state => ({
    readyByProviderId: { ...state.readyByProviderId, [providerId]: isReady },
    isEngineReady: providerId === (state.activeProviderId || state.defaultProviderId) ? isReady : state.isEngineReady
  })),
  setBackendBootId: (bootId) => set({ backendBootId: bootId }),
  setProviders: (defaultProviderId, providers) => set(state => {
    const providersById = Object.fromEntries(providers.map(provider => [provider.providerId, provider]));
    const nextActiveProviderId = state.activeProviderId || defaultProviderId || providers[0]?.providerId || null;
    const activeBranding = nextActiveProviderId ? providersById[nextActiveProviderId]?.branding : null;
    return {
      defaultProviderId,
      activeProviderId: nextActiveProviderId,
      orderedProviderIds: providers.map(p => p.providerId),
      providersById,
      readyByProviderId: {
        ...state.readyByProviderId,
        ...Object.fromEntries(providers.map(provider => [provider.providerId, provider.ready === true]))
      },
      ...(activeBranding ? { branding: activeBranding } : {})
    };
  }),
  setProviderBranding: (branding) => set(state => {
    const providerId = branding.providerId;
    const providersById = {
      ...state.providersById,
      [providerId]: {
        providerId,
        label: state.providersById[providerId]?.label || branding.assistantName || providerId,
        default: providerId === state.defaultProviderId,
        ready: state.readyByProviderId[providerId],
        branding
      }
    };
    const isActiveProvider = providerId === (state.activeProviderId || state.defaultProviderId);
    return {
      providersById,
      ...(isActiveProvider ? { branding } : {})
    };
  }),
  setSslError: (error) => set({ sslError: error }),
  setSlashCommands: (commands, providerId) => set(state => {
    if (providerId) {
      const isActive = providerId === (state.activeProviderId || state.defaultProviderId);
      return {
        slashCommandsByProviderId: { ...state.slashCommandsByProviderId, [providerId]: commands },
        ...(isActive ? { slashCommands: commands } : {})
      };
    }
    return { slashCommands: commands };
  }),
  setContextUsage: (sessionId, pct) => set(state => ({ contextUsageBySession: { ...state.contextUsageBySession, [sessionId]: pct } })),
  setProviderStatus: (status, providerId) => set(state => {
    const resolvedProviderId = providerId || status?.providerId || state.activeProviderId || state.defaultProviderId;
    if (!resolvedProviderId) return { providerStatus: status };
    const providerStatusByProviderId = { ...state.providerStatusByProviderId };
    if (status) providerStatusByProviderId[resolvedProviderId] = { ...status, providerId: resolvedProviderId };
    else delete providerStatusByProviderId[resolvedProviderId];
    const activeProviderId = state.activeProviderId || state.defaultProviderId || resolvedProviderId;
    const isActiveProvider = providerId == null || resolvedProviderId === activeProviderId;
    return {
      providerStatusByProviderId,
      providerStatus: isActiveProvider ? status : state.providerStatus
    };
  }),
  setCompacting: (sessionId, compacting) => set(state => ({ compactingBySession: { ...state.compactingBySession, [sessionId]: compacting } })),
  setWorkspaceCwds: (cwds) => set({ workspaceCwds: cwds }),
  setDeletePermanent: (val) => set({ deletePermanent: val }),
  setNotificationSettings: (sound: boolean, desktop: boolean) => set({ notificationSound: sound, notificationDesktop: desktop }),
  setCustomCommands: (commands) => set({ customCommands: commands }),
  getBranding: (providerId) => {
    const state = get();
    if (providerId && state.providersById[providerId]) {
      return state.providersById[providerId].branding;
    }
    return state.branding;
  },
  }));
