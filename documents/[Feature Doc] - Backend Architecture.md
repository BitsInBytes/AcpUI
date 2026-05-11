# Feature Doc — Backend Architecture

**AcpUI's backend is a Node.js orchestrator that bridges a React web UI to ACP-compatible AI daemons. It manages session lifecycle, persists state to SQLite, routes socket events, and exposes custom MCP tools via a stdio proxy. The architecture is provider-agnostic: all provider-specific logic is isolated in pluggable provider modules loaded at runtime.**

This is the core of AcpUI. Understanding how the backend boots, connects to ACP daemons, manages sessions, and streams responses is essential for any backend work — debugging, extending, or adding new session types.

---

## Overview

### What It Does

The backend performs these key responsibilities:

- **Provider Runtime Management**: Loads provider configurations from `configuration/providers.json`, spawns isolated ACP daemon processes per provider, and manages their lifecycle with exponential backoff restarts
- **Session Orchestration**: Creates, loads, forks, and merges chat sessions; persists them to SQLite with model metadata, configuration options, and attachment references
- **ACP Protocol Handling**: Implements JSON-RPC 2.0 handshake with ACP daemons, routes session updates, manages permissions, and forwards provider-specific extensions
- **Socket.IO Gateway**: Emits real-time events (tokens, thoughts, tool calls, permissions) to the frontend; multiplexes all connections through provider context isolation
- **Tool System V2**: Centralized tool orchestration using `toolRegistry`, `toolCallState`, and `toolInvocationResolver`. It dispatches lifecycle events (`onStart`, `onUpdate`, `onEnd`) to specific handlers (shell, subagents, counsel). This layer merges authoritative MCP handler metadata with provider-specific extraction, ensuring consistent titles (e.g., `Invoke Shell: <description>`) and robust state management.
- **Stream & State Management**: Buffers output chunks, manages streaming saves, handles permission workflows, and enforces session isolation via AsyncLocalStorage
- **Database Persistence**: Stores sessions, folders, canvas artifacts, notes, and dynamic model state in SQLite with provider scoping and cascade delete protection
  - Session rows also persist `used_tokens`/`total_tokens` so context usage can be restored on pre-existing chats before fresh provider metadata arrives.

### Why This Matters

- **Provider Isolation**: Multiple ACP daemons run concurrently with zero cross-contamination. Each provider has its own client, context, and state
- **Reliability**: Hardened handshakes prevent race conditions; exponential backoff prevents resource thrashing on daemon failures
- **Real-Time Responsiveness**: Socket.IO streaming with frame-adaptive typewriter rendering provides smooth, responsive chat
- **Extensibility**: Provider modules can intercept/transform updates, add custom configuration options, and define agent spawning strategies without touching backend core logic
- **Persistence & Resume**: SQLite ensures chat history survives process restarts; hot-resume optimization skips redundant RPC calls when switching to memory-resident sessions

### Architectural Role

**Backend is the nexus of three systems:**
1. **Above**: React frontend communicating via Socket.IO events
2. **Below**: ACP daemon processes speaking JSON-RPC 2.0 over NDJSON (stdin/stdout)
3. **Alongside**: Provider modules implementing the provider interface contract

---

## How It Works — End-to-End Flow

### 1. Server Bootstrap & Initialization
**File:** `backend/server.js` (Lines 102-109)

The `startServer()` function initializes the entire backend stack:

```javascript
// FILE: backend/server.js (Lines 102-109)
async function startServer() {
  const { httpServer, io } = createServer();  // HTTPS + Socket.IO setup
  await providerRuntimeManager.init();        // Load providers, spawn ACP clients
  registerSocketHandlers(io);                 // Mount socket event handlers
  httpServer.listen(port, () => console.log(`Listening on port ${port}`));
}
```

On startup, the backend validates SSL (Lines 27-41), initializes MCP routes (Lines 46-50), and spawns the backend services. The `SERVER_BOOT_ID` (Line 17) is generated and will be included in all provider-ready events to detect restarts.

**Key files initialized:**
- `server.js`: HTTP/HTTPS server, Socket.IO config, CORS origin validation (local IPs only)
- `providerRuntimeManager.js`: Multi-provider setup
- Socket handlers: Session, prompt, archive, canvas, folder, file, git, terminal, voice

---

### 2. Provider Runtime Initialization
**File:** `backend/services/providerRuntimeManager.js` (Lines 14-47)

The `ProviderRuntimeManager.init()` is called on startup and loads all enabled providers from `configuration/providers.json`:

```javascript
// FILE: backend/services/providerRuntimeManager.js (Lines 14-47)
async init() {
  const registry = getProviderRegistry();
  for (const entry of registry.providers) {
    if (!entry.enabled) continue;
    const provider = getProvider(entry.providerId);
    const client = new AcpClient();
    client.setProviderId(entry.providerId);
    await client.init(io, SERVER_BOOT_ID);
    this.runtimes.set(entry.providerId, { providerId, provider, client });
  }
}
```

Each provider gets its own isolated `AcpClient` instance. The client lifecycle will start the ACP daemon (or detect if it's already running), perform the JSON-RPC handshake, and emit `ready` when complete.

**Critical setup:**
- Provider isolation via `AsyncLocalStorage` (Lines 9-15 in `providerLoader.js`)
- Provider metadata (models, branding, config) loaded from `getProvider(providerId)` (Lines 26-68)
- Runtimes map: `providerId → { provider, client, ... }`

---

### 3. ACP Client Lifecycle & Daemon Spawn
**File:** `backend/services/acpClient.js` (Lines 85-195)

When a new `AcpClient` calls `start()`, it spawns the ACP daemon process:

```javascript
// FILE: backend/services/acpClient.js (Lines 85-223)
async start() {
  const provider = getProvider(this.providerId);
  const args = [provider.config.command, ...provider.config.args];
  
  this.process = spawn(args[0], args.slice(1), { stdio: 'pipe', ... });
  this.transport = new JsonRpcTransport(this.process.stdin, this.process.stdout);
  
  this.transport.on('message', (msg) => this.handleAcpMessage(msg));
  this.process.on('exit', () => this.restartWithBackoff());
  
  await this.performHandshake();  // JSON-RPC initialize
}
```

The daemon's `stdio` is piped: stdin receives JSON-RPC requests, stdout receives responses and notifications. The transport layer handles JSON-RPC 2.0 correlation (request ID matching).

On Windows, the runtime now resolves bare CLI and `.cmd`/`.bat` provider commands through `cmd.exe /d /s /c` while keeping `shell: false` in Node spawn options. This preserves npm shim compatibility and avoids Node's `DEP0190` warning.

**Exit handling** (Lines 157-195): If the daemon crashes, an exponential backoff timer (2s → 4s → 8s → 16s → 30s) schedules a restart. This prevents resource thrashing during persistent failures.

---

### 4. JSON-RPC Handshake & Provider Extension Interception
**File:** `backend/services/acpClient.js` (Lines 197-224)

After stdio is piped, the client sends the `initialize` request:

```javascript
// FILE: backend/services/acpClient.js (Lines 197-224)
async performHandshake() {
  const provider = getProvider(this.providerId);
  
  // Call provider's handshake hook (if defined)
  const initPayload = provider.module.performHandshake?.() || {};
  
  const response = await this.transport.request('initialize', {
    protocolVersion: '1.0',
    clientCapabilities: { ... },
    clientInfo: { name: provider.config.name, version: ... },
    ...initPayload
  });
  
  // Emit 'ready' event to frontend
  io.emit('ready', { providerId: this.providerId, bootId: SERVER_BOOT_ID });
}
```

The provider module can inject custom fields into the initialize request (via `provider.module.performHandshake()`). After handshake succeeds, the `ready` event notifies the frontend that the provider is connected.

**Provider isolation**: The `runWithProvider()` context wrapper (Lines 21-24 in `providerLoader.js`) ensures all provider-specific code runs within that provider's AsyncLocalStorage context.

---

### 5. Socket Connection & Provider Hydration
**File:** `backend/sockets/index.js` (Lines 50-95)

When a frontend socket connects, the backend emits provider metadata:

```javascript
// FILE: backend/sockets/index.js (Lines 50-95)
io.on('connection', (socket) => {
  // Emit available providers
  const providers = getProviderRegistry().providers.map(entry => ({
    providerId: entry.providerId,
    label: entry.label,
    default: entry.providerId === getDefaultProviderId(),
    ready: getRuntimeManager().getClient(entry.providerId)?.isReady,
    branding: getRuntimeManager().getRuntime(entry.providerId).provider.branding
  }));
  
  socket.emit('providers', { defaultProviderId, providers });
  socket.emit('branding', buildBrandingPayload(defaultProviderId));
  socket.emit('sidebar_settings', { ... });
  socket.emit('custom_commands', { ... });
});
```

The frontend receives provider list, default selection, branding data, and custom commands. All are sourced dynamically from the backend — no hardcoded strings in the UI.

---

### 6. Session Creation & Model Discovery
**File:** `backend/sockets/sessionHandlers.js` (Lines 258-361)

When the frontend calls `create_session`, the backend creates a new session with the ACP daemon:

```javascript
// FILE: backend/sockets/sessionHandlers.js (Lines 270-376)
socket.on('create_session', async (payload) => {
  const client = runtimeManager.getClient(payload.providerId);
  
  // Build MCP server config (includes stdio proxy)
  const mcpServers = getMcpServers(payload.providerId);
  
  // Provider-specific session params (e.g., agent forwarding, spawn context)
  const sessionParams = provider.module.buildSessionParams?.(payload) || {};
  
  // Send session/new to ACP daemon
  const response = await client.transport.request('session/new', {
    cwd: payload.cwd,
    mcpServers,
    ...sessionParams
  });
  
  // Capture dynamic model catalog, currentModelId, and provider-normalized config options from response
  const modelState = extractModelState(response);
  
  // Persist to SQLite
  await db.saveSession({
    id: response.sessionId,
    name: 'New Session',
    model: modelState.model,
    currentModelId: modelState.currentModelId,
    modelOptions: modelState.modelOptions,
    provider: payload.providerId,
    ...
  });
  
  socket.emit('session_created', { sessionId: response.sessionId, ... });
});
```

**Key steps:**
- MCP server config injected (stdio proxy path and configuration)
- Provider module can inject custom params via `buildSessionParams()` (e.g., agent forwarding, spawn context)
- ACP daemon returns dynamic model catalog
- Session persisted to SQLite with model metadata
- Frontend receives session ID and initial model state

The session metadata stored in `AcpClient.sessionMetadata[sessionId]` tracks active model selection, token counts, and tool calls.

---

### 7. Prompt Execution & Output Streaming
**File:** `backend/sockets/promptHandlers.js` (Lines 11-225)

When the frontend sends a prompt, the backend assembles it and sends `session/prompt`:

```javascript
// FILE: backend/sockets/promptHandlers.js (Lines 11-225)
socket.on('prompt', async ({ providerId, uiId, sessionId, prompt, model, attachments = [] }) => {
  let runtime;
  try {
    runtime = providerRuntimeManager.getRuntime(providerId);  // Outer try: pre-prompt setup
  } catch (err) {
    // Pre-prompt errors (invalid provider, missing setup)
    // onPromptStarted was never called, so no cleanup needed
    io.to('session:' + sessionId).emit('token', { ... error ... });
    return;  // LINE 19
  }
  
  const acpClient = runtime.client;
  const meta = acpClient.sessionMetadata.get(sessionId);
  
  // Assemble prompt parts, process attachments (image compression, file reading)...

  // LIFECYCLE HOOK: Notify provider that a real prompt is starting
  // This is the authoritative signal for lifecycle tracking (e.g., quota polling)
  acpClient.providerModule.onPromptStarted(sessionId);  // LINE 114

  try {  // LINE 116: Inner try — actual prompt execution
    // Send to ACP daemon
    const response = await acpClient.transport.request('session/prompt', {
      sessionId: sessionId,
      prompt: acpPromptParts
    });

    if (response && response.usage) {
      meta.usedTokens = response.usage.totalTokens || meta.usedTokens;
      io.to('session:' + sessionId).emit('stats_push', { ... });
    }

    // Auto-finalize if no pending tool results
    if (!acpClient.stream.statsCaptures.has(sessionId)) {
      io.to('session:' + sessionId).emit('token_done', { ... });
      autoSaveTurn(sessionId, acpClient);
    }
  } catch (_err) {  // LINE 136: Inner catch — handle prompt execution errors
    // Prompt send/execution failed
    writeLog(`Prompt Error: ${JSON.stringify(_err)}`);
    io.to('session:' + sessionId).emit('token', { 
      providerId, sessionId, text: \`\\n\\n:::ERROR:::\\n${_err.message}\\n:::END_ERROR:::\\n\\n\` 
    });
    io.to('session:' + sessionId).emit('token_done', { ... error: true ... });
    autoSaveTurn(sessionId, acpClient);  // Prevent persistent 'Thinking...' state
  } finally {  // LINE 154: Finally — cleanup after prompt attempt
    // Always notify the provider that this prompt is done — whether it resolved,
    // was cancelled (stopReason: "cancelled"), or threw an error.
    // This keeps _activePromptCount and quota tracking accurate.
    acpClient.providerModule.onPromptCompleted(sessionId);  // LINE 158
  }
});  // LINE 173
```

**Two-Level Error Handling (New in this version):**
- **Outer try/catch (Lines 12-20):** Catches pre-prompt errors (invalid provider, missing config, attachment processing). `onPromptStarted` is never called here.
- **Inner try/catch/finally (Lines 116-158):** Wraps the actual `session/prompt` RPC call. `onPromptStarted` is called before inner try (line 114), inner catch handles execution errors (line 136), and finally ensures `onPromptCompleted` is always called (line 158) whether the prompt succeeded, was cancelled, or threw an error.

This structure ensures lifecycle hooks (`onPromptStarted` / `onPromptCompleted`) are always paired and that errors don't prevent proper cleanup.

The request is sent asynchronously; the ACP daemon will respond with `session/update` notifications as the agent generates output.

---

### 8. ACP Message Routing & Update Normalization
**File:** `backend/services/acpClient.js` (Lines 225-252) & `backend/services/acpUpdateHandler.js` (Lines 16-283)

As the ACP daemon generates output, it sends `session/update` notifications:

```javascript
// FILE: backend/services/acpClient.js (Lines 225-252)
handleAcpMessage(message) {
  if (message.method === 'session/update') {
    // Allow provider to intercept/transform before routing
    const update = provider.module.normalizeUpdate?.(message.params) || message.params;
    this.handleUpdate(update);
  } else if (message.method === 'session/request_permission') {
    this.handleRequestPermission(message);
  } else if (message.method === 'provider_extension') {
    this.handleProviderExtension(message);
  }
}

handleUpdate(update) {
  acpUpdateHandler.handleUpdate(update);  // Router
}
```

The provider module can normalize/intercept updates (Lines 284-355). Then `acpUpdateHandler.handleUpdate()` routes the update:

```javascript
// FILE: backend/services/acpUpdateHandler.js (Lines 16-283)
function handleUpdate(update) {
  const { sessionId, type, ...data } = update;
  
  switch (type) {
    case 'agent_message_chunk':
      // Buffer text, emit socket token, track usage
      // (Lines 100-123)
      break;
    case 'tool_call':
      // Normalize and categorize (provider-specific → standard)
      eventToEmit = providerModule.normalizeTool(eventToEmit, update);
      const category = providerModule.categorizeToolCall(eventToEmit);

      // Tool System V2: Resolve identity and dispatch to registry
      const invocation = resolveToolInvocation({ ... });
      eventToEmit = applyInvocationToEvent(eventToEmit, invocation);
      eventToEmit = toolRegistry.dispatch('start', ctx, invocation, eventToEmit);

      // Persist sticky state
      toolCallState.upsert({ ... });

      io.emit('system_event', eventToEmit);
      break;
    case 'tool_call_update':
      // Resolve phase (update or end) and dispatch to registry
      const phase = update.status ? 'end' : 'update';
      const inv = resolveToolInvocation({ ..., phase });
      endEvent = applyInvocationToEvent(endEvent, inv);
      endEvent = toolRegistry.dispatch(phase, ctx, inv, endEvent);

      // Update sticky state
      toolCallState.upsert({ ... });

      io.emit('system_event', endEvent);
      break;
    case 'usage_update':
      // Update token counts, emit stats_push
      // (Lines 276-290)
      break;
    case 'turn_end':
      // Mark response complete, trigger autosave
      break;
    // ...
  }
}
```

Each update type is handled differently. Tool System V2 ensures tool identity and metadata (like shell descriptions) are preserved across the lifecycle by merging provider extraction with authoritative MCP handler state. Tokens are buffered for the adaptive typewriter renderer.

---

### 9. Stream Emission to Frontend via Socket.IO
**File:** `backend/services/acpUpdateHandler.js` (Lines 100-123 for token flow)

As chunks arrive, the backend emits Socket.IO events:

```javascript
// Within tool_call handler (Lines 150-181)
io.emit('system_event', {
  providerId,
  sessionId,
  type: 'tool_start',
  id: toolCallId,
  toolName: normalizedName,
  input: normalizedInput
});

// Within agent_message_chunk handler (Lines 100-123)
io.emit('token', {
  providerId,
  sessionId,
  text: chunk
});

// Usage tracking
io.emit('stats_push', {
  providerId,
  sessionId,
  usedTokens,
  totalTokens
});
```

The frontend listens for these events in `useChatManager.ts` (Lines 62-417) and updates the streaming message in real-time.

---

### 10. Periodic Auto-Save to SQLite
**File:** `backend/services/sessionManager.js` (Lines 284-330)

During streaming, the backend saves progress every 3 seconds:

```javascript
// FILE: backend/services/sessionManager.js (Lines 284-330)
export function autoSaveTurn(sessionId, providerId) {
  if (saveTimeout) clearTimeout(saveTimeout);
  
  saveTimeout = setTimeout(async () => {
    const metadata = acpClient.sessionMetadata[sessionId];
    const session = await db.getSession(sessionId);
    
    // Append new message or update last message
    if (metadata.currentMessage) {
      session.messages.push(metadata.currentMessage);
    }
    
    // Save to DB, respecting permission state
    await db.saveSession(session);
  }, 3000);  // 3 second delay
}
```

This ensures that if the backend crashes mid-stream, the frontend can reload and resume from the last saved turn.

---

### 11. Hot-Resume Optimization on Session Load
**File:** `backend/services/sessionManager.js` (Lines 177-253)

When switching to a session already in memory, the backend skips redundant RPC calls:

```javascript
// FILE: backend/services/sessionManager.js (Lines 177-253)
async function loadSessionIntoMemory(sessionId, providerId) {
  const client = runtimeManager.getClient(providerId);
  const session = await db.getSession(sessionId);
  
  // Initialize metadata for this session
  client.sessionMetadata[sessionId] = {
    model: session.model,
    currentModelId: session.currentModelId,
    modelOptions: session.modelOptions,
    ...
  };
  
  // Send session/load RPC if not already warm
  if (!client.isSessionWarm(sessionId)) {
    const response = await client.transport.request('session/load', {
      sessionId,
      mcpServers: getMcpServers(providerId)
    });
    
    // Reapply saved model selection immediately
    if (session.currentModelId) {
      await client.transport.request('session/set_model', {
        sessionId,
        model: resolveModelSelection(session.currentModelId, ...)
      });
    }
  }
  
  return { sessionId, model: session.model, currentModelId: session.currentModelId, ... };
}
```

If the session is already resident in memory (loaded after startup), calling the function is instant. The frontend receives metadata without waiting for RPC.

When a provider implements `emitCachedContext(sessionId)`, the backend calls it after explicit `session/load`, hot-session reuse, and pinned-session warmup. This lets providers replay context usage persisted on disk even when the daemon's load response does not include `sessionId` or the hot-resume path skips the daemon request entirely.

---

### 12. Tool Execution via Tool System V2
**File:** `backend/mcp/mcpServer.js` (Lines 140-289) & `backend/services/tools/index.js`

When the ACP daemon calls a tool, the stdio proxy forwards the call to the backend. The backend now uses a centralized tool system to manage execution:

```javascript
// FILE: backend/mcp/mcpServer.js (Lines 143-175)
tools.ux_invoke_shell = async ({ 
  description, command, cwd, providerId, acpSessionId, mcpRequestId, 
  requestMeta, abortSignal  // ← New: abort signal for cancellation
}) => {
  if (providerId && acpSessionId) {
    const toolCallId = toolCallIdFromMeta(requestMeta);
    const title = description ? `Invoke Shell: ${description}` : 'Invoke Shell';

    // Authoritative state upsert — description cached here for UI display
    cacheMcpToolInvocation({ 
      io, providerId, acpSessionId, toolCallId, toolName: 'ux_invoke_shell', 
      input: { description, command, cwd }, title 
    });

    return shellRunManager.startPreparedRun({
      providerId,
      acpSessionId,
      toolCallId,
      mcpRequestId,
      description,
      command,
      cwd,
      maxLines
    });
  }
};
```

The tool is executed in the backend Node.js process. The **Tool System V2** (located in `backend/services/tools/`) manages the lifecycle:

1.  **`toolRegistry`**: Dispatches `onStart`, `onUpdate`, and `onEnd` events to canonical tool handlers (e.g., `shellToolHandler`).
2.  **`toolCallState`**: A singleton cache that tracks tool state by `providerId::sessionId::toolCallId`. It handles merging inputs and deciding which title is "authoritative" (e.g., an MCP-provided description wins over a generic provider title).
3.  **`toolInvocationResolver`**: Merges raw provider updates with the cached state to produce a canonical `invocation` object.
4.  **`toolIdPattern`**: Allows providers to define how MCP tool IDs are formatted (e.g., `mcp__{mcpName}__{toolName}`), allowing the system to automatically extract the canonical tool name.

`ux_invoke_shell` uses the interactive `shellRunManager`, which now includes the `description` in snapshots, allowing the UI to render `Invoke Shell: <description>` even before the shell process has fully started.

`ux_invoke_subagents` and `ux_invoke_counsel` are side-effectful MCP tools because they create ACP sessions. Their handlers build a scoped idempotency key from provider/session/tool identity plus `mcpRequestId`, `requestMeta.toolCallId`, or a hash of the requests/model input. `SubAgentInvocationManager` uses that key to join duplicate active calls and return recently completed results, preventing provider MCP retries from spawning another batch.

**Abort-Aware Tool Execution (Cancellation Flow):**
The MCP execution path is fully abort-aware:
1. **Upstream MCP Cancellation:** `stdio-proxy.js` passes the MCP SDK `extra.signal` into `backendFetch()` (line 106). If MCP client cancels, the fetch aborts.
2. **Local Disconnect:** `createToolCallAbortSignal()` (mcpApi.js lines 17-31) converts request `aborted` and response `close` events into an `AbortSignal`.
3. **Abort Bypass in Retry Loop:** `backendFetch()` at line 55 checks for pre-aborted signals and throws immediately (no retry).
4. **Handler Receives Signal:** Every tool handler receives `abortSignal` in its args (line 148 of mcpApi.js) and can cancel background work.
5. **SubAgent Cascade:** `SubAgentInvocationManager.cancelAllForParent()` (lines 124-131) uses recursive descent to cancel every active descendant sub-agent when a parent is cancelled.

---

## Tool System V2 — Canonical Tool Orchestration

AcpUI V2 introduces a canonical layer for tool management, moving logic out of the generic `acpUpdateHandler` and into specialized services.

### Core Components

| Component | Responsibility |
|-----------|----------------|
| `toolRegistry.js` | Maps canonical tool names (`ux_invoke_shell`) to lifecycle handlers. |
| `toolCallState.js` | Maintains a "sticky" record of every tool call in a session. Tracks inputs, authoritative titles, and tool-specific metadata (like `shellRunId`). |
| `toolInvocationResolver.js` | Logic for merging provider-extracted data with cached state. Handles title priority (MCP > Provider > Generic). |
| `toolIdPattern.js` | Regex-based matching for provider tool naming conventions. |
| `handlers/` | Specific logic for `shell`, `subagents`, and `counsel`. |

### Lifecycle Flow

1.  **Extraction**: `acpUpdateHandler` calls `providerModule.extractToolInvocation()`.
2.  **Resolution**: `toolInvocationResolver` merges this with `toolCallState` to find the canonical identity.
3.  **Dispatch**: `toolRegistry` calls `onStart/onUpdate/onEnd` on the matched handler.
4.  **Emit**: The resulting normalized event is emitted to the frontend.

This architecture ensures that tool-specific behavior (like spawning a sub-agent or preparing a shell run) is decoupled from the message streaming logic.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        BROWSER FRONTEND                             │
│                      (React + Zustand)                              │
└────────────┬────────────────────────────────────────────────────────┘
             │ Socket.IO (providers, branding, tokens, tool updates)
             │
┌────────────▼───────────────────────────────────────────────────────┐
│                       BACKEND (Node.js)                             │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  server.js: HTTPS + Socket.IO + service init               │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  ProviderRuntimeManager                                      │  │
│  │  ├─ Load configuration/providers.json                        │  │
│  │  ├─ Spawn ACP daemon per provider                            │  │
│  │  └─ Manage isolated AcpClient instances                      │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Socket Handlers                                             │  │
│  │  ├─ sockets/index.js: connection, provider hydration         │  │
│  │  ├─ sockets/sessionHandlers.js: CRUD, fork, merge           │  │
│  │  ├─ sockets/promptHandlers.js: streaming, cancellation      │  │
│  │  ├─ sockets/archiveHandlers.js: archive/restore            │  │
│  │  ├─ sockets/canvasHandlers.js: artifacts                    │  │
│  │  └─ ... (folderHandlers, gitHandlers, terminalHandlers)    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  ACP Client (per provider)                                   │  │
│  │  ├─ Spawn daemon process                                     │  │
│  │  ├─ JsonRpcTransport: handle I/O                             │  │
│  │  ├─ handleAcpMessage: route updates                          │  │
│  │  ├─ sessionMetadata: track active session state              │  │
│  │  └─ Exponential backoff restarts                             │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Update Handler & Model State                                │  │
│  │  ├─ acpUpdateHandler: route by update type                   │  │
│  │  ├─ modelOptions: resolve model selections                   │  │
│  │  ├─ sessionManager: auto-save, hot-resume                    │  │
│  │  └─ Sticky metadata for tool outputs                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  MCP Tool System                                             │  │
│  │  ├─ mcpServer.js: tool handlers (shell, subagents, counsel) │  │
│  │  ├─ subAgentInvocationManager.js: sub-agent orchestration   │  │
│  │  ├─ stdio-proxy.js: thin JSON-RPC proxy (per session)       │  │
│  │  ├─ /api/mcp/tools: schema endpoint                          │  │
│  │  └─ /api/mcp/tool-call: execution endpoint (POST)           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Database (SQLite)                                           │  │
│  │  ├─ sessions: chat history, model metadata                   │  │
│  │  ├─ folders: session collections                             │  │
│  │  ├─ canvas_artifacts: code/text snippets                     │  │
│  │  ├─ notes: per-session markdown                              │  │
│  │  └─ Fork metadata: parent → child relationships              │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  Provider Modules (dynamic, pluggable)                       │  │
│  │  ├─ provider.json: protocol identity, tool aliases           │  │
│  │  ├─ branding.json: UI strings, icons                         │  │
│  │  ├─ user.json: user-specific config                          │  │
│  │  └─ index.js: intercept, normalize, buildSessionParams       │  │
│  └──────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
             │ JSON-RPC 2.0 (stdio: stdin/stdout)
             │
┌────────────▼───────────────────────────────────────────────────────┐
│                  ACP DAEMON (per provider)                         │
│              (provider-cli, my-agent-cli, etc.)                    │
└─────────────────────────────────────────────────────────────────────┘
```

**Data Flow:**
- User input → Frontend Socket.IO event → Backend socket handler → ACP RPC request → ACP daemon
- Daemon output → ACP JSON-RPC notification → Backend handleAcpMessage → acpUpdateHandler → Socket.IO emit → Frontend streaming
- Tools → Proxy forward → Backend MCP handler → PTY/sub-agent exec → Socket.IO stream event → Frontend

---

## The Critical Contract: sessionMetadata + ACP JSON-RPC Protocol

The backend's behavior depends on two critical contracts:

### 1. Session Metadata Structure

The `AcpClient.sessionMetadata` Map stores active session state. Every session has this shape:

```javascript
sessionMetadata[sessionId] = {
  // Model state (persisted to DB, restored on load)
  model: string,                    // User-friendly model name
  currentModelId: string,           // Real model ID for ACP
  modelOptions: [                   // Available models from provider
    { id: string, name: string, description?: string }
  ],
  configOptions: {                  // Dynamic config from provider
    "key": { type, currentValue, options: [] }
  },
  
  // Active streaming state (ephemeral)
  currentMessage: {                 // Current assistant response being built
    role: 'assistant',
    content: string,                // Buffered text chunks
    thoughts: string,               // Buffered thought chunks
    steps: [                         // Tool calls + outputs
      { type: 'tool', toolName, input, status, output, ... }
    ]
  },
  
  // Token tracking
  usedTokens: number,
  totalTokens: number,
  promptCount: number,
  
  // Tool metadata (sticky — persists tool context)
  toolCalls: Map<toolCallId, { filePath, title, normalizedName }>,
  successTools: Set<toolCallId>,
  
  // Timing
  startTime: Date,
  
  // Provider-specific
  provider: string,
  agentName?: string,               // Current agent
  spawnContext?: string,            // Injected on first prompt
  
  // Forking state
  forkedFrom?: sessionId,
  forkPoint?: messageIndex,
  
  // Sub-agent tracking
  isSubAgent: boolean,
  parentAcpSessionId?: string
}
```

**Critical invariants:**
- `currentModelId` is the source of truth for the active model (not the user-facing `model` field)
- When a session loads from DB, `sessionMetadata` must be reconstructed from saved fields
- Tool metadata is "sticky" — once attached to a tool call, it persists even if the output changes
- Streaming is always appended to `currentMessage`; messages are finalized on `turn_end`

### 2. ACP JSON-RPC Protocol Flow

Every ACP daemon communication follows this strict protocol:

```
STEP 1: Backend → Daemon
initialize {
  protocolVersion: '1.0',
  clientCapabilities: {...},
  clientInfo: { name, version }
  [+ provider-specific fields from provider.module.performHandshake()]
}

STEP 2: Daemon → Backend (response)
(JSON-RPC success or error)

STEP 3: Backend → Daemon
session/new {
  cwd: string,
  mcpServers: [                  # MCP server config
    { name: 'AcpUI', type: 'stdio', command: 'node stdio-proxy.js' }
  ],
  [+ provider-specific from provider.module.buildSessionParams(payload)]
}
  ↓
  Daemon creates session, returns:
  {
    sessionId: string,
    model?: string,
    availableModels?: [...],      # Dynamic catalog
    currentModelId?: string
  }

STEP 4: Backend → Daemon (for each prompt)
session/prompt {
  sessionId: string,
  prompt: [
    { type: 'text', text: '...' } |
    { type: 'image', media_type: 'image/jpeg', data: 'base64...' }
  ]
}
  ↓
  Daemon processes, emits stream of notifications:

STEP 5A: Daemon → Backend (streaming notifications)
session/update {
  sessionId: string,
  type: 'agent_message_chunk' | 'agent_thought_chunk' | 'tool_call' | 'tool_call_update' | 'usage_update' | 'turn_end',
  [payload varies by type]
}

STEP 5B: Daemon → Backend (permissions)
session/request_permission {
  id: <JSON-RPC id>,             # MUST be responded with this ID
  toolName: string,
  input: {...},
  ...
}
  Backend must respond:
  {
    jsonrpc: '2.0',
    id: <same id>,
    result: { outcome: 'selected' | 'cancelled' }
  }

STEP 5C: Daemon ↔ MCP Proxy ↔ Backend
[Tool execution via stdio proxy]

STEP 6: Backend → Daemon (on completion)
session/cancel {
  sessionId: string
}
  (Notification, no response expected)
```

**What happens if the contract breaks:**

1. If `sessionMetadata` is lost → Session resumes from DB, but streaming state is reset
2. If ACP protocol is out of sync → JSON-RPC correlation fails; requests hang or match wrong responses
3. If MCP server config is missing → Tools fail with "unknown tool" errors
4. If model IDs aren't resolved correctly → `session/set_model` calls fail
5. If permissions aren't responded with correct ID → Daemon waits forever for permission response

---

## Configuration / Provider Support

### What a Provider Must Do

A provider directory (e.g., `providers/my-provider/`) must contain:

**1. `provider.json`** — Protocol identity and MCP config

```json
{
  "protocolPrefix": "my-protocol://",    // For extension routing
  "mcpName": "AcpUI",                    // MCP server name (in mcpServers[])
  "toolAliases": {                       // Map tool names if needed
    "ux_invoke_shell": "execute_shell"   // If daemon calls by different name
  }
}
```

**2. `branding.json`** — UI identity

```json
{
  "name": "My Provider",
  "shortName": "MP",
  "color": "#FF6B35",
  "models": {
    "default": "my-model-v1",
    "quickAccess": [
      { "id": "my-model-v1", "name": "Model V1" },
      { "id": "my-model-v2", "name": "Model V2" }
    ]
  },
  "commands": [
    { "name": "logout", "icon": "SignOut" }
  ]
}
```

**3. `user.json`** — Deployment contract (REQUIRED)

```json
{
  "command": "my-agent-cli",            // Executable to spawn
  "args": ["--stdio"],                  // Arguments
  "cwd": "C:\\my-workspace",            // Working directory
  "env": { "MY_API_KEY": "..." }        // Environment variables
}
```

**4. `index.js`** — Logic module (REQUIRED)

Must export these hooks (all optional):

```javascript
export default {
  // Called during handshake; can inject custom fields into initialize
  performHandshake() {
    return { customField: 'value' };
  },
  
  // Called before routing session/update; can transform the update
  normalizeUpdate(update) {
    if (update.type === 'agent_message_chunk') {
      update.content = update.content.toUpperCase();  // Example transform
    }
    return update;
  },
  
  // Called when creating a new session; can inject spawn-time params
  buildSessionParams(payload) {
    return {
      _meta: { spawnAgent: payload.agent }  // Forwarded to daemon
    };
  },
  
  // Called when building the MCP server config; can attach _meta to server entry
  getMcpServerMeta() {
    return undefined;  // Return object to attach as _meta on the MCP server config
  },
  
  // Called after session/new to set initial agent (post-creation)
  setInitialAgent(sessionId, agentName) {
    return request('session/set_agent', { sessionId, agent: agentName });
  },
  
  // Called to get hooks for a specific agent
  getHooksForAgent(agentName) {
    return [
      { when: 'session_start', agent: agentName, script: 'my-hook.sh' }
    ];
  },
  
  // Called to parse JSONL session files back into timeline
  parseSessionHistory(jsonlPath) {
    return messages;  // Array of message objects
  }
}
```

### Provider-Specific Behaviors

Different providers can:
- **Intercept updates** via `normalizeUpdate()` (e.g., parse custom response fields)
- **Inject spawn params** via `buildSessionParams()` (e.g., pass agent name at session creation)
- **Attach MCP server metadata** via `getMcpServerMeta()` (e.g., inject timeout overrides into the MCP server config)
- **Set post-creation agent** via `setInitialAgent()` (e.g., after session is created, switch to a different agent)
- **Define hooks** via `getHooksForAgent()` (e.g., run scripts on session start, pre/post tool)
- **Parse session history** via `parseSessionHistory()` (e.g., convert provider-specific JSONL format to Unified Timeline)

The backend core doesn't know or care about these differences — it just calls the hooks and uses the results.

---

## Data Flow Example: From Daemon Output to Socket Event

### Raw Daemon Output (JSON-RPC)

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "abc-123",
    "type": "agent_message_chunk",
    "content": "Here's the answer: "
  }
}
```

### Backend Processing (acpUpdateHandler.js, Lines 100-123)

```javascript
const update = normalizeUpdate(raw);  // Allow provider to transform

// Buffer the chunk
metadata.lastResponseBuffer += update.content;

// Estimate tokens
const estimatedTokens = Math.ceil(update.content.length / 4);

// Emit socket event
io.emit('token', {
  providerId,
  sessionId,
  text: update.content
});

// Emit stats
io.emit('stats_push', {
  providerId,
  sessionId,
  usedTokens: metadata.usedTokens + estimatedTokens,
  totalTokens: metadata.totalTokens
});
```

### Frontend Rendering (useStreamStore.ts, Lines 95-121)

```typescript
useStreamStore.onStreamToken({ text, providerId, sessionId });

// In processBuffer() (Lines 199-402):
// - Accumulate tokens in buffer
// - Emit to typewriter loop
// - Render character-by-character in AssistantMessage component
```

### Final Rendered Output in Timeline

```
Assistant Message (turn_end)
  Text: "Here's the answer: [streaming...]"
  Tokens: 245 used / 4096 total
  Time: 3.2s
```

---

## Component Reference

### Backend Services

| File | Key Exports | Lines | Purpose |
|------|-------------|-------|---------|
| `server.js` | `startServer()` | 102-109 | HTTPS + Socket.IO + service init |
| `acpClient.js` | `AcpClient` class | 30-51 | ACP daemon lifecycle & message routing |
| | `.start()` | 85-195 | Spawn daemon, setup stdio, handle restarts |
| | `.handleAcpMessage()` | 225-260 | Route by method type |
| | `.handleUpdate()` | 262-264 | Delegate to acpUpdateHandler |
| `providerRegistry.js` | `getProviderRegistry()` | 130-133 | Load multi-provider config |
| | `resolveProviderId()` | 143-151 | Validate & normalize provider ID |
| `providerRuntimeManager.js` | `ProviderRuntimeManager.init()` | 14-47 | Initialize all providers |
| | `.getClient(providerId)` | 58-60 | Return AcpClient for provider |
| `providerLoader.js` | `getProvider(providerId)` | 26-68 | Load provider config + module |
| | `getProviderModule(providerId)` | 108-129 | Async import + merge with defaults |
| | `runWithProvider(providerId, fn)` | 21-24 | Run fn in provider context |
| `acpUpdateHandler.js` | `handleUpdate(update)` | 16-283 | Route by update type; delegates to Tool System V2 for tools |
| | Config option handler | 30-66 | Normalize, merge, save, and emit provider settings |
| `toolRegistry.js` | `toolRegistry.dispatch()` | 1-29 | Dispatch tool lifecycle events to specific handlers |
| `toolCallState.js` | `toolCallState.upsert()` | 1-131 | Maintain authoritative and sticky tool state |
| `toolInvocationResolver.js` | `resolveToolInvocation()` | 1-106 | Merge provider extraction with cached tool state |
| `toolIdPattern.js` | `matchToolIdPattern()` | 1-61 | Match provider-specific MCP tool ID patterns |
| `modelOptions.js` | `extractModelState()` | 48-68 | Combine available + current models |
| | `resolveModelSelection()` | 82-109 | Resolve string selection → modelId |
| `sessionManager.js` | `loadSessionIntoMemory()` | 177-253 | Hot-load session into memory |
| | `autoLoadPinnedSessions()` | 232-254 | Warm up all pinned sessions on startup |
| | `autoSaveTurn()` | 261-307 | 3s delay save during streaming |
| `database.js` | `initDb()` | 19-93 | SQLite schema + migrations |
| | `saveSession()` | 118-157 | INSERT/UPDATE session |
| | `getSession()` | 240-266 | Full session with messages |
| | `saveModelState()` | 514-561 | Upsert currentModelId + options |

### Socket Handlers

| File | Event Names | Lines | Purpose |
|------|-------------|-------|---------|
| `sockets/index.js` | `connection`, `watch_session`, `unwatch_session` | 50-126 | Provider hydration, session rooms |
| `sockets/sessionHandlers.js` | `load_sessions`, `create_session`, `fork_session`, `merge_fork`, `set_session_model` | 94-481 | Session CRUD & model/config management |
| `sockets/promptHandlers.js` | `prompt`, `cancel_prompt`, `respond_permission`, `set_mode` | 11-225 | Prompt execution, lifecycle hooks (`onPromptStarted` at 114, `onPromptCompleted` at 158), cascading cancellation, improved error recovery |
| `sockets/archiveHandlers.js` | `archive_session`, `restore_archive`, `delete_archive` | 9-149 | Archive/restore sessions |
| `sockets/canvasHandlers.js` | `canvas_save`, `canvas_load`, `canvas_apply_to_file`, `canvas_read_file` | 7-78 | Artifact CRUD |
| `sockets/folderHandlers.js` | `create_folder`, `rename_folder`, `delete_folder`, `move_session_to_folder` | 16-67 | Folder management |
| `sockets/fileExplorerHandlers.js` | `explorer_list`, `explorer_read`, `explorer_write` | 19-64 | File system browsing (safe paths) |
| `sockets/gitHandlers.js` | `git_status`, `git_diff`, `git_stage`, `git_unstage` | 11-89 | Git integration |
| `sockets/terminalHandlers.js` | `terminal_spawn`, `terminal_input`, `terminal_resize`, `terminal_kill` | 9-59 | PTY terminal sessions |
| `sockets/shellRunHandlers.js` | `shell_run_input`, `shell_run_resize`, `shell_run_kill` | 39-82 | Interactive shell controls; also exports `emitShellRunSnapshotsForSession()` called by `watch_session` to push `shell_run_snapshot` events to reconnecting clients |

### MCP Layer

| File | Key Exports | Lines | Purpose |
|------|-------------|-------|---------|
| `mcp/mcpServer.js` | `createToolHandlers(io)` | 140-289 | Tool implementations; returns map of handlers |
| | `.ux_invoke_shell` | 143-175 | Shell command execution via `shellRunManager` with description caching |
| | `.ux_invoke_subagents` | 177-218 | Parallel agent spawning via `subAgentInvocationManager`, includes abort-signal forwarding and idempotency |
| | `.ux_invoke_counsel` | 232-286 | Expert evaluation; delegates to ux_invoke_subagents |
| `mcp/stdio-proxy.js` | `backendFetch(path, options)` | 46-60 | HTTP fetch with 3-attempt retry; abort errors bypass retry immediately (line 55) |
| | `runProxy()` | 62-119 | Stdio MCP proxy setup; fetches schemas, registers with MCP SDK, forwards tool calls with MCP abort-signal |
| `routes/mcpApi.js` | `createToolCallAbortSignal(req, res, toolName)` | 17-31 | Create AbortSignal from request/response lifecycle events |
| | `canWriteResponse(res, abortSignal)` | 33-35 | Guard response writes to abort-signaled or closed responses |
| | `GET /api/mcp/tools` | 54-118 | Tool schema endpoint |
| | `POST /api/mcp/tool-call` | 124-158 | Tool execution endpoint; timeouts disabled, disconnect aborts propagated to handlers |
| `mcp/mcpProxyRegistry.js` | proxy binding helpers | 1-78 | Correlates stdio MCP proxy instances to provider/session context |
| `services/shellRunManager.js` | `detectPwsh(platform, spawnSyncFn)` | 28-44 | Detect PowerShell 7+ availability on Windows |
| | `ShellRunManager` class | 114-141 | Constructor with `pwshAvailable` option (null = auto-detect via `detectPwsh()`) |
| | `resizeRun(runId, cols, rows)` | 312-324 | Resize PTY; wrapped in try/catch for Windows race condition |
| | (overall) | 113-462 | Interactive PTY lifecycle, startup control sanitation, transcripts, termination formatting, completed-run cleanup |
| `mcp/subAgentInvocationManager.js` | `subAgentParentKey(providerId, acpSessionId)` | 57-59 | Build parent-child tracking key |
| | `trackSubAgentParent(providerId, childAcpSessionId, parentAcpSessionId)` | 61-68 | Record parent-child relationship |
| | `collectDescendantAcpSessionIds(parentAcpSessionId, providerId)` | 70-95 | Recursive descent graph traversal for cascade cancellation |
| | `cancelAllForParent(parentAcpSessionId, providerId)` | 124-131 | Cancel all invocations for parent and descendants |
| | `SubAgentInvocationManager` class | 12-382 | Orchestrates sub-agent sessions, state machine, recursive parent-child cancellation, abort-signal flow, idempotency |

---

## Gotchas & Important Notes

### 1. AsyncLocalStorage Context Isolation
**What breaks:** If code runs outside the provider context, it won't have access to the current `providerId`.

**Why:** Every async operation in AcpUI runs within `runWithProvider(providerId, fn)`. If you spawn a background task without wrapping it, the task will have no provider context.

**How to avoid:** Always wrap async code that needs provider context. Example:
```javascript
runWithProvider(providerId, async () => {
  const provider = getProvider();  // Works — has providerId
  await doSomething();
});
```

---

### 2. Provider Intercept Happens Before Routing
**What breaks:** If a provider's `normalizeUpdate()` modifies the update type, routing will use the wrong handler.

**Why:** The provider intercept (Lines 284-355 in acpClient.js) runs before `acpUpdateHandler.handleUpdate()` is called (Line 262). If a provider transforms the update structure or type, the backend's routing logic won't match.

**How to avoid:** Provider modules should preserve the `type` field. If custom logic is needed, do it after routing (within the handler) or use a wrapper instead of modifying the type.

---

### 3. Draining During session/load Replay
**What breaks:** The first prompt after loading a session contains duplicate messages (old + new).

**Why:** When `session/load` completes, the ACP daemon replays all historical updates. The backend uses `StreamController.drain()` (Lines 74-82 in acpUpdateHandler.js) to swallow these chunks so they don't re-emit to the UI.

**How to avoid:** Don't emit to the frontend during the initial drain period. The drain flag is set automatically during session/load.

---

### 4. autoSave Permission-Awareness
**What breaks:** A session is marked "streaming" even after the user denies a permission, leaving it in an inconsistent state.

**Why:** `autoSaveTurn()` (Lines 284-330 in sessionManager.js) checks if there are pending permissions before finalizing the message. If a permission is pending, the turn stays open.

**How to avoid:** Don't manually finalize messages while permissions are pending. The permission response handler will trigger the finalize logic.

---

### 5. Cascade Delete on Sessions
**What breaks:** Forked sessions are orphaned when the parent is deleted; sub-agents' files aren't cleaned up.

**Why:** When `delete_session` is called (Lines 168-202 in sessionHandlers.js), it recursively deletes all child forks and sub-agents. If the cascade logic is missing, orphaned files can accumulate.

**How to verify:** When deleting a session, check that:
- All forked children are deleted from DB
- All sub-agent session files (JSONL, JSON, tasks) are removed via `acpCleanup()`
- Attachments for all descendants are cleaned up

---

### 6. Exponential Backoff Restart Logic
**What breaks:** The daemon keeps restarting in a tight loop, consuming resources.

**Why:** If the daemon exits repeatedly without delay, a tight loop can starve resources. The restart handler (Lines 157-195 in acpClient.js) uses exponential backoff: 2s → 4s → 8s → 16s → 30s.

**How to detect:** Check backend logs for repeated "ACP daemon exited" messages. If the backoff isn't working, the restart handler may have a bug.

---

### 7. Tool Metadata is "Sticky"
**What breaks:** When a tool output is updated (tool_call_update), the file context or description is lost.

**Why:** Tool metadata (file path, title, input) must persist across multiple updates. In Tool System V2, `toolCallState.js` handles this by merging new updates into the cached state for that `toolCallId`. It also uses a priority system to ensure that high-quality titles (like an MCP description) aren't overwritten by generic provider titles.

**How to avoid:** Use `toolCallState.upsert()` to manage tool state. The `toolInvocationResolver` automatically merges provider-extracted data with the cached "sticky" state.

---

### 8. Model Selection Resolution Chain
**What breaks:** `session/set_model` is called with a string that doesn't exist in the provider's model catalog.

**Why:** Model IDs can be user-friendly names, provider quick-access shortcuts, or raw IDs from the daemon. The resolution chain (Lines 82-109 in modelOptions.js) tries: explicit selection → provider.models.default → quickAccess[0] → advertisedOptions[0].

**How to avoid:** Always use `resolveModelSelection()` before calling `session/set_model`. Don't pass raw user input directly.

---

### 9. Session Metadata Must Be Reconstructed on Load
**What breaks:** After loading a session from DB, the active model isn't applied; `currentModelId` is stale.

**Why:** `sessionMetadata` is ephemeral (cleared on daemon restart). When a session loads, its metadata must be reconstructed from DB. If this step is skipped, the session will use the daemon's default model, not the saved selection.

**How to verify:** In `loadSessionIntoMemory()` (Lines 177-253), check that:
- `sessionMetadata[sessionId]` is initialized from DB fields
- If DB has `currentModelId`, call `session/set_model` immediately

---

### 10. No-Commit Policy
**What breaks:** Agents attempt to commit changes without explicit user instruction.

**Why:** BOOTSTRAP.md (Rule 4, Section 5) forbids `git commit` unless explicitly instructed. The backend itself has no git restrictions, but agents should respect the policy.

**How to enforce:** Git handlers (gitHandlers.js) only implement status, diff, stage, unstage — no commit. If agents need to commit, they must ask the user first.

---

## Unit Tests

### Backend Test Files

Located in `backend/test/`. Total: 52 test files

**Key test files:**

| File | Subject | Coverage |
|------|---------|----------|
| `acpClient.test.js` | Daemon lifecycle, restart logic, message routing | 90%+ |
| `sessionHandlers.test.js` | CRUD, fork, merge, model state | 88%+ |
| `promptHandlers.test.js` | Prompt execution, attachment processing, cancellation | 85%+ |
| `archiveHandlers.test.js` | Archive/restore cascade delete | 90%+ |
| `database.test.js` | SQLite schema, migrations, queries | 92%+ |
| `modelOptions.test.js` | Model resolution, dedup, extraction | 95%+ |
| `providerRegistry.test.js` | Provider loading, validation, registry | 94%+ |
| `acpUpdateHandler.test.js` | Update routing, token buffering, tool normalization | 87%+ |
| `mcpServer.test.js` | Tool execution, shell, subagents, counsel | 85%+ |
| `sessionManager.test.js` | Hot-load, auto-save, pinned session warmup | 88%+ |

**Run tests:**
```bash
cd backend
npx vitest run              # Run all tests
npx vitest run --coverage   # With coverage report
```

---

## How to Use This Guide

### For Implementing Backend Features

1. **Understand the flow:** Read Section "How It Works — End-to-End Flow" (Steps 1-12 above)
2. **Identify the layer:** Is your feature in:
   - **Socket handlers?** → See sockets/* files + Component Reference table
   - **ACP client?** → See acpClient.js + performHandshake/handleAcpMessage sections
   - **Session management?** → See sessionManager.js + sessionMetadata contract
   - **MCP tools?** → See mcpServer.js + stdio-proxy flow
3. **Check the gotchas:** Read the gotcha section above for your area
4. **Find exact line numbers:** Use the Component Reference table; read those lines in the actual code
5. **Write tests:** Use existing tests as templates; maintain 90%+ coverage
6. **Update docs:** If you change architecture/flow, update this Feature Doc

### For Debugging Backend Issues

1. **Check the logs:** Enable `LOG_FILE_PATH` in `.env`; look for error timestamps matching the issue
2. **Identify the phase:** Determine which step (1-12 above) the issue affects:
   - Issue during startup? → Check Step 1-3 (server, providers, ACP client)
   - Issue during prompt? → Check Step 6-8 (session, prompt, routing)
   - Issue during streaming? → Check Step 9-10 (updates, auto-save)
3. **Trace the data:** Follow the Data Flow Example backwards from the symptom
4. **Check the contract:** Verify sessionMetadata shape and ACP protocol state match expectations
5. **Run tests:** Run relevant test file to isolate the issue
6. **Add logging:** Add `console.log()` at boundaries (before/after provider calls, socket emissions, DB operations) to trace the flow

---

## Summary

The AcpUI backend is a **provider-agnostic orchestrator** that:

1. **Bootstraps** with multi-provider support, spawning isolated ACP clients per provider
2. **Manages sessions** with persistent state in SQLite, model metadata, and attachment tracking
3. **Streams responses** in real-time via Socket.IO, handling tokens, thoughts, tool calls, and permissions
4. **Normalizes** provider differences via pluggable modules that intercept and transform updates
5. **Executes tools** via a stateless stdio MCP proxy that forwards to backend handlers
6. **Persists state** automatically every 3s during streaming, supporting hot-resume and cascade cleanup
7. **Enforces isolation** via AsyncLocalStorage so concurrent providers don't interfere

**The critical contract is twofold:**
- **sessionMetadata shape**: Tracks active model selection, token counts, tool context, and streaming state
- **ACP JSON-RPC flow**: Strict initialize → session/new → prompt → update notifications → turn_end sequence

Every backend task boils down to understanding which phase of this flow you're touching, checking the gotchas for that phase, and ensuring the sessionMetadata + ACP contract remains intact.

Agents reading this doc should be able to:
- ✅ Implement a new socket handler (session create, model switch, etc.)
- ✅ Debug streaming issues (missing tokens, model state corruption)
- ✅ Add provider-specific behavior (custom hook, update normalization)
- ✅ Understand session lifecycle (create → load → prompt → fork → merge → archive)
- ✅ Trace data flow from frontend socket event to DB persistence
