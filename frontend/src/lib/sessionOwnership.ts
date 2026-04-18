/**
 * Session Ownership Manager
 * 
 * Coordinates which browser window "owns" each chat session using BroadcastChannel.
 * The owning window processes streaming events; non-owners ignore them.

 */

import { useSessionLifecycleStore } from '../store/useSessionLifecycleStore';

type OwnershipMessage =
  | { type: 'claim'; sessionId: string; windowId: string }
  | { type: 'release'; sessionId: string; windowId: string }
  | { type: 'query' }
  | { type: 'announce'; sessionId: string; windowId: string };

const CHANNEL_NAME = 'acpui-session-ownership';
const windowId = `win-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Sessions owned by OTHER windows (not this one)
const poppedOutSessions = new Map<string, string>(); // sessionId → ownerWindowId
const popoutWindows = new Map<string, Window>(); // sessionId → window reference

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel {
  if (!channel) {
    channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (e: MessageEvent<OwnershipMessage>) => {
      const msg = e.data;
      if (msg.type === 'claim' && msg.windowId !== windowId) {
        poppedOutSessions.set(msg.sessionId, msg.windowId);
        onOwnershipChange?.(msg.sessionId, true);
      } else if (msg.type === 'release' && msg.windowId !== windowId) {
        poppedOutSessions.delete(msg.sessionId);
        popoutWindows.delete(msg.sessionId);
        onOwnershipChange?.(msg.sessionId, false);
      } else if (msg.type === 'query') {
        // Another window is asking who owns what — announce our claims
        // Only announce if WE are the owner (we're a pop-out)
        // If we're a pop-out, announce our session
        const popoutId = new URLSearchParams(window.location.search).get('popout');
        if (popoutId) {
          channel?.postMessage({ type: 'announce', sessionId: popoutId, windowId });
        }
      } else if (msg.type === 'announce' && msg.windowId !== windowId) {
        poppedOutSessions.set(msg.sessionId, msg.windowId);
        onOwnershipChange?.(msg.sessionId, true);
      }
    };
    // On load, query existing pop-outs
    channel.postMessage({ type: 'query' });
  }
  return channel;
}

let onOwnershipChange: ((sessionId: string, isPoppedOut: boolean) => void) | null = null;

export function setOwnershipChangeCallback(cb: (sessionId: string, isPoppedOut: boolean) => void) {
  onOwnershipChange = cb;
  getChannel(); // ensure channel is initialized
}

export function claimSession(sessionId: string) {
  getChannel().postMessage({ type: 'claim', sessionId, windowId });
}

export function releaseSession(sessionId: string) {
  getChannel().postMessage({ type: 'release', sessionId, windowId });
  poppedOutSessions.delete(sessionId);
}

export function isSessionPoppedOut(sessionId: string): boolean {
  return poppedOutSessions.has(sessionId);
}

export function getWindowId(): string {
  return windowId;
}

export async function openPopout(sessionId: string): Promise<Window | null> {
  const existing = popoutWindows.get(sessionId);
  if (existing && !existing.closed) {
    existing.focus();
    return existing;
  }
  const win = window.open(`/?popout=${sessionId}`, `popout-${sessionId}`, 'width=1000,height=750');
  if (win) {
    popoutWindows.set(sessionId, win);
    // Switch main window away from the popped-out session
    const { activeSessionId } = useSessionLifecycleStore.getState();
    if (activeSessionId === sessionId) {
      useSessionLifecycleStore.getState().setActiveSessionId(null);
    }
  }
  return win;
}

export function focusPopout(sessionId: string): boolean {
  const win = popoutWindows.get(sessionId);
  if (win && !win.closed) {
    win.focus();
    return true;
  }
  return false;
}

// Release all on window close
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    const popoutId = new URLSearchParams(window.location.search).get('popout');
    if (popoutId) {
      releaseSession(popoutId);
    }
  });
}
