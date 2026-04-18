/**
 * Pure helper for session switch logic.
 * Extracted from App.tsx for testability.
 */

interface SessionSwitchInput {
  prevSessionId: string | null;
  newSessionId: string | null;
  sessions: { id: string; acpSessionId: string | null }[];
  terminals: { id: string; sessionId: string }[];
  canvasOpenBySession: Record<string, boolean>;
}

export interface SessionSwitchResult {
  unwatchAcpId: string | null;
  watchAcpId: string | null;
  canvasOpen: boolean;
  activeTerminalId: string | null;
}

export function computeSessionSwitch(input: SessionSwitchInput): SessionSwitchResult {
  const { prevSessionId, newSessionId, sessions, terminals, canvasOpenBySession } = input;

  const prevSession = sessions.find(s => s.id === prevSessionId);
  const newSession = sessions.find(s => s.id === newSessionId);
  const sessionTerminals = terminals.filter(t => t.sessionId === newSessionId);
  const savedOpen = canvasOpenBySession[newSessionId || ''] ?? false;

  return {
    unwatchAcpId: prevSession?.acpSessionId || null,
    watchAcpId: newSession?.acpSessionId || null,
    canvasOpen: savedOpen || sessionTerminals.length > 0,
    activeTerminalId: sessionTerminals.length > 0 ? sessionTerminals[0].id : null,
  };
}
