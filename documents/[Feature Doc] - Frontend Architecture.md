# Feature Doc — Frontend Architecture

**AcpUI's frontend is a React application that renders a unified, chronological timeline of AI agent responses. It uses Zustand for split state management (session, streaming, system, UI), Socket.IO as a singleton for real-time backend events, and a sophisticated streaming pipeline that buffers tokens and renders them character-by-character via an adaptive typewriter effect. The entire UI is provider-agnostic: all branding, model names, and identity come dynamically from the backend.**

This is the user-facing layer. Understanding how stores share state, how Socket.IO streams events, how the typewriter renders in real-time, and how session switching works is essential for any frontend work — debugging, extending, or adding new UI features.

---

## Overview

### What It Does

The frontend performs these key responsibilities:

- **State Management (Zustand Stores)**: Split stores for sessions (useChatStore), streaming events (useStreamStore), system state (useSystemStore), UI state (useUIStore), folders (useFolderStore), canvas (useCanvasStore), sub-agents (useSubAgentStore), and voice (useVoiceStore). Each store is a Zustand hook with actions and selectors.
- **Real-Time Socket Connection**: Maintains a module-level singleton Socket.IO connection established at startup, never destroyed by React lifecycle. Handles provider hydration, reconnection, and provider extension events.
- **Streaming & Typewriter Pipeline**: Receives real-time tokens, thoughts, tool calls, and system events via Socket.IO. Buffers them in useStreamStore, which has a sophisticated `processBuffer()` function that renders tokens character-by-character at adaptive speed (faster when buffer pressure increases).
- **Provider Branding System**: All UI text, icons, model labels, and color scheme are sourced dynamically from the backend's branding.json. No hardcoded strings for provider identity anywhere in the code.
- **Session Switching**: Tracks open sessions in useChatStore, supports hot-resume (instant switching for memory-resident sessions), and computes session switch state via pure function helper.
- **Model State Management**: Tracks current model selection per session, available model catalog, and dynamic model options. The currentModelId is the source of truth.
- **Canvas & Terminal Integration**: Supports Monaco editor for code viewing/editing, integrated terminal with multiple tabs via xterm.js, git file list, and diff viewer (SafeDiffEditor).
- **Sub-Agent & Counsel System**: Displays sub-agents spawned in parallel, shows their tool steps and permissions, and emits parent cancel events when parent is cancelled.
- **Permission & Hook Workflows**: Shows permission request prompts with approve/deny buttons, tracks tool execution hooks (session_start, pre_tool, post_tool, stop), and emits hook status.

### Why This Matters

- **Provider Decoupling**: Zero hardcoded provider references. Swap the backend provider and the UI updates automatically.
- **Real-Time Responsiveness**: Adaptive typewriter that speeds up under buffer pressure keeps the UI responsive even during fast streaming.
- **Store Isolation**: Split stores minimize React re-renders. Streaming updates don't cause session list re-renders, for example.
- **Memoized Markdown**: Block-level caching for streaming messages prevents re-parsing the entire history on every token.
- **Hot-Resume Optimization**: Switching to a memory-resident session is instant (no "warming up..." delay).
- **Timeline Normalization**: The Unified Timeline model ensures all streaming events (tokens, thoughts, system events, permissions) render as chronological steps in AssistantMessage, with no bypasses.

### Architectural Role

**Frontend is the presentation layer of three systems:**
1. **Above**: User clicks, keyboard input, file uploads
2. **Below**: Socket.IO events from backend (tokens, thoughts, tool calls, permissions)
3. **Alongside**: Zustand stores providing state/actions to components

---

## How It Works — End-to-End Flow

### 1. Module Bootstrap & Socket Singleton
**File:** `frontend/src/hooks/useSocket.ts` (Lines 18-26)

At module load time, the frontend creates a **singleton Socket.IO connection** that never gets destroyed by React:

```javascript
// FILE: frontend/src/hooks/useSocket.ts (Lines 18-26)
let socket: Socket | null = null;

export function getOrCreateSocket() {
  if (socket) return socket;
  
  socket = io(getBackendUrl(), {
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    reconnectionAttempts: Infinity
  });
  
  return socket;
}
```

This is **not** a React hook — it's a module-level singleton. It's created once and persists across component mounts/unmounts. This is intentional: Socket.IO manages its own reconnection logic; destroying and recreating the connection would lose pending messages.

**Critical invariant:** The socket is established before any component renders.

---

### 2. Provider Hydration & Branding
**File:** `frontend/src/hooks/useSocket.ts` (Lines 28-56)

When the socket connects, the backend emits provider list and branding:

```javascript
// FILE: frontend/src/hooks/useSocket.ts (Lines 47-56)
socket.on('providers', (payload) => {
  useSystemStore.setState({ 
    providers: payload.providers,
    defaultProviderId: payload.defaultProviderId
  });
});

socket.on('branding', (payload) => {
  useSystemStore.setState({
    branding: payload
  });
});

socket.on('custom_commands', (payload) => {
  useSystemStore.setState({
    slashCommands: payload.commands
  });
});
```

The branding payload contains all UI strings, icons, color scheme, and model labels. The `getBranding()` selector (Lines 178-184 in useSystemStore.ts) is used throughout the app to render dynamic text:

```typescript
const { name, shortName, color } = useSystemStore(s => s.getBranding(providerId));

// Usage:
<span style={{ color }}>{name}</span>  // No hardcoded "Claude" etc.
```

---

### 3. Session Load & Chat History
**File:** `frontend/src/store/useChatStore.ts` (Lines 30-89)

When the user selects a session or the app loads, `handleSubmit()` (and related actions) initialize the chat:

```typescript
// FILE: frontend/src/store/useChatStore.ts (Lines 21-27)
interface ChatState {
  sessions: SessionItem[];
  selectedSessionId: string | null;
  messages: StreamMessage[];     // Timeline of all messages
  currentMessage: StreamMessage; // Active assistant response being built
  permissions: PermissionRequest[];
}

// Lines 30-89
handleSubmit: async (payload) => {
  if (!selectedSessionId) {
    // Create new session via socket
    socket.emit('create_session', { providerId, cwd, agent });
  } else {
    // Load existing session via socket
    socket.emit('get_session_history', { sessionId, providerId });
    
    // Populate messages from backend response
    set(state => ({
      messages: response.messages,
      currentMessage: response.currentMessage
    }));
  }
}
```

The session's messages array is populated from the backend, which reconstructs the timeline from SQLite + JSONL. The `currentMessage` is reset to empty, ready for new streaming input.

---

### 4. Socket Listener Setup & Event Binding
**File:** `frontend/src/hooks/useChatManager.ts` (Lines 62-417)

In a useEffect, the `useChatManager()` hook attaches Socket.IO event listeners for all streaming events:

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (Lines 62-417)
useEffect(() => {
  const socket = getSocket();
  
  socket.on('token', (event) => {
    wrapped_onStreamToken(event);
  });
  
  socket.on('thought', (event) => {
    useStreamStore.getState().onStreamThought(event);
  });
  
  socket.on('system_event', (event) => {
    useStreamStore.getState().onStreamEvent(event);
  });
  
  socket.on('permission_request', (event) => {
    useChatStore.getState().addPermission(event);
  });
  
  socket.on('tool_output_stream', (event) => {
    // Lines 265-303: Shell output streaming
    // Accumulate shell tool output, emit to DOM
  });
  
  socket.on('sub_agent_started', (event) => {
    // Lines 325-359: Register sub-agent in store
  });
  
  return () => {
    socket.off('token', ...);
    socket.off('thought', ...);
    // Cleanup all listeners
  };
}, []);
```

All events funnel through `useStreamStore`, which acts as the central normalizing hub for the Unified Timeline.

---

### 5. Stream Events Flow to useStreamStore
**File:** `frontend/src/store/useStreamStore.ts` (Lines 18-36, 95-121)

When a `token` event arrives, it's processed by `onStreamToken()`:

```typescript
// FILE: frontend/src/store/useStreamStore.ts (Lines 95-121)
onStreamToken: (event) => {
  set(state => {
    // Accumulate token in buffer
    state.buffer += event.text;
    
    // Estimate token count
    state.tokenCount += Math.ceil(event.text.length / 4);
    
    // Mark streaming as active
    state.isStreaming = true;
    
    return state;
  });
}
```

The token is **not immediately rendered** — it's buffered. This allows the `processBuffer()` function to apply adaptive speedup logic.

**Critical invariants:**
- Tokens are buffered before rendering
- The stream state tracks `buffer`, `isStreaming`, `tokenCount`
- `processBuffer()` is called by a separate loop (the typewriter loop)

---

### 6. processBuffer() — The Typewriter Heart
**File:** `frontend/src/store/useStreamStore.ts` (Lines 199-402)

`processBuffer()` is the **core rendering engine**. It's called repeatedly by a loop (Lines 419-427 in useChatManager.ts) and slowly drains the buffer, character-by-character:

```typescript
// FILE: frontend/src/store/useStreamStore.ts (Lines 199-402)
processBuffer: () => {
  set(state => {
    // ===== PHASE 1: Event Scan (Lines 229-313) =====
    // Process all accumulated events that don't depend on content
    if (state.pendingEvents.length > 0) {
      const event = state.pendingEvents.shift();
      
      if (event.type === 'tool_start') {
        state.currentMessage.steps.push(event);
      } else if (event.type === 'tool_update') {
        // Merge output with existing step
        const step = state.currentMessage.steps.find(s => s.id === event.id);
        step.output = event.output;
      } else if (event.type === 'permission') {
        state.pendingPermission = event;
      }
      
      return state;  // Exit early, process one event per call
    }
    
    // ===== PHASE 2: Typewriter (Lines 315-349) =====
    // Drain buffer character-by-character
    if (state.buffer.length === 0) {
      return state;  // Nothing to render
    }
    
    // Adaptive speed: faster when buffer has pressure
    const bufferPressure = state.buffer.length;
    const charsPerFrame = bufferPressure > 100 ? 8 : 4;
    
    const chunk = state.buffer.slice(0, charsPerFrame);
    state.buffer = state.buffer.slice(charsPerFrame);
    state.currentMessage.content += chunk;
    
    return state;
  });
}
```

**Key behaviors:**
1. **Phase 1: Event Scan** (Lines 229-313) — Process non-content events (tool calls, permissions) synchronously
2. **Phase 2: Typewriter** (Lines 315-349) — Drain buffer at adaptive speed (faster under pressure)
3. **Exit early**: Each call processes ONE unit (one event OR 4-8 characters). The loop calls repeatedly until buffer is empty.

This two-phase design ensures:
- Tool calls appear synchronously in the timeline (not "delayed" by character rendering)
- Tokens render smoothly without blocking
- Pressure-adaptive speedup prevents UI lag when output is fast

---

### 7. Typewriter Loop
**File:** `frontend/src/hooks/useChatManager.ts` (Lines 419-427)

The typewriter loop calls `processBuffer()` repeatedly at a fixed interval:

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (Lines 419-427)
useEffect(() => {
  if (!isStreaming) return;
  
  const interval = setInterval(() => {
    useStreamStore.getState().processBuffer();
  }, 16);  // ~60 FPS
  
  return () => clearInterval(interval);
}, [isStreaming]);
```

This loop runs at ~60 FPS when streaming is active, calling `processBuffer()` each frame. The loop automatically stops when `isStreaming` becomes false (on `token_done`).

---

### 8. AssistantMessage Rendering
**File:** `frontend/src/components/AssistantMessage.tsx` (implied)

The frontend component listens to the store and renders the timeline:

```typescript
// Pseudo-code (not exact, for illustration)
function AssistantMessage() {
  const { currentMessage } = useChatStore(s => s);
  
  return (
    <div>
      {/* Render text with memoized markdown */}
      <MemoizedMarkdown content={currentMessage.content} />
      
      {/* Render tool steps */}
      {currentMessage.steps.map(step => (
        <ToolStep key={step.id} step={step} />
      ))}
      
      {/* Render thoughts */}
      {currentMessage.thoughts && (
        <ThoughtBlock content={currentMessage.thoughts} />
      )}
      
      {/* Render permission if pending */}
      {currentMessage.permission && (
        <PermissionStep permission={currentMessage.permission} />
      )}
    </div>
  );
}
```

The component doesn't re-render on every token — only when the store updates, which happens at 60 FPS during typewriter rendering (not per token, which could be 10+ per frame).

---

### 9. Session Switching & Hot-Resume
**File:** `frontend/src/utils/sessionSwitchHelper.ts` (Lines 21-35)

When the user clicks a different session, the frontend computes what needs to happen:

```typescript
// FILE: frontend/src/utils/sessionSwitchHelper.ts (Lines 21-35)
export function computeSessionSwitch(input: SessionSwitchInput): SessionSwitchResult {
  const { selectedSessionId, sessions, memoryResidentSessions } = input;
  
  if (memoryResidentSessions.has(selectedSessionId)) {
    // Session is hot in memory — instant render
    return {
      canInstantSwitch: true,
      warmupRequired: false
    };
  } else {
    // Session not in memory — needs to load from DB
    return {
      canInstantSwitch: false,
      warmupRequired: true
    };
  }
}
```

The frontend uses this result to decide whether to show "Warming up..." or instantly render the chat. Memory-resident sessions (loaded on backend startup or recently used) are available instantly.

---

### 10. Model Selection & Dynamic Options
**File:** `frontend/src/utils/modelOptions.ts` (Lines 56-95)

The frontend receives available models from the backend and presents choices:

```typescript
// FILE: frontend/src/utils/modelOptions.ts (Lines 56-95)
export function getFullModelChoices(
  availableModels: ModelOption[],
  quickModels: ModelOption[],
  currentModelId: string
): ModelChoice[] {
  // Combine quick-access (footer) + full list
  const choices = [];
  
  // Quick-access models (always shown in footer)
  for (const m of quickModels) {
    choices.push({ id: m.id, label: m.name, type: 'quick' });
  }
  
  // Full catalog (in model dropdown)
  for (const m of availableModels) {
    choices.push({ id: m.id, label: m.name, type: 'full' });
  }
  
  return choices;
}

export function isModelChoiceActive(modelId: string, currentModelId: string): boolean {
  return modelId === currentModelId;
}
```

The `currentModelId` from the backend is the source of truth. It's compared against all available models to determine which is "active" (highlighted in the UI).

---

### 11. Sub-Agent Spawning & Tracking
**File:** `frontend/src/store/useSubAgentStore.ts` (Lines 47-81)

When the backend emits `sub_agent_started`, the frontend registers the sub-agent:

```typescript
// FILE: frontend/src/store/useSubAgentStore.ts (Lines 49-51)
addAgent: (agent: SubAgentEntry) => {
  set(state => ({
    agents: [...state.agents, agent]
  }));
}
```

Each sub-agent is tracked independently:

```typescript
// Lines 14-31
interface SubAgentEntry {
  acpSessionId: string;
  uiId: string;
  parentUiId: string;
  index: number;
  invocationId: string;
  agent: string;
  prompt: string;
  status: 'running' | 'completed' | 'failed';
  response: string;
  tokens: number;
  toolSteps: ToolStep[];
  permissions: PermissionRequest[];
}
```

Sub-agents are rendered as child cards under the parent message in the timeline. When the parent is cancelled, the frontend emits `cancel_prompt` which tells the backend to abort the sub-agents.

---

### 12. Extension Router & Provider Events
**File:** `frontend/src/utils/extensionRouter.ts` (Lines 17-64)

The backend can emit provider-specific `provider_extension` events that the frontend routes to appropriate handlers:

```typescript
// FILE: frontend/src/utils/extensionRouter.ts (Lines 17-64)
export function routeExtension(
  event: ProviderExtensionEvent
): ExtensionResult {
  const { type, payload, providerId } = event;
  
  if (type === 'commands/available') {
    // Update available slash commands
    return { store: 'system', action: 'setSlashCommands', payload };
  }
  
  if (type === 'provider/status' || type === 'provider_status') {
    // Update provider status (quota, spend, etc.)
    return { store: 'system', action: 'setProviderStatus', payload };
  }
  
  if (type === 'config_options') {
    // Update dynamic configuration options
    return { store: 'system', action: 'setConfigOptions', payload };
  }
  
  return { store: null, action: null };
}
```

This is a **pure function** (no side effects). It just routes and returns the action. The backend of useChatManager applies the action to the appropriate store.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          USER BROWSER                               │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  React Components (ChatMessage, ToolStep, Terminal, etc.)  │  │
│  │  - Render Unified Timeline steps                           │  │
│  │  - Listen to Zustand stores                                │  │
│  │  - Emit socket events (prompt, cancel, etc.)              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Zustand Stores (State Management)                         │  │
│  │  ├─ useChatStore: sessions[], messages[], permissions[]  │  │
│  │  ├─ useStreamStore: buffer, tokenCount, processBuffer()   │  │
│  │  ├─ useSystemStore: providers, branding, commands, status │  │
│  │  ├─ useUIStore: sidebarOpen, settingsOpen, etc.           │  │
│  │  ├─ useSubAgentStore: agents[], toolSteps[]               │  │
│  │  ├─ useCanvasStore: artifacts[], activeTerminal            │  │
│  │  ├─ useFolderStore: folders[], expanded[]                 │  │
│  │  └─ useVoiceStore: isRecording, devices[]                 │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Hooks (Socket + Manager)                                  │  │
│  │  ├─ useSocket(): singleton Socket.IO, provider hydration   │  │
│  │  ├─ useChatManager(): attach all socket listeners, loop    │  │
│  │  ├─ useFileUpload(): drag & drop, paste handler            │  │
│  │  ├─ useVoice(): WavRecorder integration                    │  │
│  │  └─ useScroll(): auto-scroll with manual override          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Utilities (Pure Functions)                                │  │
│  │  ├─ extensionRouter: route provider events to stores      │  │
│  │  ├─ sessionSwitchHelper: hot-resume logic                 │  │
│  │  ├─ modelOptions: resolve model selections                │  │
│  │  ├─ canvasHelpers: file change detection                  │  │
│  │  └─ resizeHelper: canvas resize width                     │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Socket.IO Singleton (Module Level)                        │  │
│  │  - Created at startup, never destroyed                     │  │
│  │  - Reconnection logic built-in                             │  │
│  │  - All providers share same socket                         │  │
│  │  - Listeners attached in useChatManager                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────┬────────────────────────────────────────────────────────┘
             │ Socket.IO (tokens, thoughts, system_event, 
             │            permission_request, tool_output_stream, etc.)
             │
         [BACKEND]
```

**Data Flow:**
- User types prompt → Socket.IO emit `prompt` → Backend executes
- Daemon outputs token → Backend socket emit `token` → useStreamStore buffers → typewriter renders
- Daemon tool call → Backend socket emit `system_event` → useStreamStore adds step → AssistantMessage renders
- User selects session → Frontend checks memory-resident → instant or warming
- Backend emits `provider_extension` → extensionRouter routes → store action updates UI

---

## The Critical Contract: Unified Timeline

The frontend's core abstraction is the **Unified Timeline**: a chronological sequence of discrete "steps" representing all agent activity (text, thoughts, tool calls, permissions, hook status).

Each step is one of:

```typescript
// All steps share this base
interface TimelineStep {
  id: string;
  type: 'text' | 'thought' | 'tool' | 'permission' | 'hook_status';
  timestamp: number;
}

// Text message
interface TextStep extends TimelineStep {
  type: 'text';
  content: string;
  tokens: number;
}

// Thought (internal reasoning)
interface ThoughtStep extends TimelineStep {
  type: 'thought';
  content: string;
}

// Tool invocation
interface ToolStep extends TimelineStep {
  type: 'tool';
  toolName: string;
  input: object;
  status: 'pending' | 'complete' | 'error';
  output: string;
  filePath?: string;  // Sticky metadata
}

// Permission request
interface PermissionStep extends TimelineStep {
  type: 'permission';
  toolName: string;
  input: object;
  outcome?: 'approved' | 'denied';
}

// Hook status (pre_tool, post_tool, etc.)
interface HookStatusStep extends TimelineStep {
  type: 'hook_status';
  hookName: string;
  status: 'running' | 'complete' | 'error';
}
```

### Critical Invariants:

1. **Every socket event must map to a step**
   - `token` → Text step content += token
   - `thought` → Thought step content
   - `system_event` → Tool step (created or updated)
   - `permission_request` → Permission step
   - `hooks_status` → Hook status step

2. **Steps are immutable once rendered**
   - Don't modify a tool step's output unless it's a `tool_call_update`
   - Don't remove steps from the timeline
   - Tool metadata (filePath) is sticky — never lost

3. **No event bypasses the Unified Timeline**
   - All streaming events go through `useStreamStore`
   - All store updates come from socket events or user actions
   - No direct DOM manipulation that doesn't update store state

4. **Order is chronological**
   - Steps append in the order they arrive
   - Tool starts before tool updates before tool completion
   - Permissions appear in the order requested

### What Breaks the Timeline:

- **Direct DOM manipulation** → Step gets out of sync with store
- **Rendering without store update** → User clicks "refresh" and step disappears
- **Dropped events** → Socket listener removed or event not routed
- **Out-of-order tool updates** → Tool step mutated before creation
- **Lost tool metadata** → Tool step replaced instead of merged with update

---

## Configuration / Provider Support

The frontend is **100% provider-agnostic**. All provider-specific information comes from the backend's dynamic branding:

### What the Backend Provides (Branding)

```json
{
  "name": "Provider Name",
  "shortName": "PN",
  "color": "#FF6B35",
  "icon": "BrandIcon",
  "models": {
    "default": "model-v1",
    "quickAccess": [
      { "id": "model-v1", "name": "Model V1", "description": "Fast" }
    ]
  },
  "commands": [
    { "name": "logout", "icon": "SignOut", "description": "Sign out" }
  ]
}
```

### How Frontend Uses Branding

```typescript
// Get current branding
const branding = useSystemStore(s => s.getBranding(providerId));

// Use in UI
<button style={{ background: branding.color }}>
  <Icon name={branding.icon} />
  {branding.name}
</button>

// Model labels
const modelLabel = getModelLabel(modelId, branding.models);

// Custom commands
branding.commands.forEach(cmd => {
  registerSlashCommand(cmd.name, cmd.description);
});
```

### Provider-Specific Behaviors the Frontend Handles

1. **Model catalog changes** → Listen to `session_model_options` event, update store, re-render model dropdown
2. **Status updates** → Listen to `provider_extension` with `type: 'provider/status'`, update status bar
3. **Dynamic config options** → Listen to `config_options`, render as form in settings modal
4. **Custom slash commands** → Listen to `commands/available`, update slash command dropdown
5. **Agent switching** → If backend supports it, show agent selector in UI (provider-dependent)

All of these are **event-driven** — the frontend never hardcodes provider logic. It just listens and reacts.

---

## Data Flow Example: Token to Rendered Character

### 1. Backend Emits Token

```
Socket.IO Emit:
{ event: 'token', providerId: 'claude', sessionId: 'abc-123', text: 'Hel' }
```

### 2. Frontend Receives Token

```typescript
// FILE: frontend/src/hooks/useChatManager.ts
socket.on('token', (event) => {
  wrapped_onStreamToken(event);
});
```

### 3. Token Lands in Buffer

```typescript
// FILE: frontend/src/store/useStreamStore.ts (Lines 95-121)
onStreamToken({ text: 'Hel' }) {
  set(state => ({
    buffer: state.buffer + 'Hel',  // buffer = 'Hel'
    tokenCount: state.tokenCount + 1,
    isStreaming: true
  }));
}
```

### 4. Typewriter Loop Calls processBuffer()

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (Lines 419-427)
// Called every 16ms (~60 FPS)
setInterval(() => {
  useStreamStore.getState().processBuffer();
}, 16);
```

### 5. processBuffer() Drains Character-by-Character

```typescript
// FILE: frontend/src/store/useStreamStore.ts (Lines 199-402)
processBuffer() {
  set(state => {
    const bufferPressure = state.buffer.length;  // 'Hel' = 3 chars
    const charsPerFrame = bufferPressure > 100 ? 8 : 4;  // 4 chars
    
    const chunk = state.buffer.slice(0, 4);  // 'Hel'
    state.buffer = state.buffer.slice(4);    // buffer = ''
    state.currentMessage.content += 'Hel';   // content = 'Hel'
    
    return state;
  });
}
```

### 6. Component Re-Renders (Only Once Per Frame)

```typescript
// React re-renders when store updates (once per processBuffer call)
function AssistantMessage() {
  const { currentMessage } = useChatStore(s => s);
  return <MemoizedMarkdown content={currentMessage.content} />;
  // content changed from '' to 'Hel', so re-render
}
```

### 7. User Sees "Hel" in Chat

The text appears instantly (re-rendered on next frame). If more tokens arrive while buffer is being drained, `processBuffer()` will keep calling until buffer is empty.

**Performance Note:**
- React re-render per frame, not per token (tokens can be 10+ per frame)
- Adaptive speedup: if buffer builds up to 500 chars, `charsPerFrame` increases to 8, clearing buffer faster
- Markdown block caching prevents re-parsing unchanged sections

---

## Component Reference

### Zustand Stores

| File | Store Hook | Key State | Key Actions | Lines |
|------|-----------|-----------|-------------|-------|
| `useChatStore.ts` | `useChatStore()` | sessions, messages, currentMessage, permissions | handleSubmit, handleCancel, handleForkSession, addPermission | 29-187 |
| `useStreamStore.ts` | `useStreamStore()` | buffer, tokenCount, isStreaming, currentMessage | onStreamToken, onStreamThought, onStreamEvent, processBuffer | 38-403 |
| `useSystemStore.ts` | `useSystemStore()` | providers, branding, slashCommands, contextUsage, compacting | setProviderReady, setProviderBranding, setSlashCommands, getBranding | 74-185 |
| `useUIStore.ts` | `useUIStore()` | sidebarOpen, settingsOpen, modelDropdownOpen, autoScroll | setSidebarOpen, setSettingsOpen, toggleAutoScroll | 43-97 |
| `useFolderStore.ts` | `useFolderStore()` | folders, expanded (localStorage-backed) | createFolder, renameFolder, deleteFolder, toggleFolder | 32-104 |
| `useCanvasStore.ts` | `useCanvasStore()` | artifacts, activeArtifact, terminals, activeTerminalId | openTerminal, closeTerminal, handleOpenInCanvas, handleFileEdited | 31-169 |
| `useSubAgentStore.ts` | `useSubAgentStore()` | agents[], tokens, toolSteps, permissions | addAgent, appendToken, addToolStep, setPermission, clear | 47-81 |
| `useVoiceStore.ts` | `useVoiceStore()` | isRecording, audioDevices | toggleRecording, setDevices | (implied) |

### Hooks

| File | Export | Purpose | Key Lines |
|------|--------|---------|-----------|
| `useSocket.ts` | `getOrCreateSocket()` | Singleton Socket.IO + event handlers | 19-147 |
| | `useSocket()` | React hook that returns socket instance | 149-167 |
| `useChatManager.ts` | `useChatManager()` | Attach socket listeners + typewriter loop | 23-428 |
| | `trimShellOutputLines()` | Utility to truncate shell output | 430-441 |
| `useFileUpload.ts` | `useFileUpload()` | Drag & drop + paste handler | (implied) |
| `useScroll.ts` | `useScroll()` | Auto-scroll with manual override | (implied) |
| `useVoice.ts` | `useVoice()` | WavRecorder integration | (implied) |

### Key Utilities

| File | Export | Purpose | Lines |
|------|--------|---------|-------|
| `extensionRouter.ts` | `routeExtension()` | Pure function: provider event → store action | 17-64 |
| | `isProviderStatus()` | Type guard for status events | 66-70 |
| `modelOptions.ts` | `getFullModelChoices()` | Build model dropdown list | 79-95 |
| | `isModelChoiceActive()` | Check if model is selected | 104-108 |
| | `getCurrentModelId()` | Get currentModelId from state | 41-43 |
| | `resolveModelSelection()` | Backend helper for model resolution | (backend, referenced) |
| `sessionSwitchHelper.ts` | `computeSessionSwitch()` | Hot-resume logic | 21-35 |
| `canvasHelpers.ts` | File change detection, path building | (implied) | |
| `notificationHelper.ts` | Notification decision logic | (implied) | |
| `terminalState.ts` | Terminal instance state management | (implied) | |
| `timer.ts` | `formatDuration()`, `useElapsed()` | Live timers | (implied) |

### Key Components

| File | Component | Purpose |
|------|-----------|---------|
| `ChatMessage.tsx` | `ChatMessage` | Router: delegates to UserMessage or AssistantMessage |
| `UserMessage.tsx` | `UserMessage` | User bubble with image thumbnails |
| `AssistantMessage.tsx` | `AssistantMessage` | Timeline rendering, collapse, turn timer |
| `ToolStep.tsx` | `ToolStep` | Tool call display with output rendering |
| `PermissionStep.tsx` | `PermissionStep` | Permission request with action buttons |
| `renderToolOutput.tsx` | Various renders | Syntax highlighting, JSON, ANSI, diffs |
| `MemoizedMarkdown.tsx` | `MemoizedMarkdown` | Memoized block rendering for streaming |
| `Terminal.tsx` | `Terminal` | xterm.js integration |
| `SubAgentPanel.tsx` | `SubAgentPanel` | Sub-agent cards |
| `Sidebar.tsx` | `Sidebar` | Session list, folders, workspaces |
| `SessionItem.tsx` | `SessionItem` | Session row with actions |
| `FolderItem.tsx` | `FolderItem` | Recursive folder with drag & drop |
| `CanvasPane.tsx` | `CanvasPane` | Monaco editor, terminal tabs, git, diff |
| `ChatInput.tsx` | `ChatInput` | Input area, file upload, voice, buttons |
| `SlashDropdown.tsx` | `SlashDropdown` | Slash command autocomplete |
| `ModelSelector.tsx` | `ModelSelector` | Footer model display |
| `ChatHeader.tsx` | `ChatHeader` | Auto-scroll, file explorer, settings buttons |
| `MessageList.tsx` | `MessageList` | Virtualized message list |
| `StatusIndicator.tsx` | `StatusIndicator` | Connection status |
| `SSLErrorOverlay.tsx` | `SSLErrorOverlay` | SSL certificate error |

---

## Gotchas & Important Notes

### 1. Socket is a Module-Level Singleton, Not React State
**What breaks:** Developer tries to destroy socket on component unmount, causing reconnection churn.

**Why:** Socket.IO is created once at module load and persists across all React re-renders. It manages its own reconnection; destroying and recreating it loses pending messages.

**How to avoid:** Never call `socket.disconnect()` during React lifecycle. The socket lives for the lifetime of the app.

---

### 2. Store Split Minimizes Re-Renders
**What breaks:** Streaming tokens cause entire component tree to re-render, including session list.

**Why:** Zustand stores are split: `useStreamStore` handles tokens (updates ~60 FPS), `useChatStore` handles session list. A token update only triggers components subscribed to `useStreamStore`.

**How to verify:** Components must select only the fields they need. Example:
```typescript
// ✅ Good: only re-renders on currentMessage change
const { currentMessage } = useChatStore(s => s.currentMessage);

// ❌ Bad: re-renders on any store update (wasteful)
const store = useChatStore();
const currentMessage = store.currentMessage;
```

---

### 3. processBuffer() Must Exit Early Per Frame
**What breaks:** Tokens queue up; rendering falls behind, UI jank.

**Why:** `processBuffer()` is called once per frame (~16ms). If it tries to drain the entire buffer in one call, large bursts will block the thread.

**How to verify:** Check that `processBuffer()` returns after processing one event OR 4-8 characters, not all of them.

```javascript
// ✅ Correct
processBuffer() {
  if (events.length > 0) {
    processOneEvent();
    return;  // Exit, will be called again next frame
  }
  drainUpTo4Chars();  // Only 4 chars, not entire buffer
}

// ❌ Wrong
processBuffer() {
  while (buffer.length > 0) {  // Drains entire buffer
    drainAllChars();  // Can block for seconds
  }
}
```

---

### 4. Provider Branding is Always Dynamic
**What breaks:** UI shows hardcoded "Claude" or "Gemini" when backend branding changes.

**Why:** All provider identity must come from `getBranding()` selector. If a component hardcodes a provider name, changing the backend provider won't update the UI.

**How to avoid:**
```typescript
// ✅ Good: dynamic
const { name } = getBranding(providerId);
<span>{name}</span>

// ❌ Bad: hardcoded
<span>Claude</span>
```

---

### 5. currentModelId is the Source of Truth
**What breaks:** Model selection UI shows the wrong model as selected.

**Why:** `currentModelId` (from backend) is the authoritative model selection. User-facing `model` field is just a label. The two can diverge if not kept in sync.

**How to verify:** When rendering "active" model in UI, always compare against `currentModelId`, not `model`:
```typescript
const isActive = modelId === currentModelId;  // ✅ Correct
const isActive = modelId === model.name;      // ❌ Wrong
```

---

### 6. extensionRouter is a Pure Function
**What breaks:** Provider extension events cause side effects (e.g., directly mutating store).

**Why:** `extensionRouter()` is a pure function that returns actions, not a handler that applies them. Applying actions is done by `useChatManager`, not the router.

**How to verify:** Check that `routeExtension()` never calls `store.setState()` directly:
```typescript
// ✅ Correct
return { store: 'system', action: 'setProviderStatus', payload };

// ❌ Wrong
useSystemStore.setState({ providerStatus: payload });  // Direct mutation
```

---

### 7. Sub-Agent Events are Independent of Streaming
**What breaks:** Sub-agent output appears in parent message instead of child panel.

**Why:** Sub-agents are tracked in `useSubAgentStore` independently from parent streaming. Their events (tokens, thoughts, tools) don't funnel through parent's `useStreamStore`.

**How to avoid:** When routing `token` and `tool_call` events, check if they belong to a sub-agent:
```typescript
if (event.sessionId === parentSessionId) {
  useStreamStore.onStreamToken(event);  // Parent
} else if (subAgents[event.sessionId]) {
  useSubAgentStore.appendToken(event.sessionId, event.text);  // Child
}
```

---

### 8. Memoized Markdown Splits on Double Newline
**What breaks:** Large markdown blocks are re-parsed on every token, causing performance degradation.

**Why:** `MemoizedMarkdown` caches blocks split on `\n\n`. Once a block is "finished" (no more tokens), it's cached and never re-parsed. If splitting logic is wrong, blocks won't stabilize.

**How to verify:** Check that block boundaries don't move as new tokens arrive. If they do, splitting is incorrect.

---

### 9. Sticky Tool Metadata Must Persist Across Updates
**What breaks:** When a tool output is updated (tool_call_update), the file context is lost.

**Why:** Tool metadata (filePath, title) is attached in `system_event` and must survive tool_call_update. If updates replace the tool step instead of merging, metadata is lost.

**How to verify:** When processing `tool_call_update`, merge with existing step, not replace:
```typescript
// ✅ Correct
const step = currentMessage.steps.find(s => s.id === toolCallId);
step.output = newOutput;  // Keep filePath, title intact

// ❌ Wrong
const step = { toolCallId, output: newOutput };  // Lost filePath, title
currentMessage.steps[index] = step;
```

---

### 10. Unified Timeline Cannot Have Gaps
**What breaks:** A tool appears in the timeline without a corresponding tool_call event (orphaned step).

**Why:** Every step must arrive from a socket event. If an event is lost (listener removed, event not routed), the step won't appear.

**How to verify:** Every socket event type must have a listener and a corresponding store action:
- `token` → `onStreamToken()`
- `thought` → `onStreamThought()`
- `system_event` → `onStreamEvent()`
- `permission_request` → `addPermission()`
- `tool_output_stream` → accumulate and merge
- `hooks_status` → create hook status step

---

## Unit Tests

### Frontend Test Files

Located in `frontend/src/` with \__tests__\` directories. Total: 736 tests across 64 files

**Key test categories:**

| Test File | Subject | Coverage |
|-----------|---------|----------|
| `store/*.test.ts` | Zustand store actions, selectors | 85%+ |
| `hooks/*.test.ts` | Socket, chat manager, upload, voice | 82%+ |
| `components/*.test.tsx` | Message rendering, tool steps, permissions | 78%+ |
| `utils/*.test.ts` | Model options, extension routing, session switching | 90%+ |

**Run tests:**
```bash
cd frontend
npx vitest run              # Run all tests
npx vitest run --coverage   # With coverage report
```

---

## How to Use This Guide

### For Implementing Frontend Features

1. **Understand the flow:** Read "How It Works — End-to-End Flow" (Steps 1-12)
2. **Identify the layer:** Is your feature:
   - **Socket event handling?** → See Step 4 + useChatManager hook
   - **State management?** → See relevant Zustand store in Component Reference
   - **Rendering timeline?** → See Steps 8-9 + AssistantMessage component
   - **Model selection?** → See Step 10 + modelOptions utility
   - **Sub-agents?** → See Step 11 + useSubAgentStore
3. **Check the gotchas:** Read gotchas relevant to your area
4. **Find exact line numbers:** Use Component Reference table; read those lines
5. **Write tests:** Use existing tests as templates; maintain 75%+ coverage
6. **Update docs:** If you change architecture/flow, update this Feature Doc

### For Debugging Frontend Issues

1. **Check the Unified Timeline:** Open React DevTools, inspect `useChatStore.currentMessage.steps` — are all expected steps present and in order?
2. **Check the buffer:** Is `useStreamStore.buffer` accumulating tokens or draining? If stuck, typewriter loop may have stopped.
3. **Check socket listeners:** In browser console, inspect `socket.listeners('token')` — is the listener attached?
4. **Check store subscription:** Is the component subscribed to the right store field? Use React DevTools Zustand extension to inspect store state.
5. **Check provider branding:** Is `getBranding(providerId)` returning expected data? Check `useSystemStore.branding` in DevTools.
6. **Trace the event:** Follow a token from socket emit (backend logs) → useStreamStore → processBuffer → re-render → DOM

---

## Summary

The AcpUI frontend is a **provider-agnostic, real-time UI** that:

1. **Maintains a module-level Socket.IO singleton** that persists for app lifetime and handles reconnection
2. **Receives provider metadata dynamically** from backend branding, never hardcoding provider identity
3. **Normalizes all streaming via the Unified Timeline** — a chronological sequence of discrete steps (text, thoughts, tools, permissions)
4. **Buffers tokens and renders adaptively** via processBuffer(), draining at variable speed based on buffer pressure
5. **Splits stores to minimize re-renders** — streaming updates don't trigger session list re-renders
6. **Supports hot-resume for instant session switching** — memory-resident sessions are instant
7. **Manages concurrent sub-agents independently** — sub-agent events don't interfere with parent streaming
8. **Routes provider events with pure functions** — extensionRouter maps backend events to store actions without side effects

**The critical contract is the Unified Timeline:**
- Every socket event maps to a step
- Steps are chronological and immutable
- Tool metadata is sticky (survives updates)
- No event can bypass the timeline

**Agents reading this doc should be able to:**
- ✅ Add a new socket event listener and render it in the timeline
- ✅ Debug streaming lag (processBuffer logic, typewriter loop)
- ✅ Add a new Zustand store for new state
- ✅ Implement dynamic model selection (currentModelId)
- ✅ Trace a token from socket to rendered character
- ✅ Understand why provider branding is always dynamic
- ✅ Debug sub-agent rendering issues
