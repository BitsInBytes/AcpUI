# Feature Doc — MCP Server System

**AcpUI's custom MCP (Model Context Protocol) server bridges the ACP daemon to AcpUI-specific tools via a stateless stdio proxy. Tools like `ux_invoke_shell`, `ux_invoke_subagents`, and `ux_invoke_counsel` run as tool handlers in the backend, not in the proxy — keeping all orchestration and I/O logic centralized.**

This is a critical infrastructure component. The system's key insight: the proxy is a thin, generic passthrough, while all intelligence (interactive shell PTY lifecycle, socket emission, sub-agent orchestration) stays in the backend Node.js process.

---

## Overview

### What It Does

When an ACP session is created, the backend injects an MCP server config telling the ACP to spawn `node stdio-proxy.js`. That proxy:

1. Fetches tool definitions from the backend's HTTP API
2. Registers those tools with the MCP SDK
3. Waits for the ACP to call a tool
4. Forwards every tool call to an HTTP endpoint
5. Returns the result to the ACP

Meanwhile, the **backend** handles all the real work:
- Spawning PTYs for shell commands through `ShellRunManager`
- Creating sub-agent ACP sessions
- Emitting Socket.IO events for live updates
- Managing databases and file systems

### Why Two Processes?

**Simplicity:** The proxy is stateless and generic. Swapping it for a different ACP implementation requires only changing which executable the proxy points to.

**Separation of Concerns:** MCP protocol handling is isolated from business logic. Tools are decoupled from how they're discovered or called.

**Scalability:** If needed, the proxy could be separate microservices per provider, while the backend handles orchestration.

### Why This Matters

- **No tool state in the proxy:** If the proxy crashes, tools and sockets aren't affected
- **Live streaming works:** Tools can emit real-time updates via Socket.IO (the proxy just forwards results)
- **Sub-agents work:** Tools can spawn new ACP sessions independently
- **Backend HTTP timeouts disabled:** backend routes keep long tool calls open; provider MCP clients may still retry or time out upstream, so side-effectful tools need replay protection

---

## Architecture

The system has **three components**:

### 1. **Backend Tool Handlers** (`backend/mcp/mcpServer.js`)

Where the actual tool logic lives. These are plain async functions that receive `{ description, command, args, providerId, ... }` and resolve with `{ content: [{ type: 'text', text: '...' }] }` or throw errors.
```javascript
// FILE: backend/mcp/mcpServer.js (Lines 70-85)
tools.ux_invoke_shell = async ({ description, command, cwd, providerId, acpSessionId, mcpRequestId, requestMeta }) => {
  // Delegate to shellRunManager for interactive terminal execution.
};

tools.ux_invoke_subagents = async ({ requests, model, providerId, acpSessionId, mcpProxyId, mcpRequestId, requestMeta }) => {
  // Build an idempotency key, then spawn sub-agent sessions through SubAgentInvocationManager.
};
```

### 2. **Stdio Proxy** (`backend/mcp/stdio-proxy.js`)

A child process spawned per ACP session. The proxy is stateless and generic.

```javascript
// FILE: backend/mcp/stdio-proxy.js
async function runProxy() {
  // Fetch tool definitions from backend
  const { tools, serverName } = await backendFetch(`/api/mcp/tools?providerId=...&proxyId=...`);
  
  // Register with MCP SDK and advertise server-level instructions
  const instructions = buildServerInstructions(tools, serverName);
  const server = new Server({ name: serverName, ... }, { instructions, ... });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [...] }));
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    // Forward to backend HTTP endpoint
    return await backendFetch('/api/mcp/tool-call', {
      method: 'POST',
      body: JSON.stringify({
        tool: req.params.name,
        args: req.params.arguments,
        providerId: ...,
        proxyId: ...,
        mcpRequestId: extra?.requestId,
      })
    });
  });
  
  // Connect to ACP via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
```

**Key details:** The proxy fetches tool definitions on startup and derives MCP `instructions` from the same tool list. If schemas are out of date, discovery and instructions will both be stale until a new session starts.

### 3. **Backend HTTP API** (`backend/routes/mcpApi.js`)

Two routes that bridge proxy ↔ backend:

**GET /api/mcp/tools?providerId=...&proxyId=...** — Returns tool definitions with JSON schemas and MCP tool metadata.
```javascript
// FILE: backend/routes/mcpApi.js (Lines 30-73)
router.get('/tools', (req, res) => {
  const context = resolveToolContext(req.query.providerId || null, req.query.proxyId || null);
  const toolList = [
    { 
      name: 'ux_invoke_shell', 
      description: 'Execute a shell command in a real terminal with live streaming output and user-interactive stdin while the process is running...',
      inputSchema: { type: 'object', properties: { description: {...}, command: {...}, cwd: {...} }, required: ['description', 'command'] }
    },
    { 
      name: 'ux_invoke_subagents',
      ...
    },
    // ... more tools
  ];
  res.json({ tools: toolList, serverName: 'AcpUI' });
});
```

**POST /api/mcp/tool-call** — Executes a tool and returns the result.
```javascript
// FILE: backend/routes/mcpApi.js (Lines 81-113)
router.post('/tool-call', async (req, res) => {
  // CRITICAL: Disable timeouts so tools can run indefinitely
  req.setTimeout(0);      // LINE 85
  res.setTimeout(0);      // LINE 86
  if (req.socket) req.socket.setTimeout(0);

  const { tool: toolName, args, providerId } = req.body;
  const handler = tools[toolName];
  if (!handler) {
    res.status(404).json({ error: `Unknown tool: ${toolName}` });
    return;
  }

  try {
    const result = await handler({ ...(args || {}), providerId });  // LINE 99
    res.json(result);  // Content array, not plain text
  } catch (err) {
    res.json({ content: [{ type: 'text', text: `Error: ${err.message}` }] });
  }
});
```

---

## How It Works — End-to-End Flow

### 1. **Session Creation Request from User**

User creates a session in the UI. Backend receives `create_session` via Socket.IO.

### 2. **Backend Constructs MCP Server Config**

**File:** `backend/services/sessionManager.js` (Lines 28-44)

```javascript
export function getMcpServers(providerId, { acpSessionId = null } = {}) {
  const name = getProvider(providerId).config.mcpName;  // "AcpUI" (configurable)
  if (!name) return [];
  const proxyPath = path.resolve(__dirname, '..', 'mcp', 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId, acpSessionId });  // LINE 32: Creates proxy registry entry
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(providerId) },  // LINE 38: Critical for multi-provider
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },                  // LINE 39: Proxy identity for session binding
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ]
  }];
}
```

**Note the environment variables:**
- `ACP_SESSION_PROVIDER_ID` — So the proxy knows which provider to report tools for
- `ACP_UI_MCP_PROXY_ID` — A unique proxy id that binds this proxy to its provider/session context in the registry
- `BACKEND_PORT` — So the proxy knows where to send HTTP requests
- `NODE_TLS_REJECT_UNAUTHORIZED` — For self-signed localhost certs

### 3. **Backend Sends session/new to ACP**

**File:** `backend/sockets/sessionHandlers.js` (Lines 330-332)

```javascript
result = await acpClient.transport.sendRequest('session/new', {
  cwd: sessionCwd,
  mcpServers: getMcpServers(resolvedProviderId),  // <- Injected here
  ...sessionParams
});
```

The `mcpServers` array is sent in the `session/new` RPC request.

### 4. **ACP Spawns Proxy Process**

The ACP reads the `mcpServers` array and spawns a child process:
```bash
node /path/to/stdio-proxy.js
```

With environment variables from the config.

### 5. **Proxy Fetches Tool Definitions**

**File:** `backend/mcp/stdio-proxy.js` (Lines 40-41)

```javascript
const queryParts = [];
if (providerId) queryParts.push(`providerId=${encodeURIComponent(providerId)}`);
if (proxyId) queryParts.push(`proxyId=${encodeURIComponent(proxyId)}`);
const query = queryParts.length > 0 ? `?${queryParts.join('&')}` : '';
const { tools, serverName } = await backendFetch(`/api/mcp/tools${query}`);
```

The proxy makes an HTTPS request to the backend's GET /api/mcp/tools endpoint. Includes a retry loop (lines 25-38) with exponential backoff (500ms * attempt) for reliability.

### 6. **Proxy Registers with MCP SDK**

**File:** `backend/mcp/stdio-proxy.js`

```javascript
const resolvedServerName = serverName || 'acpui-proxy';
const instructions = buildServerInstructions(tools, resolvedServerName);
const server = new Server(
  { name: resolvedServerName, version: '1.0.0' },
  { capabilities: { tools: {} }, instructions }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map(t => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  return await backendFetch('/api/mcp/tool-call', {
    method: 'POST',
    body: JSON.stringify({
      tool: name,
      args: args || {},
      providerId: process.env.ACP_SESSION_PROVIDER_ID || null,
      proxyId: process.env.ACP_UI_MCP_PROXY_ID || null,
      mcpRequestId: extra?.requestId ?? null,
      requestMeta: request.params?._meta || extra?._meta || null
    }),
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

Now the proxy is listening on stdin/stdout for MCP RPC requests from the ACP. The `instructions` payload gives the agent server-level guidance about available AcpUI tools before it decides whether to call any tool.

### 7. **Agent Calls a Tool**

The agent issues a call to `ux_invoke_shell`:
```
Agent: "Let me run npm test"
ACP: Calls tool "ux_invoke_shell" with { command: "npm test", cwd: "..." }
```

### 8. **ACP Sends CallTool RPC to Proxy (via stdio)**

The ACP sends a JSON-RPC request on stdout:
```json
{
  "jsonrpc": "2.0",
  "id": 123,
  "method": "call_tool",
  "params": {
    "name": "ux_invoke_shell",
    "arguments": {
      "command": "npm test",
      "cwd": "/home/user/project"
    }
  }
}
```

### 9. **Proxy Forwards to Backend HTTP Endpoint**

**File:** `backend/mcp/stdio-proxy.js`

```typescript
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args } = request.params;
  return await backendFetch('/api/mcp/tool-call', {
    method: 'POST',
    body: JSON.stringify({ 
      tool: name,                                       // "ux_invoke_shell"
      args: args || {},                                // { command, cwd }
      providerId: process.env.ACP_SESSION_PROVIDER_ID, // From env
      proxyId: process.env.ACP_UI_MCP_PROXY_ID,        // Session binding
      mcpRequestId: extra?.requestId ?? null
    }),
  });
});
```

The proxy calls `backendFetch()` (with retry logic) to POST /api/mcp/tool-call.

### 10. **Backend Executes Tool Handler**

**File:** `backend/routes/mcpApi.js` (Lines 103-132)

```javascript
const context = resolveToolContext(providerId || null, proxyId || null);  // LINE 118: Resolve from proxy registry
const handlerArgs = { ...(args || {}) };
if (context.providerId)   handlerArgs.providerId   = context.providerId;
if (context.acpSessionId) handlerArgs.acpSessionId = context.acpSessionId;
if (context.mcpProxyId)   handlerArgs.mcpProxyId   = context.mcpProxyId;
if (mcpRequestId !== undefined && mcpRequestId !== null) handlerArgs.mcpRequestId = mcpRequestId;
if (requestMeta)          handlerArgs.requestMeta  = requestMeta;
const result = await handler(handlerArgs);  // Execute; may block for long-running tools
res.json(result);
```

The handler for `ux_invoke_shell` delegates to `shellRunManager.startPreparedRun(...)` and blocks until the PTY exits or is user-terminated. It emits `shell_run_started`, `shell_run_output`, and `shell_run_exit` during execution.

### 11. **Tool Result Returned to Proxy**

The handler resolves with:
```javascript
{
  content: [
    { 
      type: 'text', 
      text: 'npm test output...\n\nExit Code: 0' 
    }
  ]
}
```

This is sent back via HTTP response.

### 12. **Proxy Returns Result to ACP**

The proxy returns the HTTP response body as the MCP result.

### 13. **ACP Forwards to Agent**

The ACP routes the tool result back to the agent, which can now use it in its reasoning.

---

## Architecture Diagram

```mermaid
graph TB
    subgraph ACP["ACP Process"]
        A["Agent"] 
        ACP_Core["ACP Core<br/>(JSON-RPC, session mgmt)"]
    end
    
    subgraph Proxy["Proxy Process<br/>(stdio-proxy.js)"]
        Proxy_Main["runProxy()"]
        MCP_SDK["MCP SDK<br/>(ListTools, CallTool)"]
        Retry["backendFetch<br/>(retry loop)"]
    end
    
    subgraph Backend["Backend Node Process"]
        Handler["Tool Handlers<br/>(mcpServer.js)"]
        API["HTTP Routes<br/>(mcpApi.js)"]
        Logic["Tool Logic<br/>(PTY, Sockets, DB)"]
    end
    
    A -->|"calls tool"| ACP_Core
    ACP_Core -->|"CallTool RPC<br/>(via stdio)"| MCP_SDK
    MCP_SDK -->|"1. GET /tools"| Retry
    Retry -->|"Fetch"| API
    API -->|"Tool schemas"| Retry
    Retry -->|"Register"| MCP_SDK
    MCP_SDK -->|"2. POST /tool-call"| Retry
    Retry -->|"Forward"| API
    API -->|"{ tool, args }"| Handler
    Handler -->|"Execute"| Logic
    Logic -->|"May emit"| Socket["Socket.IO<br/>events"]
    Logic -->|"Result"| Handler
    Handler -->|"{ content[] }"| API
    API -->|"HTTP 200"| Retry
    Retry -->|"Return"| MCP_SDK
    MCP_SDK -->|"RPC Response<br/>(via stdout)"| ACP_Core
    ACP_Core -->|"Tool result"| A
```

---

## The Critical Contract: Schema ↔ Handler Sync

**This is the #1 gotcha in this system.**

Tool schemas and handlers are defined in **two separate files** with **no code linking them together**. They must be manually kept in sync.

### Where Schemas Are Defined

**File:** `backend/routes/mcpApi.js` (Lines 30-73)

```javascript
const toolList = [
  { 
    name: 'ux_invoke_shell',
    description: '...',
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '...' },
        description: { type: 'string', description: 'Short user-facing run description for the tool header.' },
        cwd: { type: 'string', description: '...' },
      },
      required: ['description', 'command'],
    }
  },
  // ... more tools
];
res.json({ tools: toolList, serverName });
```

### Where Handlers Are Defined

**File:** `backend/mcp/mcpServer.js` (Lines 67-117)

```javascript
export function createToolHandlers(io) {
  const tools = {};

  tools.ux_invoke_shell = async ({ description, command, cwd, providerId, acpSessionId, mcpRequestId, requestMeta }) => {  // LINE 70
    // Interactive implementation via shellRunManager
  };

  tools.ux_invoke_subagents = async ({ requests, model, providerId, acpSessionId, mcpProxyId, mcpRequestId, requestMeta }) => {
    // Build replay key; delegate to SubAgentInvocationManager
  };

  tools.ux_invoke_counsel = async ({ question, architect, performance, security, ux, providerId, acpSessionId, mcpProxyId, mcpRequestId, requestMeta }) => {
    // Builds counsel requests and reuses the sub-agent replay guard
  };

  return tools;
}
```

### The Contract

1. **Tool name must match:** `inputSchema` in GET /tools and `tools[name]` in createToolHandlers
2. **Input properties must match:** What's in `inputSchema.properties` must be passable to the handler. For `ux_invoke_shell`, `description` is required and must flow into `ShellRunManager` snapshots so the UI can render `Invoke Shell: <description>`.
3. **Required fields must match:** Fields marked `required: true` in schema must be the handler's required params

### Why It Breaks

If you add a tool to `mcpServer.js` but forget to add its schema to `mcpApi.js`:
- The proxy won't return the schema when ACP asks "what tools are available?"
- The ACP won't offer that tool to the agent
- Tool call silently fails if agent somehow tries it

If you add a schema but forget the handler:
- ACP offers the tool to the agent
- Agent calls it
- 404 error returned from /api/mcp/tool-call

### The Warning Comments

Both files have warning comments (read them!):

**mcpServer.js (Lines 8-9):**
```javascript
 * IMPORTANT: When adding/renaming/removing tools here, also update the schemas in mcpApi.js.
```

**mcpApi.js (Lines 10-13):**
```javascript
 * IMPORTANT: If you add/rename/remove tools in mcpServer.js, you must also update
 * the JSON Schema definitions in the GET /tools response below, AND the proxy will
 * pick up the changes automatically on next ACP session creation.
```

---

## Two getMcpServers Functions (The Gotcha)

**This is a subtle but important difference.**

### Version 1: For User Sessions (sessionManager.js)

**File:** `backend/services/sessionManager.js` (Lines 28-47)

```javascript
export function getMcpServers(providerId, { acpSessionId = null } = {}) {
  const name = getProvider(providerId).config.mcpName;
  if (!name) return [];
  const providerModule = getProviderModuleSync(providerId);
  const mcpServerMeta = providerModule.getMcpServerMeta?.();
  const proxyPath = path.resolve(__dirname, '..', 'mcp', 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId, acpSessionId });  // ← Creates registry entry
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(providerId) },  // ← Provider identity
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },                  // ← Proxy registry binding
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}
```

**Used by:** `sessionHandlers.js` for regular `session/new` and `session/load` calls.

**Key:** Creates a proxy registry entry and includes both `ACP_SESSION_PROVIDER_ID` and `ACP_UI_MCP_PROXY_ID` so the backend can resolve the proxy back to its provider/session context when a tool call arrives.

### Version 2: For Sub-Agent Sessions (mcpServer.js)

**File:** `backend/mcp/mcpServer.js` (Lines 38-58)

```javascript
export function getMcpServers(providerId = null, { acpSessionId = null } = {}) {
  const provider = getProvider(providerId);
  const name = provider.config.mcpName;
  if (!name) return [];
  const providerModule = getProviderModuleSync(providerId);
  const mcpServerMeta = providerModule.getMcpServerMeta?.();
  const proxyPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'stdio-proxy.js');
  const proxyId = createMcpProxyBinding({ providerId: provider.id, acpSessionId });  // ← Creates registry entry
  return [{
    name,
    command: 'node',
    args: [proxyPath],
    env: [
      { name: 'ACP_SESSION_PROVIDER_ID', value: String(provider.id) },
      { name: 'ACP_UI_MCP_PROXY_ID', value: proxyId },
      { name: 'BACKEND_PORT', value: String(process.env.BACKEND_PORT || 3005) },
      { name: 'NODE_TLS_REJECT_UNAUTHORIZED', value: '0' },
    ],
    ...(mcpServerMeta ? { _meta: mcpServerMeta } : {})
  }];
}
```

**Used by:** Inside `mcpServer.js` for sub-agent spawning (line 146: `mcpServers: getMcpServers(resolvedProviderId)`). After `session/new` returns, `bindMcpProxy` is called to associate the proxy id with the newly created ACP session id.

**Key:** Same contract as Version 1 — both include `ACP_SESSION_PROVIDER_ID` and `ACP_UI_MCP_PROXY_ID`. The distinction is purely about which call site uses which version.

### Why Two?

The sessionManager version is used by socket session creation paths. The mcpServer version is used by internal sub-agent session creation paths.

### Implication

Both flows propagate provider identity and proxy identity via env vars. The gotcha is maintenance drift: there are two implementations in different files and both must stay aligned to ensure provider scoping and proxy resolution work consistently for user sessions and sub-agent sessions.

**Provider metadata injection:** Both versions also call `getProviderModuleSync(providerId).getMcpServerMeta?.()` and conditionally attach the result as `_meta` on the server config entry. This allows providers to inject daemon-specific metadata (e.g., MCP timeout overrides) into both user session and sub-agent session spawn paths without duplicating logic.

---

## Adding a New Tool

If you want to add a new tool (e.g., `ux_invoke_test_runner`), you must update **three places**:

### 1. Define the Handler

**File:** `backend/mcp/mcpServer.js`

```javascript
// Add to createToolHandlers function
tools.ux_invoke_test_runner = async ({ command, framework, providerId }) => {
  // Your implementation
  return { content: [{ type: 'text', text: 'result' }] };
};
```

### 2. Define the Schema

**File:** `backend/routes/mcpApi.js`

```javascript
// Add to toolList in GET /tools
{
  name: 'ux_invoke_test_runner',
  description: 'Run tests with optional framework selection',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Test command to run' },
      framework: { type: 'string', description: 'Test framework (jest, mocha, etc)' },
    },
    required: ['command'],
  }
}
```

### 3. Add Unit Tests

**File:** `backend/test/mcpServer.test.js` and/or `backend/test/mcpApi.test.js`

Test both the handler and the schema definition.

### Verification

After making changes:
1. Run `npm run lint` to ensure no syntax errors
2. Run tests: `npx vitest run`
3. Start the backend and check logs for any errors
4. Test the tool via ACP to ensure it's discoverable and callable

---

## Component Reference

### Backend Files

| File | Functions | Lines | Purpose |
|------|-----------|-------|---------|
| `backend/mcp/mcpServer.js` | `createToolHandlers(io)` | 63-276 | Defines all tool handlers (ux_invoke_shell, ux_invoke_subagents, ux_invoke_counsel) |
| | `getMcpServers()` | 38-55 | Returns MCP server config for sub-agent spawning (includes proxy id env) |
| | `ux_invoke_shell` | 66-88 | Delegate to `shellRunManager` for interactive shell execution |
| | `ux_invoke_subagents` | 89-248 | Spawn sub-agents, await responses, cleanup |
| | `ux_invoke_counsel` | 250-276 | Spawn counsel agents (delegates to ux_invoke_subagents) |
| `backend/mcp/stdio-proxy.js` | `runProxy()`, `buildServerInstructions()` | 52-108 | Fetch schemas, derive MCP instructions, register with MCP SDK, forward tool calls with proxy/session context |
| | `backendFetch()` | 20-39 | HTTP request with 3-attempt retry loop |
| `backend/routes/mcpApi.js` | `GET /tools` | 34-97 | Return tool schemas and server name |
| | `POST /tool-call` | 103-132 | Execute tool handler, disable timeouts, return result |
| `backend/mcp/mcpProxyRegistry.js` | proxy binding helpers | 1-78 | Correlate stdio proxy ids to provider/session context |
| `backend/services/shellRunManager.js` | `ShellRunManager` | 113-460 | Interactive PTY lifecycle, startup control sanitation, and final-result formatting |
| `backend/services/sessionManager.js` | `getMcpServers(providerId, { acpSessionId })` | 28-44 | Returns MCP server config for user sessions (includes proxy id env) |

---

## Gotchas & Important Notes

### 1. **Schema and Handler Must Be in Sync**

Adding a tool to `mcpServer.js` without adding its schema to `mcpApi.js` means the agent can't discover it. Adding a schema without a handler causes 404 errors when the agent tries to call it.

**Test:** When you add a tool, verify that both places are updated before testing.

### 2. **HTTP Timeouts Are Disabled**

Lines 85-87 of `mcpApi.js` disable all HTTP timeouts. **This is intentional** — tools like sub-agents can take minutes. If you add timeout logic, be aware it's disabled at the socket level.

### 3. **Two Different getMcpServers Functions**

Both `sessionManager.js:getMcpServers(providerId)` and `mcpServer.js:getMcpServers(providerId)` include `ACP_SESSION_PROVIDER_ID` in env. They exist in two places because one is used for user session creation (sessionManager) and the other for sub-agent session creation within tool handlers (mcpServer). Both must stay aligned.

### 4. **The Proxy Retries Three Times**

`backendFetch()` in stdio-proxy.js (lines 25-38) retries with exponential backoff (500ms, 1s, 1.5s). If the backend is down, the proxy may hang for a few seconds before failing. This is intentional — allows backend startup race conditions to recover.

### 5. **Tool Result Must Be Content Array**

Handlers must return `{ content: [{ type: 'text', text: '...' }, ...] }`. Returning raw strings or other shapes will confuse the ACP.

### 6. **Side-Effectful Tool Calls Need Idempotency**

The stdio proxy retries failed backend fetches, and provider MCP clients may also retry a long-running tool if their own timeout fires or the response is lost. Tools that only read data can tolerate this. Tools that create durable side effects, especially `ux_invoke_subagents`, must deduplicate by provider/session/tool/MCP request identity and return an active or cached result instead of repeating the side effect.

`ux_invoke_subagents` builds a key from `mcpRequestId`, `requestMeta.toolCallId`, or a scoped hash of its input. Duplicate active calls join the original promise. Duplicate completed calls return the cached result for a short TTL.

### 7. **Provider Scope Is Inherited by Sub-Agents**

Sub-agent sessions inherit the parent provider's `ACP_SESSION_PROVIDER_ID` via environment variable. This ensures tools called from within sub-agents maintain the correct provider scope and access the right configuration, models, and branding. No fallback logic needed.

### 8. **Tool Definitions Are Cached by Proxy**

The proxy fetches tool definitions once at startup (line 41). If you update schemas while a session is running, the agent won't see the new definitions until a new session is created. No need to restart anything — just create a new session.

### 9. **Errors Must Be Caught and Wrapped**

If a handler throws, mcpApi.js catches it (line 102) and returns `{ content: [{ type: 'text', text: 'Error: ...' }] }`. The proxy passes this back as a successful response. The ACP sees it as tool output, not an error. This is acceptable — the tool ran and returned an error message.

### 10. **Shell Terminal Events Happen Outside Tool Result**

`ux_invoke_shell` emits `shell_run_started`, `shell_run_output`, and `shell_run_exit` through Socket.IO while the HTTP/MCP tool call remains pending. The final MCP result is returned only after process exit or user termination. Multiple shell calls can be pending at once because each run is correlated by `shellRunId`.

### 11. **MCP Tool Annotations Are Hints, Not Scheduling Controls**

`GET /api/mcp/tools` includes conservative `annotations` for `ux_invoke_shell`:

- `readOnlyHint: false`
- `destructiveHint: true`
- `idempotentHint: false`
- `openWorldHint: true`

MCP does not define a standard `parallelizable` flag. The shell tool description states that independent shell calls may be invoked concurrently, and the tool descriptor includes `_meta["acpui/concurrentInvocationsSupported"] = true` for AcpUI-aware clients. The stdio proxy preserves `title`, `annotations`, `execution`, `outputSchema`, and `_meta` when registering tools.

### 12. **Tool Output Streaming Happens Outside Tool Call**

Shell output is not streamed through the HTTP response body. It is sent through Socket.IO terminal events, and the HTTP response carries only the final MCP content array.

### 13. **The Proxy Is Stateless**

Every tool call includes `providerId` and `proxyId`. The proxy doesn't store state. If you need to track state across tool calls, use backend state keyed by proxy/session/run id.

---

## Unit Tests

### Backend Tests

- **`backend/test/mcpServer.test.js`** — Tests tool handlers:
  - `getMcpServers returns server config`
  - `ux_invoke_shell` interactive path via `shellRunManager`
  - MCP call remains pending until PTY resolves
  - Tool handler signatures and result format

- **`backend/test/mcpApi.test.js`** — Tests HTTP routes:
  - `GET /tools returns correct schema`
  - Shell schema advertises interactive terminal behavior
  - `POST /tool-call routes to correct handler`
  - Proxy context is forwarded to handlers
  - Error handling

- **`backend/test/mcpProxyRegistry.test.js`** — Tests proxy id creation, binding, lookup, and expiration.
- **`backend/test/shellRunManager.test.js`** — Tests interactive shell lifecycle, output formatting, Ctrl+C, hard kill, timeout, and snapshots.

---

## Summary

The AcpUI MCP server is a clean two-process design:

1. **Proxy (stdio-proxy.js):** Thin, stateless, generic. Fetches schemas, registers tools, forwards calls.
2. **Backend (mcpServer.js + mcpApi.js):** All intelligence. Tool logic, sockets, orchestration.

**The critical contract:** Tool schemas (mcpApi.js) and handlers (mcpServer.js) must be manually kept in sync. No code links them.

**The key gotcha:** Two different `getMcpServers` functions exist — one in `sessionManager.js` (for user sessions via socket handlers) and one in `mcpServer.js` (for sub-agent sessions inside tool handlers). Both include `ACP_SESSION_PROVIDER_ID` and `ACP_UI_MCP_PROXY_ID`. They must stay aligned or proxy resolution will break for one of the two paths.

**Why it matters:** This architecture allows agents to have powerful, extensible tools (shell, sub-agents, counsel) without bloating the proxy. Tools can emit live updates, spawn long-running processes, and orchestrate complex workflows — all while the proxy remains a simple passthrough.

**Adding a tool requires:**
1. Add handler to `mcpServer.js:createToolHandlers()`
2. Add schema to `mcpApi.js:GET /tools`
3. Add tests
4. Verify no lint errors and tests pass
## Tool Invocation State Integration

AcpUI MCP handlers are authoritative for their own tool arguments. When a handler receives
provider/session/tool-call metadata, it upserts canonical tool metadata into
`backend/services/tools/toolCallState.js`.

For example, `ux_invoke_shell` stores:

```javascript
{
  identity: {
    kind: "acpui_mcp",
    canonicalName: "ux_invoke_shell",
    mcpServer,
    mcpToolName: "ux_invoke_shell"
  },
  input: { description, command, cwd },
  display: {
    title: "Invoke Shell: <description>",
    titleSource: "mcp_handler"
  }
}
```

The ACP stream may report the `tool_call` before or after the MCP handler runs. Both paths
merge through the same tool state cache, keyed by provider id, ACP session id, and tool call
id when available. This prevents the ACP update handler from scraping shell descriptions,
commands, or sub-agent identity from provider display titles.

Future AcpUI UX MCP tools should:

1. Add the MCP schema in `backend/routes/mcpApi.js`.
2. Add the handler in `backend/mcp/mcpServer.js`.
3. Upsert authoritative tool metadata into `toolCallState` when request metadata includes a
   tool call id.
4. Add a backend tool registry handler for UX-specific lifecycle behavior.
5. Add provider `extractToolInvocation` fixtures only for providers whose raw ACP stream
   needs provider-owned parsing.
