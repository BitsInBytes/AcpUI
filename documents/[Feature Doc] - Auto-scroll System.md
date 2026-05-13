# Auto-scroll System

The auto-scroll system keeps the chat viewport pinned to the newest content while preserving explicit user control over reading position. It is easy to break because it coordinates React refs, Zustand state, wheel and scroll events, streaming store ticks, `requestAnimationFrame`, and `ResizeObserver` callbacks across the main app and pop-out window.

---

## Overview

### What It Does

- Pins the chat container to the bottom while live stickiness is enabled.
- Stores the global auto-scroll toggle in `useUIStore.isAutoScrollDisabled` and persists it to `localStorage`.
- Keeps per-view live stickiness separate from the persisted auto-scroll toggle.
- Forces recovery to the newest content through `scrollToBottom(true)`.
- Schedules bottom snaps with `requestAnimationFrame` so layout and scroll position settle in the same frame.
- Uses `ResizeObserver` to catch content growth that happens after React commits.
- Integrates the same hook contract in `App` and `PopOutApp`.

### Why This Matters

- Streaming output remains readable only when the viewport tracks new content predictably.
- Scroll bugs usually cross component boundaries: hook state, store state, DOM measurements, and stream timing all interact.
- The main chat surface and pop-out chat surface share the same scroll behavior.
- The back-to-bottom affordance depends on user intent and the persisted toggle, not only on raw scroll position.
- Message pagination changes `visibleCount`, which is part of the hook's bottom-snap trigger set.

Architectural role: frontend-only cross-cutting behavior spanning `useScroll`, `useUIStore`, `MessageList`, `ChatInput`, `useChatManager`, and `useStreamStore`.

---

## How It Works - End-to-End Flow

1. `useUIStore` owns the persisted auto-scroll preference.

```typescript
// FILE: frontend/src/store/useUIStore.ts (store field: `isAutoScrollDisabled`, action: `toggleAutoScroll`)
isAutoScrollDisabled: localStorage.getItem('isAutoScrollDisabled') === 'true',

toggleAutoScroll: () => set((state) => {
  const newValue = !state.isAutoScrollDisabled;
  localStorage.setItem('isAutoScrollDisabled', newValue.toString());
  return { isAutoScrollDisabled: newValue };
}),
```

The store field means "non-forced automatic scrolling is disabled." The value is global across chat surfaces because it lives in Zustand and `localStorage`.

2. `App` creates the main chat scroll controller.

```tsx
// FILE: frontend/src/App.tsx (component: `App`, hook: `useScroll`)
const {
  scrollRef,
  showScrollButton,
  scrollToBottom,
  handleScroll,
  handleWheel
} = useScroll(activeSessionId, activeSession?.messages, visibleCount);

useChatManager(
  scrollToBottom,
  (filePath) => handleFileEdited(socket, filePath),
  (filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath)
);
```

`App` passes the hook's `scrollToBottom` into `useChatManager`, so stream draining and chat viewport pinning share the same gate logic.

3. `App` wires the hook into `MessageList`.

```tsx
// FILE: frontend/src/App.tsx (component: `App`, component: `MessageList`)
<MessageList
  scrollRef={scrollRef as React.RefObject<HTMLDivElement>}
  handleScroll={handleScroll}
  handleWheel={handleWheel}
  showScrollButton={showScrollButton}
  handleBackToBottom={() => scrollToBottom(true)}
/>
```

The back-to-bottom button always uses the forced recovery path.

4. `PopOutApp` uses the same hook contract.

```tsx
// FILE: frontend/src/PopOutApp.tsx (component: `PopOutApp`, hook: `useScroll`)
const { scrollRef, showScrollButton, scrollToBottom, handleScroll, handleWheel } = useScroll(
  activeSessionId, activeSession?.messages, visibleCount
);

useChatManager(
  scrollToBottom,
  (filePath) => handleFileEdited(socket, filePath),
  (filePath) => handleOpenFileInCanvas(socket, activeSessionId, filePath)
);
```

The pop-out window has its own `useScroll` instance but consumes the same persisted `useUIStore.isAutoScrollDisabled` value.

5. `MessageList` attaches the DOM ref and user event handlers.

```tsx
// FILE: frontend/src/components/MessageList/MessageList.tsx (component: `MessageList`)
<main
  className="chat-container"
  ref={scrollRef}
  onScroll={handleScroll}
  onWheel={handleWheel}
>
  <div className="chat-content">
    <HistoryList messages={slicedMessages} acpSessionId={activeSession.acpSessionId} providerId={activeSession.provider} />
    <div className="scroll-spacer" />
  </div>
</main>
```

The observed content target is the chat container's `firstElementChild`, which is the `.chat-content` wrapper.

6. `useScroll` initializes live stickiness, store bridging, and DOM timing refs.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (hook: `useScroll`)
const scrollRef = useRef<HTMLDivElement>(null);
const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(true);
const isAutoScrollEnabledRef = useRef(true);
const isAutoScrollDisabled = useUIStore(state => state.isAutoScrollDisabled);
const isAutoScrollDisabledRef = useRef(isAutoScrollDisabled);
const toggleAutoScrollStore = useUIStore(state => state.toggleAutoScroll);
const [showScrollButton, setShowScrollButton] = useState(false);
const pendingScrollFrame = useRef<number | null>(null);
const resizeObserverRef = useRef<ResizeObserver | null>(null);
```

`isAutoScrollEnabled` is per-hook live stickiness. `isAutoScrollDisabled` is the persisted global preference.

7. `scrollToBottom` enforces forced and non-forced behavior.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (function: `scrollToBottom`)
const scrollToBottom = useCallback((force = false) => {
  const el = scrollRef.current;
  if (!el) return;

  if (isAutoScrollDisabled && !force) return;

  if (force || isAutoScrollEnabledRef.current) {
    if (force) {
      isAutoScrollEnabledRef.current = true;
      setIsAutoScrollEnabled(true);
      setShowScrollButton(false);
    }
    if (pendingScrollFrame.current !== null) {
      cancelAnimationFrame(pendingScrollFrame.current);
    }
    pendingScrollFrame.current = requestAnimationFrame(() => {
      pendingScrollFrame.current = null;
      snapToBottom();
    });
  }
}, [isAutoScrollDisabled, snapToBottom]);
```

Non-forced calls respect `isAutoScrollDisabled` and live stickiness. Forced calls reset live stickiness, hide the button, and schedule a bottom snap.

8. The ChatInput auto-scroll pill toggles the persisted preference.

```tsx
// FILE: frontend/src/components/ChatInput/ChatInput.tsx (component: `ChatInput`, control: Auto-scroll pill)
<button
  className={`chatinput-pill ${!isAutoScrollDisabled ? 'active' : ''}`}
  onClick={toggleAutoScroll}
  title={isAutoScrollDisabled ? "Enable Auto-scroll" : "Disable auto-scroll"}
>
  <ArrowDownToLine size={12} />
  Auto-scroll
</button>
```

The pill is active when non-forced auto-scroll calls are allowed.

9. Re-enabling auto-scroll forces immediate recovery.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (function: `toggleAutoScroll`)
const toggleAutoScroll = useCallback(() => {
  const wasDisabled = isAutoScrollDisabled;
  toggleAutoScrollStore();

  if (wasDisabled) {
    scrollToBottom(true);
  }
}, [isAutoScrollDisabled, toggleAutoScrollStore, scrollToBottom]);
```

The store toggle flips first. If the user is enabling auto-scroll, `scrollToBottom(true)` restores the bottom position immediately.

10. Wheel and scroll events update live stickiness.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (handlers: `handleWheel`, `handleScroll`)
const handleWheel = (e: React.WheelEvent) => {
  if (e.deltaY < 0 && isAutoScrollEnabledRef.current) {
    isAutoScrollEnabledRef.current = false;
    setIsAutoScrollEnabled(false);
    if (isAutoScrollDisabled) setShowScrollButton(true);
  }
};

const handleScroll = useCallback(() => {
  const el = scrollRef.current;
  if (!el) return;

  const isAtBottom = el.scrollHeight - el.scrollTop <= el.clientHeight + 50;
  const isScrollingUp = el.scrollTop < lastScrollTop.current;

  if (isAutoScrollEnabledRef.current !== isAtBottom) {
    isAutoScrollEnabledRef.current = isAtBottom;
    setIsAutoScrollEnabled(isAtBottom);
  }

  if (isAtBottom) {
    setShowScrollButton(false);
  } else if (isScrollingUp) {
    if (isAutoScrollDisabled) setShowScrollButton(true);
  }

  lastScrollTop.current = el.scrollTop;
}, []);
```

Wheel-up pauses live stickiness. Scrolling to the bottom restores live stickiness through `handleScroll` because `isAtBottom` becomes true.

11. `ResizeObserver` pins late-growing content while auto-scroll is active.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (effects: `ResizeObserver` setup and active-session observation)
useEffect(() => {
  if (typeof ResizeObserver === 'undefined') return;
  const ro = new ResizeObserver(() => {
    if (isAutoScrollDisabledRef.current) return;
    if (!isAutoScrollEnabledRef.current) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  });
  resizeObserverRef.current = ro;
  return () => {
    ro.disconnect();
    resizeObserverRef.current = null;
  };
}, []);

useEffect(() => {
  const ro = resizeObserverRef.current;
  if (!ro) return;
  const el = scrollRef.current;
  if (!el) return;
  const content = el.firstElementChild;
  if (!content) return;
  ro.observe(content);
  return () => ro.disconnect();
}, [activeSessionId]);
```

The observer instance is created once and the observed target is swapped on active session changes.

12. Session changes and message pagination trigger bottom snaps.

```typescript
// FILE: frontend/src/hooks/useScroll.ts (effects: active session, message growth, visible count)
useEffect(() => {
  if (activeSessionId) {
    scrollToBottom(true);
  }
}, [activeSessionId, scrollToBottom]);

useEffect(() => {
  if (activeSessionId) {
    scrollToBottom(false);
  }
}, [activeSessionMessages, visibleCount, scrollToBottom]);
```

Session changes force recovery. Message growth and `visibleCount` changes use the normal gate.

13. Streaming calls the same non-forced scroll path.

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (hook: `useChatManager`, effect: Typewriter Loop)
useEffect(() => {
  if (hasQueues && !typewriterInterval) {
    processBuffer(scrollToBottom, onFileEdited, onOpenFileInCanvas);
  }
}, [hasQueues, typewriterInterval, processBuffer, scrollToBottom, onFileEdited, onOpenFileInCanvas]);
```

```typescript
// FILE: frontend/src/store/useStreamStore.ts (action: `processBuffer`)
scrollToBottom();
set({
  typewriterInterval: setTimeout(
    () => get().processBuffer(scrollToBottom, onFileEdited, onOpenFileInCanvas),
    32
  ) as unknown as number
});
```

The typewriter loop invokes `scrollToBottom()` without forcing, so user-disabled auto-scroll and paused live stickiness are honored during streaming.

14. `MessageList` renders the recovery button from hook state.

```tsx
// FILE: frontend/src/components/MessageList/MessageList.tsx (prop: `showScrollButton`, handler: `handleBackToBottom`)
<AnimatePresence>
  {showScrollButton && (
    <div className="back-to-bottom-container">
      <motion.button
        onClick={handleBackToBottom}
        className="back-to-bottom-btn"
        title="Scroll to bottom"
      >
        <ChevronDown size={16} />
        <span>Back to Bottom</span>
      </motion.button>
    </div>
  )}
</AnimatePresence>
```

`showScrollButton` is controlled only by `useScroll`; `MessageList` renders it without recomputing scroll state.

---

## Architecture Diagram

```mermaid
flowchart LR
  subgraph Store[Zustand]
    UIS[useUIStore\nisAutoScrollDisabled\ntoggleAutoScroll]
    SS[useStreamStore\nprocessBuffer]
  end

  subgraph Shells[Chat Surfaces]
    APP[App]
    POP[PopOutApp]
  end

  APP --> US[useScroll]
  POP --> US
  APP --> UCM[useChatManager]
  POP --> UCM
  UCM -->|processBuffer(scrollToBottom)| SS
  SS -->|scrollToBottom()| US

  CI[ChatInput Auto-scroll Pill] -->|toggleAutoScroll| UIS
  UIS --> US

  ML[MessageList] -->|onWheel/onScroll| US
  ML -->|Back to Bottom| US
  US -->|scrollRef| DOM[.chat-container]
  US -->|observe firstElementChild| RO[ResizeObserver]
  RO --> DOM
```

The hook is the only component that mutates the chat container scroll position. Stores and components either provide state, render controls, or call the hook contract.

---

## The Critical Contract / Key Concept

### Contract: Persisted Preference vs Live Stickiness

```typescript
// FILE: frontend/src/hooks/useScroll.ts (hook return contract)
return {
  scrollRef,
  isAutoScrollEnabled,
  setIsAutoScrollEnabled,
  isAutoScrollEnabledRef,
  isManualScrollDisabled: isAutoScrollDisabled,
  toggleAutoScroll,
  showScrollButton,
  scrollToBottom,
  handleScroll,
  handleWheel
};
```

Rules:

1. `useUIStore.isAutoScrollDisabled === true` blocks non-forced `scrollToBottom()` and `ResizeObserver` pinning.
2. `isAutoScrollEnabledRef.current === false` blocks non-forced `scrollToBottom()` and `ResizeObserver` pinning even when the global toggle is enabled.
3. `scrollToBottom(true)` bypasses the persisted toggle, restores live stickiness, hides the recovery button, and schedules a bottom snap.
4. `handleScroll` treats the viewport as bottom-pinned when `scrollHeight - scrollTop <= clientHeight + 50`.
5. `handleWheel` only pauses live stickiness on upward wheel motion.
6. Stream-driven scrolling must call `scrollToBottom()` without `force` so user intent remains authoritative.

If the two states are mixed, chat can jump while the user is reading, ignore streaming output while the user expects pinning, or leave stale recovery UI visible.

---

## Configuration / Provider-Specific Behavior

This feature is provider-agnostic.

- No provider settings are required.
- The persisted browser key is `isAutoScrollDisabled`.
- Provider identity, model selection, tool type, and socket provider fields do not affect the scroll gate.
- Message growth, stream ticks, and session changes drive auto-scroll through generic frontend state.

---

## Data Flow / Rendering Pipeline

### User Disables Auto-scroll

```text
ChatInput Auto-scroll pill
  -> useUIStore.toggleAutoScroll()
  -> localStorage['isAutoScrollDisabled'] = 'true'
  -> useScroll sees isAutoScrollDisabled === true
  -> non-forced scrollToBottom() returns before scheduling a frame
```

### User Re-enables Auto-scroll

```text
ChatInput Auto-scroll pill
  -> useScroll.toggleAutoScroll()
  -> useUIStore.toggleAutoScroll()
  -> scrollToBottom(true)
  -> isAutoScrollEnabledRef.current = true
  -> showScrollButton = false
  -> requestAnimationFrame(snapToBottom)
```

### User Scrolls Up During Streaming

```text
MessageList onWheel(deltaY < 0)
  -> useScroll.handleWheel()
  -> isAutoScrollEnabledRef.current = false
  -> isAutoScrollEnabled = false
  -> stream tick calls scrollToBottom()
  -> call exits because live stickiness is false
```

### Streaming Token Drain

```text
backend token/thought/system_event
  -> useChatManager socket listener
  -> useStreamStore queue
  -> useChatManager Typewriter Loop
  -> useStreamStore.processBuffer(scrollToBottom)
  -> timeline mutation
  -> scrollToBottom()
  -> useScroll gate
  -> requestAnimationFrame(snapToBottom) when allowed
```

### Late Layout Growth

```text
React commit or syntax-highlighted/code/tool content grows .chat-content
  -> ResizeObserver callback
  -> require isAutoScrollDisabledRef.current === false
  -> require isAutoScrollEnabledRef.current === true
  -> scrollRef.current.scrollTop = scrollRef.current.scrollHeight
```

---

## Component Reference

### Frontend Runtime

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Hook | `frontend/src/hooks/useScroll.ts` | `useScroll`, `snapToBottom`, `scrollToBottom`, `toggleAutoScroll`, `handleScroll`, `handleWheel`, `ResizeObserver` effects | Core scroll state, DOM ref, frame scheduling, and observer coordination |
| UI store | `frontend/src/store/useUIStore.ts` | `isAutoScrollDisabled`, `toggleAutoScroll`, `visibleCount`, `incrementVisibleCount`, `resetVisibleCount` | Persisted auto-scroll toggle and message pagination state |
| Main app | `frontend/src/App.tsx` | `App`, `useScroll`, `useChatManager`, `MessageList`, `resetVisibleCount` | Main chat integration and active-session reset path |
| Pop-out app | `frontend/src/PopOutApp.tsx` | `PopOutApp`, `useScroll`, `useChatManager`, `MessageList`, `claimSession`, `watch_session` | Detached-window integration for the same scroll hook contract |
| Message list | `frontend/src/components/MessageList/MessageList.tsx` | `MessageList`, `scrollRef`, `handleScroll`, `handleWheel`, `showScrollButton`, `handleBackToBottom`, `.chat-content` | Scroll container, user event source, pagination UI, and recovery button |
| Chat input | `frontend/src/components/ChatInput/ChatInput.tsx` | `ChatInput`, Auto-scroll pill, `isAutoScrollDisabled`, `toggleAutoScroll` | User-facing persisted auto-scroll toggle |
| Chat manager | `frontend/src/hooks/useChatManager.ts` | `useChatManager`, Typewriter Loop effect, `processBuffer(scrollToBottom, ...)` | Starts stream draining with the hook's non-forced scroll function |
| Stream store | `frontend/src/store/useStreamStore.ts` | `processBuffer`, `typewriterInterval`, `scrollToBottom()` call | Mutates timeline during stream ticks and invokes non-forced scroll |

### Adjacent Behavior

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Tool output panes | `frontend/src/components/ToolStep.tsx` | local output container scroll effect, `ShellToolTerminal` | Inner tool-pane scrolling, separate from the chat container auto-scroll gate |
| Message rendering | `frontend/src/components/HistoryList.tsx`, `frontend/src/components/ChatMessage.tsx`, `frontend/src/components/AssistantMessage.tsx` | `HistoryList`, `ChatMessage`, `AssistantMessage`, `.sub-agent-pinned-panels` | Content rendered inside `.chat-content`, including bottom-pinned sub-agent panels; content growth can trigger the observer |

---

## Gotchas & Important Notes

1. Two states have different meanings.
   - `useUIStore.isAutoScrollDisabled` is persisted and global; `isAutoScrollEnabled` is live stickiness for a hook instance.

2. Forced scrolling bypasses the persisted toggle.
   - `scrollToBottom(true)` runs on session changes and back-to-bottom recovery so the user can always reach the newest content.

3. Stream scrolling must remain non-forced.
   - `useStreamStore.processBuffer` calls `scrollToBottom()` without arguments so disabled auto-scroll and paused stickiness are respected.

4. The back-to-bottom button is intentionally gated.
   - `showScrollButton` is set during upward movement only when `isAutoScrollDisabled` is true. The hook still pauses live stickiness when the global toggle is enabled.

5. Scrolling down does not directly resume stickiness.
   - `handleWheel` ignores positive `deltaY`; live stickiness resumes when `handleScroll` observes the viewport at the bottom or a forced path runs.

6. `requestAnimationFrame` cancellation matters.
   - Rapid stream ticks replace the pending frame before scheduling another bottom snap, preventing stale frame callbacks from stacking.

7. `ResizeObserver` is optional.
   - The hook checks `typeof ResizeObserver === 'undefined'` and still works through explicit `scrollToBottom` calls in test and browser environments without observer support.

8. The observer target depends on `MessageList` structure.
   - `useScroll` observes `scrollRef.current.firstElementChild`; `MessageList` must keep `.chat-content` as the first child of `.chat-container` for late-growth pinning.

9. Session changes disconnect observer targets.
   - The active-session observer effect calls `ro.disconnect()` in cleanup, then observes the next `firstElementChild` when the session changes.

10. App shell tests mock the scroll hook.
   - `App.test.tsx` and `PopOutApp.test.tsx` exercise shell behavior with mocked `useScroll`, so direct scroll behavior belongs in `useScroll.test.ts` and stream scrolling belongs in stream-store tests.

---

## Unit Tests

### Frontend Hook Tests

- `frontend/src/test/useScroll.test.ts`
  - `should initialize with auto-scroll enabled by default`
  - `should load initial state from UI store`
  - `should toggle auto-scroll via UI store action`
  - `should scroll to bottom when session changes even if manually disabled`
  - `should disable stickiness when scrolling up`
  - `scrollToBottom scrolls the ref element`
  - `handleScroll updates showScrollButton when not at bottom`
  - `handleWheel does not change state when scrolling down`
  - `creates the ResizeObserver exactly once on mount`
  - `calls observe(firstElementChild) when a session is active`
  - `disconnects old observation and re-observes new content when session changes`
  - `scrolls to bottom when observer callback fires and auto-scroll is enabled`
  - `does not scroll when isAutoScrollEnabled ref is false (user scrolled up)`
  - `does not scroll when isAutoScrollDisabled store flag is true`
  - `disconnects the observer on unmount`
  - `skips observer setup gracefully when ResizeObserver is undefined`

### Store and Component Tests

- `frontend/src/test/useUIStore.test.ts`
  - `toggleAutoScroll updates state and localStorage`
  - `incrementVisibleCount and resetVisibleCount manage pagination`

- `frontend/src/test/MessageList.test.tsx`
  - `shows scroll to bottom button when showScrollButton is true`
  - `calls handleBackToBottom when scroll button is clicked`
  - `shows load more button when hasMoreMessages is true`
  - `increments visible count when load more is clicked`

### Stream and Shell Surface Tests

- `frontend/src/test/useStreamStore.test.ts`
  - `processBuffer drains queue into session messages with adaptive speed`
  - This test verifies that `processBuffer` invokes the provided `scrollToBottom` callback during token draining.

- `frontend/src/test/typewriter-adaptive.test.ts`
  - Covers adaptive `processBuffer` behavior with explicit `scrollToBottom` mocks.

- `frontend/src/test/useChatManager.test.ts`
  - Registers socket listeners and starts stream processing through `useChatManager`; this file does not own hook-level scroll assertions.

### App Surface Tests

- `frontend/src/test/App.test.tsx`
  - `renders Sidebar and ChatInput`
  - `switches between sessions and emits watch events`
  - Uses mocked `useScroll` and mocked `MessageList`, so it verifies app shell behavior rather than DOM scroll behavior.

- `frontend/src/test/PopOutApp.test.tsx`
  - `renders loading state initially`
  - `renders ChatHeader and ChatInput when ready`
  - `hydrates session and emits watch_session when ready`
  - Uses mocked `useScroll` and mocked `MessageList`, so it verifies pop-out shell behavior rather than DOM scroll behavior.

---

## How to Use This Guide

### For implementing/extending this feature

1. Start in `frontend/src/hooks/useScroll.ts` and keep the forced versus non-forced `scrollToBottom` contract intact.
2. Keep persisted preference changes in `frontend/src/store/useUIStore.ts` through `isAutoScrollDisabled` and `toggleAutoScroll`.
3. Add new automatic stream or layout triggers through `scrollToBottom()` without `force`.
4. Use `scrollToBottom(true)` only for explicit recovery paths such as session changes, back-to-bottom clicks, or re-enabling auto-scroll.
5. Keep `MessageList`'s `.chat-content` wrapper as the first child of `.chat-container` if the observer should continue catching late content growth.
6. Update `frontend/src/test/useScroll.test.ts` for hook timing, observer, and user gesture behavior.
7. Update `frontend/src/test/useStreamStore.test.ts` or `frontend/src/test/typewriter-adaptive.test.ts` when stream draining changes when or how the scroll callback is invoked.

### For debugging issues with this feature

1. Check `useUIStore.getState().isAutoScrollDisabled` to confirm the persisted gate.
2. Inspect `useScroll` live refs: `isAutoScrollEnabledRef.current`, `isAutoScrollDisabledRef.current`, and `scrollRef.current`.
3. Confirm `MessageList` receives `scrollRef`, `handleScroll`, `handleWheel`, `showScrollButton`, and `handleBackToBottom` from `App` or `PopOutApp`.
4. Confirm the scroll container has `.chat-content` as `firstElementChild` when debugging `ResizeObserver` behavior.
5. Trace stream scrolling from `useChatManager` Typewriter Loop to `useStreamStore.processBuffer` to the hook's `scrollToBottom()` gate.
6. Reproduce with `ResizeObserver` available and unavailable if the issue involves code blocks, tool output, or late-rendered content.
7. Use `frontend/src/test/useScroll.test.ts` for hook regressions and `frontend/src/test/MessageList.test.tsx` for recovery-button rendering regressions.

---

## Summary

- Auto-scroll is hook-driven behavior shared by the main chat and pop-out chat surfaces.
- `useUIStore.isAutoScrollDisabled` is the persisted global preference; `isAutoScrollEnabled` is per-view live stickiness.
- `scrollToBottom(true)` is the explicit recovery path and bypasses the persisted toggle.
- Stream-driven scrolling calls `scrollToBottom()` without forcing so user intent is preserved.
- `requestAnimationFrame` coordinates explicit bottom snaps with browser layout timing.
- `ResizeObserver` catches late content growth while auto-scroll is allowed and live stickiness is active.
- `MessageList` owns the DOM container and recovery button rendering, but `useScroll` owns the scroll state.
- The critical contract is preserving the separation between persisted preference, live stickiness, and forced recovery.
