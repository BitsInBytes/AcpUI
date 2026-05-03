# Feature Doc — Auto-scroll System

The auto-scroll system keeps the active chat viewport pinned to the newest content while still letting users intentionally pause scrolling and resume on demand.

This area is easy to break because it coordinates React refs, Zustand state, wheel/scroll events, stream-driven re-renders, and `ResizeObserver` timing.

---

## Overview

### What It Does

- Maintains chat stickiness to bottom when auto-scroll is active.
- Persists the global auto-scroll preference in `localStorage` via `useUIStore`.
- Distinguishes between user intent to pause stickiness and normal passive scrolling.
- Exposes a forced "Back to Bottom" recovery path.
- Keeps scrolling stable during high-frequency streaming updates and late layout changes.
- Re-applies bottom pinning on session switches for predictable navigation.

### Why This Matters

- Streaming output is only readable if the viewport tracks new tokens/events correctly.
- Incorrect stickiness creates "message below prompt" visual regressions.
- A single scrolling bug impacts every major workflow (chat, tools, plans, sub-agents).
- This hook is shared by both main app and pop-out chat windows.
- Performance depends on scheduling bottom snaps at the right frame phase.

Architectural role: frontend-only cross-cutting behavior (hook + store + UI surfaces).

---

## How It Works — End-to-End Flow

1. `useUIStore` owns persisted global preference (`isAutoScrollDisabled`).

```typescript
// FILE: frontend/src/store/useUIStore.ts (Lines 63, 92-95)
isAutoScrollDisabled: localStorage.getItem('isAutoScrollDisabled') === 'true', // LINE 63
toggleAutoScroll: () => set((state) => {                                        // LINE 92
  const newValue = !state.isAutoScrollDisabled;                                  // LINE 93
  localStorage.setItem('isAutoScrollDisabled', newValue.toString());             // LINE 94
  return { isAutoScrollDisabled: newValue };                                     // LINE 95
}),
```

2. `App` and `PopOutApp` both instantiate `useScroll` and pass its handlers into `MessageList`.

```tsx
// FILE: frontend/src/App.tsx (Lines 75-81, 220-225)
const { scrollRef, showScrollButton, scrollToBottom, handleScroll, handleWheel } =  // LINE 75
  useScroll(activeSessionId, activeSession?.messages, visibleCount);                  // LINE 81

<MessageList
  scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
  handleScroll={handleScroll}
  handleWheel={handleWheel}
  showScrollButton={showScrollButton}
  handleBackToBottom={() => scrollToBottom(true)}                                     // LINE 225
/>
```

```tsx
// FILE: frontend/src/PopOutApp.tsx (Lines 40-42, 111-117)
const { scrollRef, showScrollButton, scrollToBottom, handleScroll, handleWheel } = useScroll( // LINE 40
  activeSessionId, activeSession?.messages, visibleCount                                     // LINE 41
);
<MessageList ... handleBackToBottom={() => scrollToBottom(true)} />                           // LINE 116
```

3. `useScroll` initializes dual state: persisted global toggle + live in-session stickiness.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 6-11)
const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);   // LINE 6
const isAutoScrollEnabledRef = useRef(true);                             // LINE 7
const isAutoScrollDisabled = useUIStore(state => state.isAutoScrollDisabled); // LINE 8
const isAutoScrollDisabledRef = useRef(isAutoScrollDisabled);            // LINE 9
const toggleAutoScrollStore = useUIStore(state => state.toggleAutoScroll); // LINE 10
const [showScrollButton, setShowScrollButton] = useState(false);         // LINE 11
```

4. `scrollToBottom` enforces the main contract: no non-forced scroll when globally disabled, and frame-aligned bottom snap.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 26-47)
if (isAutoScrollDisabled && !force) return;                              // LINE 30
if (force || isAutoScrollEnabledRef.current) {                           // LINE 32
  if (force) {
    isAutoScrollEnabledRef.current = true;                               // LINE 34
    setIsAutoScrollEnabled(true);                                        // LINE 35
    setShowScrollButton(false);                                          // LINE 36
  }
  if (pendingScrollFrame.current !== null) cancelAnimationFrame(pendingScrollFrame.current); // LINE 41-43
  pendingScrollFrame.current = requestAnimationFrame(() => {             // LINE 44
    pendingScrollFrame.current = null;                                   // LINE 45
    snapToBottom();                                                      // LINE 46
  });
}
```

5. Toggling from disabled to enabled immediately forces bottom alignment.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 51-59)
const toggleAutoScroll = useCallback(() => {
  const wasDisabled = isAutoScrollDisabled;      // LINE 52
  toggleAutoScrollStore();                       // LINE 53
  if (wasDisabled) scrollToBottom(true);         // LINE 56-57
}, [isAutoScrollDisabled, toggleAutoScrollStore, scrollToBottom]);
```

6. User wheel-up pauses stickiness for the current session view; wheel-down does not auto-resume it.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 83-89)
if (e.deltaY < 0 && isAutoScrollEnabledRef.current) {  // LINE 84
  isAutoScrollEnabledRef.current = false;              // LINE 85
  setIsAutoScrollEnabled(false);                       // LINE 86
  if (isAutoScrollDisabled) setShowScrollButton(true); // LINE 87
}
```

7. Scroll events compute "at bottom" and gate button visibility.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 65-77)
const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50; // LINE 65
const isScrollingUp = el.scrollTop < lastScrollTop.current;                 // LINE 66
if (isAtBottom) setShowScrollButton(false);                                 // LINE 73-74
else if (isScrollingUp) {
  if (isAutoScrollDisabled) setShowScrollButton(true);                      // LINE 76
}
```

8. `ResizeObserver` pins to bottom on post-layout growth when auto-scroll is active.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 102-110, 118-127)
const ro = new ResizeObserver(() => {                    // LINE 104
  if (isAutoScrollDisabledRef.current) return;           // LINE 105
  if (!isAutoScrollEnabledRef.current) return;           // LINE 106
  const node = scrollRef.current;
  if (!node) return;
  node.scrollTop = node.scrollHeight;                    // LINE 109
});
...
const content = el.firstElementChild;                    // LINE 123
if (!content) return;
ro.observe(content);                                     // LINE 125
```

9. Session switch and message growth trigger explicit bottom snaps through dedicated effects.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 135-146)
useEffect(() => {
  if (activeSessionId) scrollToBottom(true);             // LINE 137
}, [activeSessionId, scrollToBottom]);

useEffect(() => {
  if (activeSessionId) scrollToBottom(false);            // LINE 143
}, [activeSessionMessages, visibleCount, scrollToBottom]); // LINE 146
```

10. Streaming pipeline calls `scrollToBottom` every process tick (non-forced), so behavior still obeys toggle/ref state.

```typescript
// FILE: frontend/src/store/useStreamStore.ts (Lines 199-200, 400-401)
processBuffer: (scrollToBottom, onFileEdited, onOpenFileInCanvas) => { // LINE 199
  ...
  scrollToBottom();                                                     // LINE 400
  set({ typewriterInterval: setTimeout(() => get().processBuffer(scrollToBottom, onFileEdited, onOpenFileInCanvas), 32) as unknown as number }); // LINE 401
}
```

11. The footer Auto-scroll pill is the primary user-facing toggle.

```tsx
// FILE: frontend/src/components/ChatInput/ChatInput.tsx (Lines 296-302)
<button
  className={`chatinput-pill ${!isAutoScrollDisabled ? 'active' : ''}`} // LINE 296
  onClick={toggleAutoScroll}                                              // LINE 297
  title={isAutoScrollDisabled ? "Enable Auto-scroll" : "Disable auto-scroll"} // LINE 298
>
  <ArrowDownToLine size={12} />
  Auto-scroll                                                             // LINE 301
</button>
```

12. The back-to-bottom button is rendered by `MessageList` and only appears when `showScrollButton` is true.

```tsx
// FILE: frontend/src/components/MessageList/MessageList.tsx (Lines 71-79)
{showScrollButton && (
  <div className="back-to-bottom-container">
    <motion.button
      onClick={handleBackToBottom}     // LINE 78
      className="back-to-bottom-btn"
      title="Scroll to bottom"
    >
```

---

## Architecture Diagram

```mermaid
flowchart LR
  U[User Scroll / Wheel / Click] --> MS[MessageList]
  MS --> HS[useScroll]
  HS --> UIS[useUIStore]
  HS --> DOM[chat-container DOM]
  STREAM[useStreamStore.processBuffer] -->|scrollToBottom()| HS
  CHATINPUT[ChatInput Auto-scroll Pill] -->|toggleAutoScroll| UIS
  OBS[ResizeObserver callback] --> HS
  HS --> BTN[Back to Bottom Visible]
  BTN -->|click| HS
```

Main chat auto-scroll is store-backed, hook-driven, and DOM-timed (wheel/scroll + resize + stream updates).

---

## The Critical Contract / Key Concept

The auto-scroll system depends on two distinct states with different semantics:

```typescript
// FILE: frontend/src/hooks/useScroll.ts (Lines 6-11, 148-154)
isAutoScrollEnabled: boolean;      // per-view stickiness (user scrolled up/down)
isManualScrollDisabled: boolean;   // persisted global toggle (from useUIStore.isAutoScrollDisabled)
toggleAutoScroll: () => void;      // flips persisted global toggle
```

Contract rules:

1. `isAutoScrollDisabled === true` must block non-forced `scrollToBottom` calls.
2. `scrollToBottom(true)` is always allowed and resets stickiness/button state.
3. Wheel-up disables live stickiness (`isAutoScrollEnabledRef.current = false`) but does not flip persisted preference.
4. Back-to-bottom and re-enable flows must re-establish stickiness immediately.

If these semantics are mixed up, users get unpredictable behavior (jumping viewport, hidden button, or stuck non-scrolling state).

---

## Configuration / Provider-Specific Behavior

This feature is provider-agnostic.

- No provider settings are required.
- The only persisted setting is the frontend localStorage key `isAutoScrollDisabled`.
- Auto-scroll logic reacts to generic message growth and stream ticks, regardless of provider.

---

## Data Flow / Rendering Pipeline

Raw interaction:

```text
User wheels up while viewing output
```

Hook state transitions:

```typescript
isAutoScrollEnabledRef.current: true -> false
isAutoScrollEnabled: true -> false
showScrollButton: false -> true (only if isAutoScrollDisabled is true)
```

Streaming update path:

```text
socket token/event -> useStreamStore.processBuffer() -> scrollToBottom() -> useScroll gate
```

Gate behavior:

```typescript
if (isAutoScrollDisabled && !force) return;
if (force || isAutoScrollEnabledRef.current) snapToBottom();
```

Resume path:

```text
Back to Bottom click OR re-enable toggle -> scrollToBottom(true) -> pinned bottom + button hidden
```

---

## Component Reference

### Frontend Runtime

| File | Key Functions / Symbols | Exact Lines | Purpose |
|---|---|---:|---|
| `frontend/src/hooks/useScroll.ts` | `useScroll`, `scrollToBottom`, `handleScroll`, `handleWheel`, `toggleAutoScroll`, ResizeObserver effects | 4-160 | Core auto-scroll logic and DOM coordination |
| `frontend/src/store/useUIStore.ts` | `isAutoScrollDisabled`, `toggleAutoScroll` | 63, 92-95 | Persisted toggle source of truth |
| `frontend/src/store/useStreamStore.ts` | `processBuffer(scrollToBottom, ...)`, `scrollToBottom()` invocation | 199-200, 400-401 | Streaming-driven scroll triggers |
| `frontend/src/App.tsx` | `useScroll(...)`, `MessageList` wiring | 75-81, 220-225 | Main-app integration |
| `frontend/src/PopOutApp.tsx` | `useScroll(...)`, `MessageList` wiring | 40-42, 111-117 | Pop-out integration |
| `frontend/src/components/MessageList/MessageList.tsx` | `onScroll`, `onWheel`, back-to-bottom button | 40-41, 71-79 | User event source + recovery button |
| `frontend/src/components/ChatInput/ChatInput.tsx` | Auto-scroll pill toggle UI | 50-51, 296-302 | Primary user toggle surface |

### Adjacent (Separate Scope)

| File | Key Functions / Symbols | Exact Lines | Purpose |
|---|---|---:|---|
| `frontend/src/components/ToolStep.tsx` | local output container auto-scroll effect | 88-92 | Tool-output pane auto-scroll; independent from chat auto-scroll toggle |

---

## Gotchas & Important Notes

1. Two states, two meanings.
   - `isAutoScrollDisabled` (global preference) is not the same as `isAutoScrollEnabled` (live stickiness).

2. Back-to-bottom visibility is intentionally gated.
   - `showScrollButton` only flips on upward movement when global auto-scroll is disabled.

3. Session switch always forces a bottom snap.
   - This is deliberate (`scrollToBottom(true)` on active session change), even if the global toggle is disabled.

4. `ResizeObserver` is optional by environment.
   - Hook must operate safely when `ResizeObserver` is unavailable.

5. Observer target is `firstElementChild`.
   - Missing/changed DOM structure can silently disable growth pinning.

6. `requestAnimationFrame` cancellation is required.
   - Without canceling pending frames, rapid updates can queue stale snaps.

7. Wheel-down does not auto-resume stickiness.
   - Resume occurs through forced bottom actions, not by downward wheel events.

8. Tool output auto-scroll is separate.
   - `ToolStep` scrolls its own inner container and is not governed by chat auto-scroll toggle.

---

## Unit Tests

Frontend:

- `frontend/src/test/useScroll.test.ts`
  - Initializes enabled by default
  - Honors store-loaded disabled state
  - Toggles through store action
  - Session switch behavior when disabled
  - Wheel/scroll state transitions
  - ResizeObserver behavior (observe, disconnect, growth snapping, disabled guards)

- `frontend/src/test/useUIStore.test.ts`
  - `toggleAutoScroll` writes `isAutoScrollDisabled` and localStorage.

- `frontend/src/test/MessageList.test.tsx`
  - Back-to-bottom button visibility and click dispatch.

Integration surfaces:

- `frontend/src/App.tsx` wiring tested in `frontend/src/test/App.test.tsx` (mocked `useScroll` interface usage).
- `frontend/src/PopOutApp.tsx` wiring tested in `frontend/src/test/PopOutApp.test.tsx` (mocked `useScroll` interface usage).

---

## How to Use This Guide

### For implementing/extending auto-scroll behavior

1. Start in `useScroll.ts` and preserve the force vs non-force contract.
2. Keep persisted preference changes in `useUIStore` only.
3. If adding triggers (new layout or stream paths), call `scrollToBottom(false)` unless explicit user recovery is intended.
4. Update `useScroll.test.ts` first when changing observer/timing behavior.
5. Keep tool-output pane scrolling separate from chat-container logic.

### For debugging auto-scroll issues

1. Check store state: `useUIStore.getState().isAutoScrollDisabled`.
2. Confirm `useScroll` refs: `isAutoScrollEnabledRef.current`, `scrollRef.current`.
3. Verify `MessageList` passes `onScroll`, `onWheel`, and back-to-bottom handlers.
4. Reproduce with and without `ResizeObserver` support.
5. Trace stream path: `processBuffer` -> `scrollToBottom` -> gate condition.

---

## Summary

- Auto-scroll is a shared hook system, not a single component behavior.
- It combines persisted preference, transient stickiness, DOM event handling, and frame-timed snapping.
- `scrollToBottom(true)` is the explicit recovery path.
- Streaming and layout growth both feed into the same gate logic.
- Session switches intentionally force bottom alignment.
- Back-to-bottom visibility is tied to specific user-intent conditions.
- Tool-step local output scrolling is adjacent but independent.
- The critical contract is preserving the dual-state semantics without mixing them.
