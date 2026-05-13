import { create } from 'zustand';
import { Socket } from 'socket.io-client';
import type { InvalidJsonConfig, ProviderBranding, ProviderStatus, ProviderSummary, WorkspaceCwd } from '../types';
import type { BrandingModels } from '../utils/modelOptions';

export interface SlashCommand {
  name: string;
  description: string;
  meta?: { inputType?: string; hint?: string; optionsMethod?: string; local?: boolean };
}

const UNKNOWN_PROVIDER_KEY = '__unknown_provider__';

export function getProviderSessionKey(providerId: string | null | undefined, sessionId: string) {
  return `${providerId || UNKNOWN_PROVIDER_KEY}::${sessionId}`;
}

function normalizeContextUsage(pct: number) {
  const value = Number(pct);
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
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
  invalidJsonConfigs: InvalidJsonConfig[];
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
  setInvalidJsonConfigs: (issues: InvalidJsonConfig[]) => void;
  setSslError: (error: boolean) => void;
  setSlashCommands: (commands: SlashCommand[], providerId?: string) => void;
  setContextUsage: (providerId: string | null | undefined, sessionId: string, pct: number) => void;
  getContextUsage: (providerId: string | null | undefined, sessionId: string | null | undefined) => number | undefined;
  hasContextUsage: (providerId: string | null | undefined, sessionId: string | null | undefined) => boolean;
  setProviderStatus: (status: ProviderStatus | null, providerId?: string | null) => void;
  setCompacting: (providerId: string | null | undefined, sessionId: string, compacting: boolean) => void;
  getCompacting: (providerId: string | null | undefined, sessionId: string | null | undefined) => boolean;
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
  invalidJsonConfigs: [],
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
  setInvalidJsonConfigs: (issues) => set({ invalidJsonConfigs: issues }),
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
  setContextUsage: (providerId, sessionId, pct) => set(state => {
    const normalizedPct = normalizeContextUsage(pct);
    if (normalizedPct === null) return {};
    const key = getProviderSessionKey(providerId, sessionId);
    return { contextUsageBySession: { ...state.contextUsageBySession, [key]: normalizedPct } };
  }),
  getContextUsage: (providerId, sessionId) => {
    if (!sessionId) return undefined;
    const state = get();
    const key = getProviderSessionKey(providerId, sessionId);
    if (Object.prototype.hasOwnProperty.call(state.contextUsageBySession, key)) {
      return state.contextUsageBySession[key];
    }
    return state.contextUsageBySession[sessionId];
  },
  hasContextUsage: (providerId, sessionId) => {
    if (!sessionId) return false;
    const state = get();
    const key = getProviderSessionKey(providerId, sessionId);
    return Object.prototype.hasOwnProperty.call(state.contextUsageBySession, key)
      || Object.prototype.hasOwnProperty.call(state.contextUsageBySession, sessionId);
  },
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
  setCompacting: (providerId, sessionId, compacting) => set(state => {
    const key = getProviderSessionKey(providerId, sessionId);
    return { compactingBySession: { ...state.compactingBySession, [key]: compacting } };
  }),
  getCompacting: (providerId, sessionId) => {
    if (!sessionId) return false;
    const state = get();
    const key = getProviderSessionKey(providerId, sessionId);
    if (Object.prototype.hasOwnProperty.call(state.compactingBySession, key)) {
      return Boolean(state.compactingBySession[key]);
    }
    return Boolean(state.compactingBySession[sessionId]);
  },
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
