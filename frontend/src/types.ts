// === Socket Event Payloads ===

export interface LoadSessionsResponse {
  sessions?: ChatSession[];
  error?: string;
}

export interface CreateSessionResponse {
  sessionId?: string | null;
  acpSessionId?: string | null;
  error?: string;
  model?: string;
  currentModelId?: string | null;
  modelOptions?: ProviderModelOption[];
  configOptions?: ProviderConfigOption[];
}

export interface ForkSessionResponse {
  success: boolean;
  newUiId?: string;
  newAcpId?: string;
  currentModelId?: string | null;
  modelOptions?: ProviderModelOption[];
  configOptions?: ProviderConfigOption[];
  error?: string;
}

export interface SessionHistoryResponse {
  session?: ChatSession;
  error?: string;
}

export interface StatsResponse {
  stats?: SessionStats;
  error?: string;
}

export interface CanvasLoadResponse {
  artifacts?: CanvasArtifact[];
}

export interface CanvasReadFileResponse {
  artifact?: CanvasArtifact;
  error?: string;
}

export interface CanvasActionResponse {
  success?: boolean;
  error?: string;
}

export interface ListArchivesResponse {
  archives: string[];
}

export interface RestoreArchiveResponse {
  success?: boolean;
  uiId?: string;
  acpSessionId?: string;
  error?: string;
}

export interface VoiceResponse {
  text: string | null;
}

export interface StreamTokenData {
  sessionId: string;
  text: string;
}

export interface StreamEventData {
  sessionId: string;
  type: string;
  id?: string;
  title?: string;
  status?: string;
  output?: string;
  filePath?: string;
  providerId?: string;
  command?: string;
  cwd?: string;
  shellRunId?: string;
  shellInteractive?: boolean;
  shellState?: 'pending' | 'starting' | 'running' | 'exiting' | 'exited';
  options?: PermissionOption[];
  toolCall?: { toolCallId: string; title: string };
}

export interface StreamDoneData {
  sessionId: string;
  error?: boolean;
}

export interface StatsPushData {
  sessionId: string;
  usedTokens?: number;
  totalTokens?: number;
}

export interface ProviderExtensionData {
  providerId?: string;
  method: string;
  params: Record<string, unknown>;
}

export type ProviderStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface ProviderStatusProgress {
  /** Normalized 0..1 progress value. Providers own translating their raw quota or usage data. */
  value: number;
  label?: string;
}

export interface ProviderStatusItem {
  id: string;
  label: string;
  value?: string;
  detail?: string;
  tone?: ProviderStatusTone;
  progress?: ProviderStatusProgress;
}

export interface ProviderStatusSection {
  id: string;
  title?: string;
  items: ProviderStatusItem[];
}

export interface ProviderStatusSummary {
  title?: string;
  items: ProviderStatusItem[];
}

export interface ProviderStatus {
  providerId?: string;
  title?: string;
  subtitle?: string;
  updatedAt?: string;
  summary?: ProviderStatusSummary;
  sections: ProviderStatusSection[];
}

export interface ProviderBranding {
  providerId: string;
  assistantName: string;
  busyText: string;
  emptyChatMessage: string;
  notificationTitle: string;
  appHeader: string;
  sessionLabel: string;
  modelLabel: string;
  models?: import('./utils/modelOptions').BrandingModels;
  defaultModel?: string;
  supportsAgentSwitching?: boolean;
  hooksText?: string;
  warmingUpText?: string;
  resumingText?: string;
  inputPlaceholder?: string;
  protocolPrefix?: string;
  title?: string;
}

export interface ProviderSummary {
  providerId: string;
  label?: string;
  default?: boolean;
  ready?: boolean;
  branding: ProviderBranding;
}

export interface WorkspaceCwd {
  label: string;
  path: string;
  agent?: string;
  pinned?: boolean;
}

// === Existing Types ===

export interface SystemEvent {
  id: string;
  title: string;
  status: 'in_progress' | 'completed' | 'failed' | 'pending_result';
  output?: string;
  filePath?: string;
  toolCategory?: string;
  toolName?: string;
  isShellCommand?: boolean;
  isFileOperation?: boolean;
  _fallbackOutput?: string;
  startTime?: number;
  endTime?: number;
  /** Set by the sub_agents_starting event handler to correlate this ux_invoke_subagents
   *  ToolStep with the specific batch of sub-agents it spawned. Enables per-invocation
   *  filtering in SubAgentPanel so historical turns show their own agents. */
  invocationId?: string;
  /** Shell run id assigned by the backend before ux_invoke_shell starts.
   *  Used for terminal stdin, resize, kill, snapshot replay, and output routing. */
  shellRunId?: string;
  shellInteractive?: boolean;
  shellState?: 'pending' | 'starting' | 'running' | 'exiting' | 'exited';
  providerId?: string;
  sessionId?: string;
  command?: string;
  cwd?: string;
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: 'allow_always' | 'allow_once' | 'reject_once';
}

export interface PermissionRequest {
  id: number;
  options: PermissionOption[];
  toolCall?: {
    toolCallId: string;
    title: string;
  };
}

export type TimelineStep = 
  | { type: 'thought'; content: string; isCollapsed?: boolean }
  | { type: 'tool'; event: SystemEvent; isCollapsed?: boolean }
  | { type: 'text'; content: string; isCollapsed?: boolean }
  | { type: 'permission'; request: PermissionRequest; response?: string; isCollapsed?: boolean };

export interface Attachment {
  name: string;
  path?: string;
  size: number;
  mimeType?: string;
  type?: string; // Legacy/Compat
  data?: string; // Base64 for uploads
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'divider';
  content: string;
  timeline?: TimelineStep[];
  isStreaming?: boolean;
  isArchived?: boolean;
  isDivider?: boolean;
  turnStartTime?: number;
  turnEndTime?: number;
  attachments?: Attachment[];
}

export interface SessionStats {
  sessionId: string;
  sessionPath?: string;
  model: string;
  toolCalls: number;
  successTools: number;
  durationMs: number;
  usedTokens: number;
  totalTokens: number;
  sessionSizeMb: number;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  position: number;
  providerId?: string | null;
}

export interface ProviderConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  kind?: 'reasoning_effort' | 'generic';
  type: 'select' | 'boolean' | 'number';
  currentValue: unknown;
  options?: Array<{ value: string; name: string; description?: string }>;
}

export interface ProviderModelOption {
  id: string;
  name: string;
  description?: string;
}

export interface ChatSession {
  id: string;
  acpSessionId: string | null;
  name: string;
  messages: Message[];
  isTyping: boolean;
  isWarmingUp: boolean;
  isPinned?: boolean;
  hasUnreadResponse?: boolean;
  model: string;
  currentModelId?: string | null;
  modelOptions?: ProviderModelOption[];
  cwd?: string | null;
  folderId?: string | null;
  forkedFrom?: string | null;
  forkPoint?: number | null;
  stats?: SessionStats;
  isAwaitingPermission?: boolean;
  isHooksRunning?: boolean;
  isSubAgent?: boolean;
  parentAcpSessionId?: string | null;
  provider?: string | null;
  configOptions?: ProviderConfigOption[];
}

export interface CanvasArtifact {
  id: string;
  sessionId: string;
  title: string;
  content: string;
  language: string;
  version: number;
  filePath?: string;
  createdAt?: string;
  lastUpdated?: number;
}
