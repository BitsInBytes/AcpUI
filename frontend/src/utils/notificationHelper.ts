/**
 * Pure helper functions for notification logic.
 * Extracted from useChatManager for testability.
 */

export interface NotificationSettings {
  notificationSound: boolean;
  notificationDesktop: boolean;
}

export interface NotificationResult {
  shouldSound: boolean;
  shouldDesktop: boolean;
  body: string;
}

export function shouldNotify(
  sessionAcpId: string,
  activeAcpId: string | null | undefined,
  sessionName: string | undefined,
  workspaceCwds: readonly { path: string; label: string }[],
  sessionCwd: string | null | undefined,
  settings: NotificationSettings
): NotificationResult | null {
  // Only notify for background (non-active) sessions
  if (sessionAcpId === activeAcpId) return null;
  if (!sessionName) return null;

  const wsLabel = sessionCwd ? workspaceCwds.find(w => w.path === sessionCwd)?.label : undefined;
  const body = `${sessionName}${wsLabel ? ` (${wsLabel})` : ''} agent has finished`;

  return {
    shouldSound: settings.notificationSound,
    shouldDesktop: settings.notificationDesktop,
    body,
  };
}
