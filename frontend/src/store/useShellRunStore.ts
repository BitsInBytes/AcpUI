import { create } from 'zustand';

const MAX_STORED_SHELL_RUNS = 50;

export type ShellRunStatus = 'pending' | 'starting' | 'running' | 'exiting' | 'exited';

export interface ShellRunSnapshot {
  providerId: string;
  sessionId: string;
  runId: string;
  toolCallId?: string | null;
  mcpRequestId?: string | number | null;
  status: ShellRunStatus;
  command?: string;
  cwd?: string;
  transcript?: string;
  exitCode?: number | null;
  reason?: string | null;
  maxLines?: number;
  updatedAt?: number;
}

interface ShellRunState {
  runs: Record<string, ShellRunSnapshot>;
  upsertSnapshot: (snapshot: ShellRunSnapshot) => void;
  markStarted: (snapshot: ShellRunSnapshot) => void;
  appendOutput: (payload: { providerId: string; sessionId: string; runId: string; chunk: string; maxLines?: number }) => void;
  markExited: (payload: { providerId: string; sessionId: string; runId: string; exitCode?: number | null; reason?: string | null; finalText?: string }) => void;
  reset: () => void;
}

export function trimShellTranscript(output: string, maxLines?: number | null) {
  if (!output || !Number.isInteger(maxLines) || !maxLines || maxLines <= 0) return output;

  const lines = output.split(/\r?\n/);
  const hasTrailingNewline = /\r?\n$/.test(output);
  const lineCount = hasTrailingNewline ? lines.length - 1 : lines.length;
  if (lineCount <= maxLines) return output;

  const start = lineCount - maxLines;
  const tail = lines.slice(start, hasTrailingNewline ? -1 : undefined).join('\n');
  return hasTrailingNewline ? `${tail}\n` : tail;
}

export function pruneShellRuns(runs: Record<string, ShellRunSnapshot>, maxRuns = MAX_STORED_SHELL_RUNS) {
  const entries = Object.entries(runs);
  if (entries.length <= maxRuns) return runs;

  const active = entries.filter(([, run]) => run.status !== 'exited');
  const exited = entries
    .filter(([, run]) => run.status === 'exited')
    .sort(([, a], [, b]) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const exitedToKeep = exited.slice(0, Math.max(maxRuns - active.length, 0));

  return Object.fromEntries([...active, ...exitedToKeep]);
}

export const useShellRunStore = create<ShellRunState>((set) => ({
  runs: {},

  upsertSnapshot: (snapshot) => set(state => {
    const nextRuns: Record<string, ShellRunSnapshot> = {
      ...state.runs,
      [snapshot.runId]: {
        ...state.runs[snapshot.runId],
        ...snapshot,
        transcript: snapshot.transcript ?? state.runs[snapshot.runId]?.transcript ?? '',
        updatedAt: Date.now()
      }
    };
    return { runs: pruneShellRuns(nextRuns) };
  }),

  markStarted: (snapshot) => set(state => {
    const existing = state.runs[snapshot.runId];
    const nextRuns: Record<string, ShellRunSnapshot> = {
      ...state.runs,
      [snapshot.runId]: {
        ...existing,
        ...snapshot,
        status: snapshot.status || 'running',
        transcript: snapshot.transcript ?? existing?.transcript ?? '',
        updatedAt: Date.now()
      }
    };
    return { runs: pruneShellRuns(nextRuns) };
  }),

  appendOutput: ({ providerId, sessionId, runId, chunk, maxLines }) => set(state => {
    const existing = state.runs[runId];
    const effectiveMaxLines = maxLines || existing?.maxLines;
    const nextRuns: Record<string, ShellRunSnapshot> = {
      ...state.runs,
      [runId]: {
        ...existing,
        providerId: existing?.providerId || providerId,
        sessionId: existing?.sessionId || sessionId,
        runId,
        status: existing?.status === 'exited' ? 'exited' : 'running',
        maxLines: effectiveMaxLines,
        transcript: trimShellTranscript(`${existing?.transcript || ''}${chunk || ''}`, effectiveMaxLines),
        updatedAt: Date.now()
      }
    };
    return { runs: pruneShellRuns(nextRuns) };
  }),

  markExited: ({ providerId, sessionId, runId, exitCode = null, reason = null }) => set(state => {
    const existing = state.runs[runId];
    const nextRuns: Record<string, ShellRunSnapshot> = {
      ...state.runs,
      [runId]: {
        ...existing,
        providerId: existing?.providerId || providerId,
        sessionId: existing?.sessionId || sessionId,
        runId,
        status: 'exited',
        exitCode,
        reason,
        updatedAt: Date.now()
      }
    };
    return { runs: pruneShellRuns(nextRuns) };
  }),

  reset: () => set({ runs: {} })
}));
