# Feature Doc — Pop Out Chat

Allows users to open a chat session in a detached browser window while coordinating session state across multiple windows using the BroadcastChannel API.

---

## Overview

### What It Does
- Opens a selected chat session in a separate browser window (width=1000px, height=750px)
- Isolates session ownership to prevent simultaneous editing in main and pop-out windows
- Maintains session synchronization across windows via BroadcastChannel messaging
- Hides sidebar, system settings, and file explorer buttons in the pop-out window
- Supports full canvas pane functionality in the pop-out (split-screen editor)
- Automatically switches main window away from the popped-out session
- Restores session to main window when pop-out is closed

### Why This Matters
- Users can compare multiple chats side-by-side on multi-monitor setups
- Prevents streaming conflicts when the same session receives updates in two windows
- Maintains a clean separation between main navigation and focused chat windows
- Reduces cognitive load by hiding irrelevant UI elements in pop-out mode

---

## How It Works — End-to-End Flow

### 1. User Clicks "Pop Out" Button in Sidebar
**File:** `frontend/src/components/SessionItem.tsx` (Lines 87-89)

```javascript
<button 
  className="session-action-btn" 
  title="Pop Out" 
  onClick={(e) => { e.stopPropagation(); openPopout(session.id); }}
>
  <ExternalLink size={12} />
</button>
```

The ExternalLink icon appears in the session actions menu. Clicking invokes `openPopout(sessionId)` from the sessionOwnership module.

### 2. openPopout() Opens New Window and Claims Ownership
**File:** `frontend/src/lib/sessionOwnership.ts` (Lines 81-97)

```typescript
export async function openPopout(sessionId: string): Promise<Window | null> {
  const existing = popoutWindows.get(sessionId);  // LINE 82
  if (existing && !existing.closed) {
    existing.focus();
    return existing;
  }
  const win = window.open(`/?popout=${sessionId}`, `popout-${sessionId}`, 'width=1000,height=750');  // LINE 87
  if (win) {
    popoutWindows.set(sessionId, win);  // LINE 89
    // Switch main window away from the popped-out session
    const { activeSessionId } = useSessionLifecycleStore.getState();  // LINE 91
    if (activeSessionId === sessionId) {
      useSessionLifecycleStore.getState().setActiveSessionId(null);  // LINE 93
    }
  }
  return win;
}
```

If a pop-out already exists for this session and is not closed, it focuses the existing window. Otherwise, it opens a new window with URL parameter `?popout=sessionId` and dimensions 1000x750. The main window's active session is cleared.

### 3. Main Window Broadcasts Ownership Change
**File:** `frontend/src/lib/sessionOwnership.ts` (Lines 26-55)

When the main window's `openPopout()` completes, the pop-out window will initialize its BroadcastChannel listener. When the channel is ready, the pop-out will broadcast a `claim` message to the main window (via the BroadcastChannel) and the main window will receive it.

The main window's channel listener (Lines 31-33):
```typescript
if (msg.type === 'claim' && msg.windowId !== windowId) {
  poppedOutSessions.set(msg.sessionId, msg.windowId);  // LINE 32
  onOwnershipChange?.(msg.sessionId, true);  // LINE 33
}
```

This registers that the session is now owned by the pop-out window.

### 4. main.tsx Routes to PopOutApp
**File:** `frontend/src/main.tsx` (Lines 7-26)

```typescript
const isPopout = new URLSearchParams(window.location.search).has('popout');  // LINE 7

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {isPopout ? <PopOutApp /> : <App />}  // LINE 24
  </StrictMode>,
)
```

The URL is examined for the `popout` query parameter. If present, `PopOutApp` is rendered instead of the main `App`.

### 5. PopOutApp Initializes and Loads Session
**File:** `frontend/src/PopOutApp.tsx` (Lines 25-75)

```typescript
function PopOutApp() {
  const popoutSessionId = new URLSearchParams(window.location.search).get('popout')!;  // LINE 26
  const [ready, setReady] = useState(false);

  const { sessions, activeSessionId } = useSessionLifecycleStore();  // LINE 29
  const { socket } = useSocket();  // LINE 38

  // Initialize: load the specific session and claim ownership
  useEffect(() => {
    if (!socket || !popoutSessionId || ready) return;

    // Claim ownership via BroadcastChannel
    claimSession(popoutSessionId);  // LINE 55

    // Set the active session
    useSessionLifecycleStore.setState({ activeSessionId: popoutSessionId });  // LINE 58

    // Load sessions from backend
    socket.emit('load_sessions', (res: { sessions?: ChatSession[] }) => {  // LINE 61
      if (res.sessions) {
        const mapped = res.sessions.map((s: ChatSession) => ({ ...s, isTyping: false, isWarmingUp: false }));
        useSessionLifecycleStore.setState({ sessions: mapped, activeSessionId: popoutSessionId });  // LINE 64

        // Hydrate the session
        const session = mapped.find((s: ChatSession) => s.id === popoutSessionId);  // LINE 67
        if (session?.acpSessionId) {
          socket.emit('watch_session', { sessionId: session.acpSessionId });  // LINE 69
          useSessionLifecycleStore.getState().hydrateSession(socket, popoutSessionId);  // LINE 70
        }
        setReady(true);  // LINE 72
      }
    });
  }, [socket, popoutSessionId, ready]);
}
```

The pop-out window:
1. Extracts the sessionId from the URL query parameter
2. Calls `claimSession()` to announce ownership via BroadcastChannel
3. Sets itself as the active session in the Zustand store
4. Emits `load_sessions` to fetch all sessions from the backend
5. Finds the pop-out session and emits `watch_session` to start listening for updates
6. Calls `hydrateSession()` to restore chat history
7. Sets `ready: true` to render the UI

### 6. BroadcastChannel Notifies Main Window
**File:** `frontend/src/lib/sessionOwnership.ts` (Lines 26-55)

The pop-out window calls `claimSession()`, which posts a message to the BroadcastChannel:

```typescript
export function claimSession(sessionId: string) {
  getChannel().postMessage({ type: 'claim', sessionId, windowId });  // LINE 65
}
```

The main window receives this message in its channel listener (established at Lines 26-55) and updates its internal map of popped-out sessions.

### 7. Main Window's Sidebar Re-renders with Ownership Status
**File:** `frontend/src/App.tsx` (Lines 92-98)

```typescript
// Session ownership changes (pop-out open/close) — force sidebar re-render
const [, forceUpdate] = useState(0);
useEffect(() => {
  setOwnershipChangeCallback(() => forceUpdate(n => n + 1));  // LINE 97
}, []);
```

When ownership changes are detected, the main window re-renders the Sidebar. The SessionItem now shows the session as "popped-out" (CSS class applied at Line 38 of SessionItem.tsx):

```typescript
const isActive = activeSessionId === session.id;
...
className={`session-item ... ${isSessionPoppedOut(session.id) ? 'popped-out' : ''}`}
```

### 8. PopOutApp Displays Chat with Locked Sidebar
**File:** `frontend/src/PopOutApp.tsx` (Lines 103-134)

```typescript
if (!ready) {
  return <div>Loading session...</div>;  // LINE 104
}

return (
  <div className={`app-container ${isCanvasOpen ? 'split-screen' : ''}`}>  // LINE 108
    <div className="main-content" style={chatWidth ? { flex: 'none', width: chatWidth } : undefined}>
      <ChatHeader />  // LINE 110
      <MessageList ... />
      <ChatInput />
    </div>

    {isCanvasOpen && <div className="canvas-resize-handle" onMouseDown={onResizeStart} />}
    {isCanvasOpen && <CanvasPane ... />}  // LINE 124
  </div>
);
```

PopOutApp renders the chat UI without the Sidebar. ChatHeader is aware of pop-out mode and hides the menu/settings buttons (Lines 19, 28, 47-64 of ChatHeader.tsx).

### 9. User Closes Pop-out Window
**File:** `frontend/src/lib/sessionOwnership.ts` (Lines 109-116)

```typescript
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {  // LINE 110
    const popoutId = new URLSearchParams(window.location.search).get('popout');
    if (popoutId) {
      releaseSession(popoutId);  // LINE 114
    }
  });
}
```

Before the pop-out window unloads, it calls `releaseSession()` to broadcast a release message:

```typescript
export function releaseSession(sessionId: string) {
  getChannel().postMessage({ type: 'release', sessionId, windowId });  // LINE 69
  poppedOutSessions.delete(sessionId);  // LINE 70
}
```

### 10. Main Window Receives Release and Updates Sidebar
**File:** `frontend/src/lib/sessionOwnership.ts` (Lines 34-37)

The main window receives the release message:

```typescript
else if (msg.type === 'release' && msg.windowId !== windowId) {
  poppedOutSessions.delete(msg.sessionId);  // LINE 35
  popoutWindows.delete(msg.sessionId);  // LINE 36
  onOwnershipChange?.(msg.sessionId, false);  // LINE 37
}
```

This triggers `forceUpdate` in the main App (see Step 7), which re-renders the Sidebar. The session no longer shows the "popped-out" CSS class, and the ExternalLink button is functional again.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Main Browser Window (App)                       │
├─────────────────────────────────────────────────────────────────────┤
│  Sidebar (SessionItem with "Pop Out" button)                         │
│                                                                       │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ sessionOwnership.ts:                                           │ │
│  │ - BroadcastChannel listener (receives claim/release/query)     │ │
│  │ - poppedOutSessions map (tracks popped-out session IDs)        │ │
│  │ - popoutWindows map (stores window references)                 │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                            │                                         │
│                            │ Ownership callback                      │
│                            ▼                                         │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │ App.tsx: setOwnershipChangeCallback()                          │ │
│  │ Triggers forceUpdate() to re-render Sidebar                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ window.open('/?popout=sessionId')
                              │ URL parameter passed to new window
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                   Pop-Out Browser Window (PopOutApp)                 │
├─────────────────────────────────────────────────────────────────────┤
│  main.tsx: Detects '?popout' in URL, renders PopOutApp              │
│                            │                                         │
│                            ▼                                         │
│  PopOutApp (Lines 25-134):                                           │
│  1. Extract sessionId from ?popout parameter                         │
│  2. Call claimSession(sessionId) ──────────────────────────┐        │
│  3. Load sessions from backend (load_sessions socket event)│        │
│  4. Hydrate session (watch_session + hydrateSession)       │        │
│  5. Render ChatHeader, MessageList, ChatInput, CanvasPane  │        │
│                                                            │        │
│  ┌────────────────────────────────────────────────────────┘        │
│  │ BroadcastChannel: posts { type: 'claim', sessionId, windowId }  │
│  │                                                                   │
│  └─────────────────────────────────────────────────────────────────┘
│                            │                                         │
│                            │ beforeunload event                      │
│                            ▼                                         │
│  releaseSession(sessionId): posts { type: 'release', ... }          │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## The Critical Contract: Session Ownership Coordination

The feature depends on **BroadcastChannel-based ownership messaging** to ensure:

1. **Only one window processes updates** — The pop-out window claims ownership, preventing the main window from streaming updates to the same session.
2. **Main window respects popped-out state** — When a session is owned by the pop-out, the main window disables the click-to-activate handler and shows "popped-out" styling.
3. **Cleanup on close** — When the pop-out closes, it releases ownership so the main window can resume.

### Ownership Message Contract

```typescript
type OwnershipMessage =
  | { type: 'claim'; sessionId: string; windowId: string }
  | { type: 'release'; sessionId: string; windowId: string }
  | { type: 'query' }
  | { type: 'announce'; sessionId: string; windowId: string };
```

**claim** — Pop-out window announces ownership (sent in `claimSession`)
**release** — Pop-out window releases ownership on unload (sent in `releaseSession`)
**query** — Main window asks: "Any pop-outs here?" (sent on BroadcastChannel init)
**announce** — Pop-out responds: "Yes, I own this session" (sent in response to query)

### Session Ownership Invariants

- **Only one window owns a session at a time** — The `poppedOutSessions` map in the main window tracks which sessions are owned elsewhere.
- **Ownership is ephemeral** — If the pop-out closes without calling `releaseSession`, the main window will eventually detect the closed window via `!win.closed` checks in `focusPopout()`.
- **Each pop-out window has a unique `windowId`** — Generated at module load time (Line 18): `windowId = 'win-' + Date.now() + random().`
- **Ownership is independent per session** — Multiple sessions can be popped out simultaneously.

---

## Configuration / Provider Support

This feature is **provider-agnostic** and requires no provider-specific configuration. The feature depends only on:

1. **Backend socket events**: `load_sessions`, `watch_session`, `unwatch_session` (already implemented)
2. **Zustand stores**: `useSessionLifecycleStore`, `useUIStore`, `useCanvasStore` (already in place)
3. **BroadcastChannel API**: Available in all modern browsers

No changes to `provider.json`, `branding.json`, or provider logic are needed.

---

## Data Flow / Rendering Pipeline

### Pop-Out Initialization Sequence

```
User clicks "Pop Out" button
    │
    ▼
openPopout(sessionId)
    ├─ Check: existing window open? → yes: focus & return
    └─ Create: window.open('/?popout=sessionId', ...)
    │
    ▼ (Pop-out window loads)
main.tsx: detect ?popout parameter
    │
    ├─ isPopout = true
    └─ render PopOutApp instead of App
    │
    ▼
PopOutApp mounts (Lines 25-75)
    │
    ├─ Extract: popoutSessionId from URL
    │
    ├─ Call: claimSession(popoutSessionId)
    │   └─ BroadcastChannel.postMessage({ type: 'claim', ... })
    │       (Main window receives → marks session as poppedOut)
    │
    ├─ Call: socket.emit('load_sessions', callback)
    │   └─ Backend returns: { sessions: [...] }
    │       → Zustand store updates
    │
    ├─ Find: target session in loaded sessions list
    │
    ├─ Call: socket.emit('watch_session', { sessionId: acpSessionId })
    │   └─ Backend starts streaming updates for this session
    │
    ├─ Call: hydrateSession(socket, popoutSessionId)
    │   └─ Rebuilds chat history from JSONL/DB
    │
    └─ Set: ready = true → UI renders
```

### Session State in Each Window

**Main Window State:**
```typescript
{
  sessions: [{ id: 'sess-1', ... }, { id: 'sess-2', ... }],
  activeSessionId: null,  // Cleared when pop-out opens
  poppedOutSessions: { 'sess-1': 'win-abc123' }  // session → ownerWindowId
}
```

**Pop-Out Window State:**
```typescript
{
  sessions: [{ id: 'sess-1', ... }],  // Only the popped-out session
  activeSessionId: 'sess-1'  // Always the pop-out's session
}
```

---

## Component Reference

### Frontend Components

| File | Functions/Components | Lines | Purpose |
|------|----------------------|-------|---------|
| `frontend/src/lib/sessionOwnership.ts` | `claimSession()` | 64-66 | Claim ownership via BroadcastChannel |
| `frontend/src/lib/sessionOwnership.ts` | `releaseSession()` | 68-71 | Release ownership on unload |
| `frontend/src/lib/sessionOwnership.ts` | `openPopout()` | 81-97 | Open new window and trigger main window cleanup |
| `frontend/src/lib/sessionOwnership.ts` | `focusPopout()` | 99-106 | Focus existing pop-out window |
| `frontend/src/lib/sessionOwnership.ts` | `isSessionPoppedOut()` | 73-75 | Check if session is owned by another window |
| `frontend/src/lib/sessionOwnership.ts` | `getChannel()` | 26-55 | Initialize and get BroadcastChannel singleton |
| `frontend/src/PopOutApp.tsx` | `PopOutApp` | 25-137 | Root component for pop-out windows |
| `frontend/src/main.tsx` | Conditional render | 7, 24 | Route to PopOutApp or App based on URL |
| `frontend/src/App.tsx` | `setOwnershipChangeCallback()` | 92-98 | Listen for ownership changes and force re-render |
| `frontend/src/components/SessionItem.tsx` | "Pop Out" button handler | 87-89 | Trigger pop-out via click |
| `frontend/src/components/ChatHeader/ChatHeader.tsx` | Conditional rendering | 19, 28, 47-64 | Hide menu/settings buttons in pop-out mode |

### Zustand Stores (Modified by Pop-Out)

| Store | State | Modified By | Purpose |
|-------|-------|-------------|---------|
| `useSessionLifecycleStore` | `activeSessionId` | PopOutApp (Line 58), App (Line 93 in sessionOwnership) | Pop-out sets its session active; main clears |
| `useSessionLifecycleStore` | `sessions` | PopOutApp (Line 64) | Pop-out receives session list from backend |
| `useUIStore` | `visibleCount` | PopOutApp (Line 30) | Controls message pagination in both windows |
| `useCanvasStore` | `isCanvasOpen`, `canvasArtifacts` | PopOutApp (Lines 32-35) | Canvas pane state independent per window |

### Backend Socket Events (No Changes Needed)

| Event | Emitted By | Handler | Purpose |
|-------|-----------|---------|---------|
| `load_sessions` | PopOutApp (Line 61) | Backend sessionHandlers.js | Fetch all sessions |
| `watch_session` | PopOutApp (Line 69) | Backend sessionHandlers.js | Start streaming updates |
| `unwatch_session` | App.tsx (Line 107) | Backend sessionHandlers.js | Stop streaming to main window |

---

## Gotchas & Important Notes

### 1. **Window.open() May Be Blocked by Browser Pop-up Blocker**
- **Problem:** The `window.open()` call in `openPopout()` can be silently blocked if triggered outside a user interaction context.
- **Why:** Browsers restrict pop-ups unless they originate from a direct user click (event handler).
- **Solution:** The click handler is properly attached to the button (`onClick` event), so this should work. If users report blocked pop-ups, check browser security settings.

### 2. **BroadcastChannel Not Available in All Contexts**
- **Problem:** BroadcastChannel API requires same-origin windows. Pop-outs on different subdomains won't communicate.
- **Why:** Security boundary prevents cross-origin window communication.
- **Solution:** Ensure both main and pop-out windows are served from the exact same origin (same protocol, domain, port).

### 3. **Session Ownership Not Persisted Across Browser Restarts**
- **Problem:** If the browser crashes while a session is popped out, the main window won't remember ownership.
- **Why:** Ownership is stored in-memory in `poppedOutSessions` map, not in persistent storage.
- **Why it's fine:** The main window will detect the orphaned pop-out if user tries to click it (window will be `closed`), or the pop-out's `beforeunload` will eventually fire.

### 4. **Rapid Pop-Out/Close Cycles Can Cause Race Conditions**
- **Problem:** If user pops out, immediately closes, and pops out again, race conditions in BroadcastChannel message ordering can occur.
- **Why:** Messages are asynchronous; release and claim can arrive out of order.
- **Mitigation:** Use window name as idempotent key (`popout-${sessionId}`) so same session always uses same window name (see Line 87).

### 5. **Canvas State Is NOT Shared Between Windows**
- **Problem:** If user opens canvas in main window, then pops out the same session, the pop-out starts with canvas closed.
- **Why:** Canvas open/closed state (`canvasOpenBySession` map) is separate per window.
- **Why it's fine:** Each window has independent canvas management; this is intentional to avoid conflicts.

### 6. **Active Session Set to null in Main Window**
- **Problem:** When a session is popped out, main window's `activeSessionId` becomes null, showing the empty state.
- **Why:** Prevents dual streaming of the same session.
- **Expectation:** User will select a different session in the main window, or focus the pop-out.

### 7. **Pop-Out Window Size is Hard-Coded (1000x750)**
- **Problem:** Dimensions are fixed; users can't customize initial size via config.
- **Why:** Window dimensions are hard-coded in `openPopout()` (Line 87).
- **Future improvement:** Could read default size from config.json or localStorage.

### 8. **Back/Forward Navigation Breaks Pop-Out URL**
- **Problem:** If user uses browser back button while in pop-out, URL changes and pop-out becomes orphaned.
- **Why:** BroadcastChannel listens on the `popout` URL parameter; navigating away clears it.
- **Mitigation:** Pop-out window is designed for active chat use; users shouldn't navigate away.

### 9. **Socket Connection Is Not Exclusive to Pop-Out**
- **Problem:** Both main and pop-out windows share the same Socket.IO connection (singleton in useSocket).
- **Why:** Socket is created at module load; both windows connect to the same backend socket.
- **Safe because:** Streaming events are routed by `sessionId` through `watch_session`, so the backend correctly routes to only the owning window.

### 10. **Pop-Out Title Reflects Session Name, Not "Pop Out" Indicator**
- **Problem:** If multiple windows are open, title might not clearly indicate it's a pop-out.
- **Why:** `document.title` is set to `'${sessionName} — Pop Out'` (Line 100), but visual distinction depends on browser tab design.
- **Fine for:** Users who track windows by position, monitor, or app switcher; less clear for tab-only users.

---

## Unit Tests

### Frontend Tests

| Test File | Test Names | Location | Coverage |
|-----------|-----------|----------|----------|
| `frontend/src/test/PopOutApp.test.tsx` | `renders loading state initially` | Lines 87-90 | Loading UI before socket ready |
| `frontend/src/test/PopOutApp.test.tsx` | `renders ChatHeader and ChatInput when ready` | Lines 92-114 | Full render after ready |
| `frontend/src/test/PopOutApp.test.tsx` | `does NOT render Sidebar` | Lines 116-120 | Sidebar correctly hidden |
| `frontend/src/test/PopOutApp.test.tsx` | `sets document.title with session name when ready` | Lines 122-143 | Title generation |
| `frontend/src/test/PopOutApp.test.tsx` | `hydrates session and emits watch_session when ready` | Lines 145-172 | Session hydration & socket events |
| `frontend/src/test/PopOutApp.test.tsx` | `claims session ownership on mount` | Lines 174-179 | BroadcastChannel claim |
| `frontend/src/test/sessionOwnership.test.ts` | `claimSession posts a claim message` | Lines 33-38 | Ownership claim |
| `frontend/src/test/sessionOwnership.test.ts` | `releaseSession posts a release message` | Lines 40-45 | Ownership release |
| `frontend/src/test/sessionOwnership.test.ts` | `isSessionPoppedOut returns false initially` | Lines 47-49 | Initial state |
| `frontend/src/test/sessionOwnership.test.ts` | `getWindowId returns a string starting with win-` | Lines 51-53 | Window ID generation |
| `frontend/src/test/sessionOwnership.test.ts` | `setOwnershipChangeCallback initializes the channel` | Lines 55-59 | Channel initialization |
| `frontend/src/test/sessionOwnership.test.ts` | `claim from another window marks session as popped out` | Lines 61-67 | Ownership tracking |
| `frontend/src/test/sessionOwnership.test.ts` | `release from another window removes popped out status` | Lines 69-76 | Ownership cleanup |
| `frontend/src/test/sessionOwnership.test.ts` | `announce from another window marks session as popped out` | Lines 78-84 | Query response handling |
| `frontend/src/test/sessionOwnership.test.ts` | `claim from own window is ignored` | Lines 86-93 | Self-message filtering |
| `frontend/src/test/sessionOwnership.test.ts` | `openPopout opens a new window` | Lines 95-101 | Window.open() call |
| `frontend/src/test/sessionOwnership.test.ts` | `openPopout focuses existing window if not closed` | Lines 103-110 | Focus logic |
| `frontend/src/test/sessionOwnership.test.ts` | `openPopout opens new window if existing is closed` | Lines 112-119 | Closed window replacement |
| `frontend/src/test/sessionOwnership.test.ts` | `focusPopout returns false when no window exists` | Lines 121-123 | Focus error case |
| `frontend/src/test/sessionOwnership.test.ts` | `focusPopout returns true and focuses existing window` | Lines 125-131 | Focus success |
| `frontend/src/test/sessionOwnership.test.ts` | `focusPopout returns false when window is closed` | Lines 133-139 | Closed window detection |
| `frontend/src/test/SessionItem.test.tsx` | Tests for "Pop Out" button rendering | Sidebar.test.tsx references | Button visibility |
| `frontend/src/test/ChatHeader.test.tsx` | Tests for hidden buttons in pop-out mode | Line 19 detects `isPopout` | Pop-out UI adjustment |

---

## How to Use This Guide

### For Implementing / Extending This Feature

1. **Understand session ownership coordination** — Read Section "The Critical Contract" to grasp BroadcastChannel messaging.
2. **Follow the end-to-end flow** — Trace Steps 1-10 in "How It Works" to understand initialization order.
3. **Add new pop-out features** — Modify `PopOutApp.tsx` (Lines 25-137) to add new UI elements. Ensure they respect the pop-out constraint (no sidebar, no global settings).
4. **Extend canvas support** — Canvas pane already works in pop-out; to add new canvas features, check `PopOutApp` Lines 77-92 for canvas resize handling.
5. **Add configuration** — If you want user-customizable pop-out dimensions, read the hard-coded Line 87 in `sessionOwnership.ts` and replace with a config lookup.

### For Debugging Issues with This Feature

1. **Pop-out doesn't open** — Check browser console for `window.open()` errors. Verify pop-up blocker is disabled. Check that button click is properly wired (SessionItem.tsx Line 87).
2. **Session content not loading** — Check that `socket.emit('load_sessions')` is responding. Verify `acpSessionId` exists in session object. Check Network tab for socket errors.
3. **Main window shows session as "popped out" but pop-out is closed** — Manually close the orphaned pop-out window reference; main window will detect `window.closed` on next focus attempt. Or refresh main window.
4. **BroadcastChannel messages not received** — Verify main and pop-out windows are same-origin (same protocol, domain, port). Check browser console for BroadcastChannel errors.
5. **Pop-out shows stale data** — Verify `hydrateSession()` is being called (Line 70 of PopOutApp.tsx). Check Network tab for `load_sessions` and `watch_session` socket events.
6. **Pop-out title doesn't update** — Check Line 99-101 in PopOutApp.tsx; verify `activeSession?.name` is being updated by socket events or Zustand store changes.

---

## Summary

The **Pop Out Chat** feature allows users to detach a chat session into a separate browser window while maintaining session ownership coordination via the BroadcastChannel API. Key points:

1. **User clicks ExternalLink icon** in SessionItem to trigger `openPopout(sessionId)`.
2. **New window opens** with URL `/?popout=sessionId`; main window clears active session.
3. **PopOutApp initializes**: claims ownership, loads sessions, hydrates chat history.
4. **BroadcastChannel messaging** notifies main window of ownership change (main window updates sidebar styling).
5. **Pop-out renders** without sidebar, with full canvas pane support, and window title includes session name.
6. **On close**: `beforeunload` listener calls `releaseSession()` to broadcast release message.
7. **Main window re-renders** Sidebar to show session as available again.

**Critical Contract:** Only one window owns a session at a time (enforced via `poppedOutSessions` map and BroadcastChannel messages). Ownership is ephemeral and session-specific—multiple sessions can be popped out simultaneously.

**Provider Agnostic:** No provider configuration needed; feature depends only on existing Socket.IO events and Zustand stores.

This feature enables side-by-side comparison of chats on multi-monitor setups while preventing streaming conflicts through ownership coordination.
