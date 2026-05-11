# Feature Doc — Claude Provider

## Overview

Claude is implemented via `claude-agent-acp`, the ACP daemon from the `@agentclientprotocol/claude-agent-acp` npm package. This document is a **sidecar supplement** to `[Feature Doc] - Provider System.md` and assumes you understand the provider contract. It exists solely to show how Claude specifically implements or deviates from that contract, with real code, line numbers, and Claude-specific terminology.

**Load this doc alongside `[Feature Doc] - Provider System.md` when working on the Claude provider.** This doc makes no sense in isolation.

---

## What Claude Implements

Claude implements all required provider contract functions:

- **intercept()** — Transforms `config_option_update` and `available_commands_update` messages into Claude-specific extension events
- **normalizeUpdate()** — Passes updates through unchanged
- **extractToolOutput()** — Multi-stage lookup for tool output in various Claude data shapes
- **extractFilePath()** — 5-step detection for file paths in tool metadata
- **extractDiffFromToolCall()** — Extracts unified diffs from tool output
- **extractToolInvocation()** — **V2 Tool Routing**: Extracts canonical identity and arguments using `toolIdPattern`
- **normalizeTool()** — Strips MCP prefix using pattern and applies tool name aliases
- **categorizeToolCall()** — Maps Claude's tool names to UI categories
- **parseExtension()** — Routes Claude's `_anthropic/` protocol extensions
- **prepareAcpEnvironment()** — **Unique to Claude**: Starts the quota proxy and injects `ANTHROPIC_BASE_URL`
- **onPromptStarted() / onPromptCompleted()** — Explicit no-op lifecycle hooks required by the provider contract (Claude quota capture is proxy/header driven, not timer/prompt driven)
- **emitCachedContext()** — Replays persisted context usage when the backend loads or hot-resumes a session
- **performHandshake()** — Single `initialize` call (no auth pairing)
- **setConfigOption()** — Routes to three different ACP methods based on optionId
- **buildSessionParams()** — Always injects `disallowedTools`; optionally adds agent name
- **setInitialAgent()** — Intentional no-op (agent applied at spawn time)
- **getHooksForAgent()** — Reads Claude's `settings.json` hook map
- **Session file operations** — `getSessionPaths()`, `cloneSession()`, `archiveSessionFiles()`, `restoreSessionFiles()`
- **parseSessionHistory()** — Reconstructs Unified Timeline from Claude's JSONL format

### Claude-Unique Characteristics

| Aspect | Claude | General Pattern |
|--------|--------|-----------------|
| **Quota Capture** | Local HTTP proxy intercepts Anthropic headers | Varies by provider |
| **Session Layout** | Project-scoped subdirectories `~/.claude/projects/{cwd}/` | Varies; may be flat |
| **Tool ID Pattern** | `mcp__AcpUI__toolName` (DOUBLE underscore) | Varies by MCP registration |
| **Agent Switching** | Spawn-time only via `_meta`; no post-spawn changes | Varies |
| **Session Metadata** | JSONL mixes real user messages with internal entries; no clean flag | Varies |

---

## How Claude Starts — Startup Flow

### Step 1: prepareAcpEnvironment()

**File:** `providers/claude/index.js` (Lines 355–384)

Before Claude Code is spawned, the provider's `prepareAcpEnvironment()` is called. Claude uses this phase to start a local HTTP proxy:

```javascript
// FILE: providers/claude/index.js (Lines 355-384)
export async function prepareAcpEnvironment(env, context = {}) {
  if (env.CLAUDE_QUOTA_PROXY === 'false' || env.CLAUDE_QUOTA_PROXY_ENABLED === 'false') {
    return env;  // LINE 356-357: Can disable proxy entirely
  }

  const { config } = getProvider();
  let proxy;
  try {
    proxy = await startClaudeQuotaProxy({  // LINE 363: Start the HTTP proxy
      env,
      log: context.writeLog || (() => {}),
      onQuota: quotaData => {
        context.emitProviderExtension?.(
          `${config.protocolPrefix}provider/status`,
          { status: buildClaudeProviderStatus(quotaData) }
        );  // LINE 367-369: Emit quota status via extension
      }
    });
  } catch (err) {
    context.writeLog?.(`[CLAUDE QUOTA] Proxy startup failed: ${err?.message}`);
    return env;  // LINE 374: Gracefully degrade if proxy fails
  }

  context.writeLog?.(`[CLAUDE QUOTA] Injecting ANTHROPIC_BASE_URL=${proxy.baseUrl}`);

  const nextEnv = {
    ...env,
    ANTHROPIC_BASE_URL: proxy.baseUrl  // LINE 381: Inject proxy URL into child process env
  };
  return nextEnv;
}
```

**Key:** Returns the modified environment with `ANTHROPIC_BASE_URL` pointing to the local proxy.

### Step 2: Daemon Spawn & Quota Proxy

**File:** `providers/claude/quotaProxy.js` (Lines 20–65)

The proxy is a singleton HTTP server:

```javascript
// FILE: providers/claude/quotaProxy.js (Lines 20-65)
export async function startClaudeQuotaProxy({ env = process.env, log = () => {}, onQuota = () => {} } = {}) {
  const target = resolveTarget(env);  // LINE 21: Resolve Anthropic target URL

  if (proxyState?.server?.listening) {  // LINE 23: Reuse if already running
    proxyState.onQuota = onQuota;
    proxyState.log = log;
    return { baseUrl: proxyState.baseUrl, target: proxyState.target.href, latestQuota: proxyState.latestQuota };
  }

  const state = {  // LINE 33-40: Initialize proxy state
    server: null,
    baseUrl: null,
    target,
    latestQuota: null,
    onQuota,
    log
  };

  state.server = http.createServer((request, response) => {
    proxyRequest(state, request, response);  // LINE 43: Route every request through proxyRequest()
  });

  proxyState = state;

  await new Promise((resolve, reject) => {
    state.server.once('error', reject);
    state.server.listen(0, '127.0.0.1', () => {  // LINE 50: Listen on loopback, let OS pick port
      state.server.off('error', reject);
      const address = state.server.address();
      state.baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });

  log(`[CLAUDE QUOTA] Proxy listening at ${state.baseUrl}, forwarding to ${target.origin}`);
  // LINE 58: Log startup for debugging

  return { baseUrl: state.baseUrl, target: target.href, latestQuota: state.latestQuota };
}
```

**Why a proxy?** Claude Code makes API calls to Anthropic inside the spawned subprocess. Those requests include rate-limit headers in the response, but JSON-RPC doesn't carry HTTP response metadata. The proxy intercepts the requests, captures the headers, and emits them back via the `onQuota` callback.

### Step 3: performHandshake()

**File:** `providers/claude/index.js` (Lines 918–925)

Once the subprocess is running, the provider performs ACP handshake:

```javascript
// FILE: providers/claude/index.js (Lines 918-925)
export async function performHandshake(acpClient) {
  const { config } = getProvider();
  await acpClient.transport.sendRequest('initialize', {  // LINE 920: Single initialize call
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: config.clientInfo || { name: 'ACP-UI', version: '1.0.0' }  // LINE 923: From provider.json
  });
}
```

**Key:** Claude's handshake is a simple `initialize` request — no paired auth or session setup. The agent context (if any) was already applied at spawn time via `_meta.claudeCode.options.agent`.

---

## Configuration Files

### provider.json

**File:** `providers/claude/provider.json` (Complete)

```json
{
    "name": "Claude",
    "protocolPrefix": "_anthropic/",
    "mcpName": "AcpUI",
    "defaultSystemAgentName": "auto",
    "supportsAgentSwitching": false,
    "cliManagedHooks": [],
    "toolIdPattern": "mcp__{mcpName}__{toolName}",
    "toolCategories": {
        "read":  { "category": "file_read",  "isFileOperation": true },
        "edit":  { "category": "file_edit",  "isFileOperation": true },
        "write": { "category": "file_write", "isFileOperation": true },
        "glob":  { "category": "glob",       "isFileOperation": true },
        "grep":  { "category": "grep" }
    },
    "clientInfo": {
        "name": "claude-code",
        "version": "2.1.114"
    }
}
```

**Critical fields:**
- **`protocolPrefix: "_anthropic/"`** — All Claude extensions use this prefix (e.g., `_anthropic/config_options`, `_anthropic/provider/status`)
- **`toolIdPattern: "mcp__{mcpName}__{toolName}"`** — **DOUBLE underscore**. Becomes `mcp__AcpUI__ux_invoke_shell`, etc. This is critical for normalizeTool() detection.
- **`toolCategories`** — Uses SHORT tool names (`read`, `edit`, `write`), not the aliased names (`read_file`, etc.). The provider's normalizeTool() renames them.
- **`supportsAgentSwitching: false`** — Agent is applied at spawn time only; cannot be changed post-creation.

### branding.json

**File:** `providers/claude/branding.json` (Complete)

```json
{
    "title": "Claude",
    "assistantName": "Claude",
    "busyText": "Claude is thinking...",
    "hooksText": "⚙ Cleaning up...",
    "warmingUpText": "Claude warming up...",
    "resumingText": "Resuming...",
    "inputPlaceholder": "Send a message...",
    "emptyChatMessage": "Send a message to start chatting with Claude.",
    "notificationTitle": "Claude",
    "appHeader": "Claude",
    "sessionLabel": "Claude Session",
    "modelLabel": "Claude model"
}
```

### user.json (Example)

Claude's local config comes from `~/.claude/settings.json` (hooks, agents, workspace settings). AcpUI's local provider config can override `provider.json` via `user.json`:

```json
{
    "command": "claude-agent-acp",
    "args": [],
    "paths": {
        "sessions": "~/.claude/projects",
        "agents": "~/.claude/agents",
        "attachments": "~/.claude/attachments"
    },
    "models": {
        "default": "claude-3-5-sonnet-20241022"
    }
}
```

**Note:** `paths.sessions` is `~/.claude/projects`, which is a **directory of subdirectories** (one per project/workspace). This is critical for `findSessionDir()`.

---

## The Quota Proxy (Claude-Unique Feature)

### Why It Exists

Claude Code runs as a subprocess and makes API calls to Anthropic directly. Those calls include rate-limit headers in the HTTP response:
- `anthropic-ratelimit-unified-5h-utilization`
- `anthropic-ratelimit-unified-5h-reset`
- `anthropic-ratelimit-unified-7d-utilization`
- etc.

These headers are NOT part of the JSON-RPC stream; they're HTTP-level metadata. The proxy intercepts the requests, captures the headers, and emits them back to AcpUI so the frontend can show quota status.

### How It Works

**Files:** `providers/claude/quotaProxy.js` (Lines 20–168), `providers/claude/index.js` (Lines 355–384, 390–456)

1. `prepareAcpEnvironment()` calls `startClaudeQuotaProxy()` (Line 363 in index.js)
2. The proxy listens on `127.0.0.1:0` (random port)
3. The proxy URL is injected as `ANTHROPIC_BASE_URL` into the Claude Code subprocess
4. Claude Code makes all Anthropic API calls through the proxy
5. `proxyRequest()` forwards the request and captures the response headers (Lines 119–168 in quotaProxy.js)
6. `extractClaudeQuotaHeaders()` parses the `anthropic-ratelimit-*` headers (Lines 78–117 in quotaProxy.js)
7. The parsed quota data is passed to `onQuota` callback, which emits `_anthropic/provider/status` extension
8. The frontend receives the extension and renders quota status

### Extracting Quota Headers

**File:** `providers/claude/quotaProxy.js` (Lines 78–117)

```javascript
// FILE: providers/claude/quotaProxy.js (Lines 78-117)
export function extractClaudeQuotaHeaders(headers, { url, status } = {}) {
  const raw = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lowerKey = key.toLowerCase();
    if (!lowerKey.startsWith('anthropic-ratelimit-')) continue;  // LINE 82: Filter for quota headers
    raw[lowerKey] = Array.isArray(value) ? value.join(', ') : String(value);
  }

  if (Object.keys(raw).length === 0) return null;  // LINE 86: No quota headers = return null

  const fiveHourReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-5h-reset');
  const sevenDayReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-7d-reset');
  const overageReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-overage-reset');
  const unifiedReset = parseResetSeconds(headers, 'anthropic-ratelimit-unified-reset');

  return {  // LINE 93: Return structured quota data
    source: 'acpui-claude-provider-proxy',
    captured_at: new Date().toISOString(),
    ...(url ? { url } : {}),
    ...(status ? { status } : {}),
    '5h_utilization': parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-5h-utilization')),
    '5h_status': headerValue(headers, 'anthropic-ratelimit-unified-5h-status'),
    '5h_reset': fiveHourReset,
    '5h_resets_at': resetSecondsToIso(fiveHourReset),
    '7d_utilization': parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-7d-utilization')),
    '7d_status': headerValue(headers, 'anthropic-ratelimit-unified-7d-status'),
    '7d_reset': sevenDayReset,
    '7d_resets_at': resetSecondsToIso(sevenDayReset),
    overage_utilization: parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-overage-utilization')),
    overage_status: headerValue(headers, 'anthropic-ratelimit-unified-overage-status'),
    overage_reset: overageReset,
    overage_resets_at: resetSecondsToIso(overageReset),
    fallback_percentage: parseNumber(headerValue(headers, 'anthropic-ratelimit-unified-fallback-percentage')),
    representative_claim: headerValue(headers, 'anthropic-ratelimit-unified-representative-claim'),
    unified_status: headerValue(headers, 'anthropic-ratelimit-unified-status'),
    unified_reset: unifiedReset,
    unified_resets_at: resetSecondsToIso(unifiedReset),
    raw  // LINE 115: Include raw headers for advanced UI display
  };
}
```

### Formatting for the UI

**File:** `providers/claude/index.js` (Lines 390–456)

The quota data is transformed into the provider status shape via `buildClaudeProviderStatus()`:

```javascript
// FILE: providers/claude/index.js (Lines 390-456, abbreviated)
export function buildClaudeProviderStatus(quotaData) {
  const fiveHourItem = buildQuotaItem('five-hour', '5h', quotaData['5h_utilization'], quotaData['5h_status'], quotaData['5h_resets_at']);
  const sevenDayItem = buildQuotaItem('seven-day', '7d', quotaData['7d_utilization'], quotaData['7d_status'], quotaData['7d_resets_at']);
  const overageItem = buildQuotaItem('overage', 'Overage', quotaData.overage_utilization, quotaData.overage_status, quotaData.overage_resets_at);
  
  const limitItems = [fiveHourItem, sevenDayItem, overageItem].filter(Boolean);
  
  // LINE 427-439: Gather additional details (unified status, claim, fallback, etc.)
  const details = [];
  if (quotaData.unified_status) {
    details.push({
      id: 'unified-status',
      label: 'Unified status',
      value: capitalizeWords(String(quotaData.unified_status).replace(/_/g, ' ')),
      tone: quotaData.unified_status === 'allowed' ? 'success' : 'warning'
    });
  }
  // ... more details ...
  
  return {  // LINE 441-455: Render-ready structure
    providerId: 'claude',
    title: 'Claude',
    updatedAt: quotaData.captured_at,
    summary: {
      title: 'Usage',
      items: summaryItems
    },
    sections: [
      { id: 'limits', title: 'Usage Windows', items: limitItems },
      ...(details.length > 0 ? [{ id: 'details', title: 'Details', items: details }] : []),
      // ... more sections ...
    ]
  };
}
```

### Configuration

- **Disable:** `CLAUDE_QUOTA_PROXY=false`
- **Custom target:** `CLAUDE_QUOTA_PROXY_TARGET=https://api.anthropic.com` (override the default)

---

## intercept() — Claude's Message Transforms

Claude intercepts two specific message types and rewrites them into extension events.

### Transform 1: config_option_update

**File:** `providers/claude/index.js` (Lines 14–41)

```javascript
// FILE: providers/claude/index.js (Lines 14-41)
if (
  payload.method === 'session/update' &&
  payload.params?.update?.sessionUpdate === 'config_option_update' &&
  payload.params?.update?.configOptions
) {
  const { config } = getProvider();
  
  // LINE 24-26: Filter out 'model' and remap 'effort' to 'reasoning_effort'
  const options = payload.params.update.configOptions
    .filter(o => o.id !== 'model')  // Remove model — AcpUI has its own model UI
    .map(o => o.id === 'effort' ? { ...o, kind: 'reasoning_effort' } : o);

  // LINE 28-30: If no options left, return null to suppress the message
  if (options.length === 0) return null;

  return {  // LINE 33-40: Emit as _anthropic/config_options extension
    method: `${config.protocolPrefix}config_options`,
    params: {
      sessionId: payload.params.sessionId,
      options,
      replace: true
    }
  };
}
```

**Why filter 'model'?** Claude sends `model` in config options, but AcpUI has a dedicated model selector UI (`setConfigOption()` routes it to `session/set_model`). The config_option_update must not duplicate this.

**Why remap 'effort' to 'reasoning_effort'?** The UI expects `kind: 'reasoning_effort'` (Claude's native name). The daemon sends `id: 'effort'`, so we rename it.

### Transform 2: available_commands_update

**File:** `providers/claude/index.js` (Lines 43–64)

```javascript
// FILE: providers/claude/index.js (Lines 43-64)
if (
  payload.method === 'session/update' &&
  payload.params?.update?.sessionUpdate === 'available_commands_update' &&
  payload.params?.update?.availableCommands
) {
  const { config } = getProvider();
  
  const commands = payload.params.update.availableCommands.map(cmd => ({
    name: cmd.name.startsWith('/') ? cmd.name : `/${cmd.name}`,  // LINE 54: Prepend '/'
    description: cmd.description,
    ...(cmd.input?.hint ? { meta: { hint: cmd.input.hint } } : {}),  // LINE 56: Map hint for UI
  }));
  
  return {  // LINE 59: Emit as _anthropic/commands/available extension
    id: payload.id,
    method: `${config.protocolPrefix}commands/available`,
    params: { commands }
  };
}
```

**Why prepend '/'?** Claude Code ACP omits the slash from command names (e.g., `"compact"`), but the UI expects `/compact`.

---

## Tool Pipeline — How Claude Tools Are Normalized

Claude's tool handling uses the V2 Tool Invocation system, which separates display normalization from canonical identity resolution.

### 1. V2 Tool Invocation Routing

**File:** `providers/claude/index.js` (Lines 406–445)

Claude implements `extractToolInvocation()` to provide authoritative metadata for the backend tool registry. It uses `toolIdPattern` from `provider.json` to resolve the canonical tool name.

```javascript
export function extractToolInvocation(update = {}, context = {}) {
  const event = context.event || {};
  const { config } = getProvider();
  const input = mergeInputObjects(collectInputObjects(
    update.rawInput,
    update.arguments,
    update.params,
    update.input,
    update.toolCall?.arguments
  ));

  // Match the raw MCP tool id against the pattern to resolve canonical identity.
  const rawId = update.title || update.kind || update?._meta?.claudeCode?.toolName || event.title || '';
  const patternMatch = matchToolIdPattern(rawId, config);
  const canonicalName = patternMatch?.toolName || event.toolName || '';

  return {
    toolCallId: update.toolCallId || event.id,
    kind: patternMatch ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
    rawName: update.kind || update?._meta?.claudeCode?.toolName || rawId || event.toolName || '',
    canonicalName,
    mcpServer: patternMatch?.mcpName,
    mcpToolName: patternMatch?.toolName,
    input,
    title: event.title || update.title || '',
    filePath: event.filePath,
    category: categorizeToolCall({ ...event, toolName: canonicalName }) || {}
  };
}
```

### 2. Tool ID Pattern Detection

**File:** `providers/claude/index.js` (Lines 336–341)

Claude's tools come through with identifiers matching the pattern `mcp__{mcpName}__{toolName}` (note the **DOUBLE underscore**). `normalizeTool()` uses `matchToolIdPattern` to strip this prefix for display:

```javascript
// FILE: providers/claude/index.js (Lines 336-341)
const targetString = event.title || '';
const titlePatternMatch = matchToolIdPattern(targetString, config);
const kindPatternMatch = !titlePatternMatch ? matchToolIdPattern(toolName, config) : null;
const patternMatch = titlePatternMatch || kindPatternMatch;

if (patternMatch?.toolName) toolName = patternMatch.toolName;
```

**Critical:** The `toolIdPattern` in `provider.json` is the source of truth. For Claude, this is `mcp__{mcpName}__{toolName}`.

### 3. Tool Name Aliases

**File:** `providers/claude/index.js` (Lines 246–249)

Claude's native tool names are short (`read`, `write`, `edit`). The provider aliases them to longer names for consistency:

```javascript
// FILE: providers/claude/index.js (Lines 246-249)
if (toolName === 'read') toolName = 'read_file';
if (toolName === 'write') toolName = 'write_file';
if (toolName === 'edit') toolName = 'edit_file';
```

**Important:** `toolCategories` in `provider.json` uses the SHORT names (`read`, `edit`, `write`). The aliases are applied in normalizeTool(), but categorizeToolCall() expects the short names.

### 3. UX Tool Name Mapping

**File:** `providers/claude/index.js` (Line 261)

For custom AcpUI tools, use readable names:

```javascript
// FILE: providers/claude/index.js (Line 261)
const UX_TOOL_TITLES = {
  ux_invoke_shell: 'Invoke Shell',
  ux_invoke_subagents: 'Invoke Subagents',
  ux_invoke_counsel: 'Invoke Counsel'
};
```

### 4. Title Construction with Arguments

**File:** `providers/claude/index.js` (Lines 265–294)

For better visibility, the tool's filename or pattern is appended to the title:

```javascript
// FILE: providers/claude/index.js (Lines 265-294, abbreviated)
let argsStr = '';
let argsObj = update?.rawInput || update?.arguments || update?.params;

if (typeof argsObj === 'string') {
  // LINE 270-273: Try regex extraction from streaming JSON
  const pathMatch = argsObj.match(/"(?:file_)?path"\s*:\s*"([^"]+)"/);
  if (pathMatch && pathMatch[1]) {
    argsStr = path.basename(pathMatch[1]);
  } else {
    try {
      argsObj = JSON.parse(argsObj);  // LINE 275: Parse if JSON
    } catch {
      argsObj = null;
    }
  }
}

if (argsObj && typeof argsObj === 'object') {
  if (argsObj.file_path) argsStr = path.basename(argsObj.file_path);
  else if (argsObj.path) argsStr = path.basename(argsObj.path);
  else if (argsObj.pattern) argsStr = argsObj.pattern;
}

// LINE 289-293: Append to title for visibility
if (argsStr && title && !title.toLowerCase().includes(argsStr.toLowerCase())) {
  title += `: ${argsStr}`;
}
```

### 5. Categorization

**File:** `providers/claude/index.js` (Lines 302–320)

```javascript
// FILE: providers/claude/index.js (Lines 302-320)
export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  const metadata = (config.toolCategories || {})[toolName];  // LINE 308: Look up in provider.json
  if (!metadata) return null;

  const result = {
    toolCategory: metadata.category,  // e.g., "file_read", "file_edit", "glob"
    isFileOperation: metadata.isFileOperation || false,
  };
  return result;
}
```

**Note:** This looks up the SHORT tool name (`read`, not `read_file`). The alias must be reversed or toolCategories must use the short name.

---

## extractToolOutput() — Real-Time Streaming

Claude sends tool output in multiple places as the tool executes. The provider performs a multi-stage lookup:

**File:** `providers/claude/index.js` (Lines 79–135)

```javascript
// FILE: providers/claude/index.js (Lines 79-135, abbreviated)
export function extractToolOutput(update) {
  // STAGE 1: Real-time streaming of write/edit content (Lines 82-98)
  if (update.rawInput && update.sessionUpdate === 'tool_call_update' && update.status !== 'completed') {
    let argsObj = null;
    if (typeof update.rawInput === 'string') {
      try {
        argsObj = JSON.parse(update.rawInput);
      } catch {}
    } else {
      argsObj = update.rawInput;
    }
    
    if (argsObj) {
      if (argsObj.content) return argsObj.content;  // write/edit content being streamed
      if (argsObj.newStr) return argsObj.newStr;    // str_replace newStr
    }
  }

  // STAGE 2: Check rawOutput or content array (Lines 100-104)
  let outputArray = update.rawOutput || update.content;
  if ((!outputArray || (Array.isArray(outputArray) && outputArray.length === 0)) && 
      update._meta?.claudeCode?.toolResponse) {
    // STAGE 3: Fallback to _meta.claudeCode.toolResponse
    const toolResponse = extractClaudeToolResponse(update._meta.claudeCode.toolResponse);
    if (toolResponse) return toolResponse;
  }

  // STAGE 4: String output with "successfully" filter (Lines 106-119)
  if (typeof outputArray === 'string') {
    if (update.content && Array.isArray(update.content) && update.content.length > 0) {
      outputArray = update.content;  // Prefer content array if available
    } else {
      const toolName = update._meta?.claudeCode?.toolName?.toLowerCase() || '';
      // Skip generic success messages for write/edit to preserve streaming code block
      if (/successfully/i.test(outputArray) && (toolName === 'write' || toolName === 'edit' || toolName === 'strreplace')) {
        return undefined;  // LINE 115: Don't output success message
      }
      return outputArray;
    }
  }

  // STAGE 5: Content array text extraction (Lines 121-132)
  if (outputArray && Array.isArray(outputArray)) {
    const result = outputArray
      .filter(c => c.type === 'text' || c.type === 'content')
      .map(c => {
        if (c.type === 'text') return c.text;
        if (c.type === 'content' && c.content?.type === 'text') return c.content.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
    return result || undefined;
  }
  
  return undefined;
}
```

### Helper: extractClaudeToolResponse

**File:** `providers/claude/index.js` (Lines 137–157)

Recursively extracts text from nested tool response structures:

```javascript
// FILE: providers/claude/index.js (Lines 137-157)
function extractClaudeToolResponse(toolResponse) {
  if (!toolResponse) return undefined;
  if (typeof toolResponse === 'string') return toolResponse;

  if (Array.isArray(toolResponse)) {
    const result = toolResponse
      .map(item => extractClaudeToolResponse(item))
      .filter(Boolean)
      .join('\n');
    return result || undefined;
  }

  if (typeof toolResponse.text === 'string') return toolResponse.text;
  if (typeof toolResponse.content === 'string') return toolResponse.content;
  if (toolResponse.file?.content) return toolResponse.file.content;
  if (Array.isArray(toolResponse.content)) return extractClaudeToolResponse(toolResponse.content);
  if (toolResponse.content && typeof toolResponse.content === 'object') 
    return extractClaudeToolResponse(toolResponse.content);
  if (Array.isArray(toolResponse.filenames)) return toolResponse.filenames.join('\n') || undefined;

  return undefined;
}
```

---

## extractFilePath() — File Path Detection

Claude embeds file paths in many places. The provider performs a 5-step lookup:

**File:** `providers/claude/index.js` (Lines 161–201)

```javascript
// FILE: providers/claude/index.js (Lines 161-201)
export function extractFilePath(update, resolvePath) {
  const title = (update.title || '').toLowerCase();

  // STEP 1: Noise filtering (Lines 164-165)
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  // STEP 2: Content array (Lines 167-173)
  if (update.content && Array.isArray(update.content)) {
    for (const item of update.content) {
      if (item.filePath) return resolvePath(item.filePath);
      if (item.path) return resolvePath(item.path);
    }
  }

  // STEP 3: _meta.claudeCode structure (Lines 175-176)
  const toolResponseFilePath = update._meta?.claudeCode?.toolResponse?.file?.filePath;
  if (typeof toolResponseFilePath === 'string') return resolvePath(toolResponseFilePath);

  // STEP 4: Locations array (Lines 178-183)
  if (update.locations && Array.isArray(update.locations)) {
    for (const loc of update.locations) {
      if (loc.path) return resolvePath(loc.path);
    }
  }

  // STEP 5: Regex extraction from arguments (Lines 185-200)
  let args = update.arguments || update.params || update.rawInput;
  if (typeof args === 'string') {
    // Handle streaming JSON: "path": "foo" or "file_path": "foo" or "target": "foo"
    const pathMatch = args.match(/"(?:file_)?path|target"\s*:\s*"([^"]*)"/i);
    if (pathMatch && pathMatch[1]) {
      return resolvePath(pathMatch[1]);
    }
  } else if (args) {
    const p = args.path || args.file_path || args.filePath || args.target;
    if (p && typeof p === 'string') return resolvePath(p);
  }

  return undefined;
}
```

---

## Session Files — Project-Scoped Layout

Claude stores sessions in **project-scoped subdirectories**, not flat. This is critical for understanding file operations.

### Layout

```
~/.claude/projects/
├── {encoded-cwd}/
│   ├── {sessionId}.jsonl
│   ├── {sessionId}.json
│   └── {sessionId}/
│       └── (task files)
├── {another-encoded-cwd}/
│   └── ...
```

**Example:** If you're working in `/home/user/my-project`, Claude stores sessions under `~/.claude/projects/{encoded-path-of-my-project}/`.

### findSessionDir()

**File:** `providers/claude/index.js` (Lines 573–590)

Locates the project subdirectory containing a session:

```javascript
// FILE: providers/claude/index.js (Lines 573-590)
function findSessionDir(sessionsRoot, acpId) {
  // FAST PATH: Flat layout (for other providers, or future changes)
  if (fs.existsSync(path.join(sessionsRoot, `${acpId}.jsonl`))) {  // LINE 575
    return sessionsRoot;
  }
  
  // SLOW PATH: Scan project subdirectories
  try {
    for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (fs.existsSync(path.join(sessionsRoot, entry.name, `${acpId}.jsonl`))) {
        return path.join(sessionsRoot, entry.name);  // LINE 583: Found it
      }
    }
  } catch (err) {
    // Directory doesn't exist or read error
  }
  
  return sessionsRoot;  // LINE 589: Fallback to root
}
```

**Key:** This function returns the directory containing the session files, not the files themselves.

### getSessionPaths()

**File:** `providers/claude/index.js` (Lines 592–600)

Returns absolute paths for all session files:

```javascript
// FILE: providers/claude/index.js (Lines 592-600)
export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const dir = findSessionDir(config.paths.sessions, acpId);  // LINE 594: Find the directory
  
  return {
    jsonl: path.join(dir, `${acpId}.jsonl`),
    json: path.join(dir, `${acpId}.json`),
    tasksDir: path.join(dir, acpId),
  };
}
```

### cloneSession()

**File:** `providers/claude/index.js` (Lines 602–663)

Clones a session (for forking) into the same project subdirectory:

```javascript
// FILE: providers/claude/index.js (Lines 602-663, abbreviated)
export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const { config } = getProvider();
  const sessionsRoot = config.paths.sessions;

  // LINE 609: Both old and new sessions belong to the same project (same cwd)
  const sessionDir = findSessionDir(sessionsRoot, oldAcpId);

  const oldJsonl   = path.join(sessionDir, `${oldAcpId}.jsonl`);
  const newJsonl   = path.join(sessionDir, `${newAcpId}.jsonl`);
  // ... copy .json and tasks dir ...

  if (fs.existsSync(oldJsonl)) {
    const lines = fs.readFileSync(oldJsonl, 'utf-8').split('\n').filter(l => l.trim());
    
    if (pruneAtTurn != null) {
      // LINE 620-645: Prune internal messages and count real user turns
      let userTurnCount = 0;
      let pruneAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'user') {
            let isInternal = entry.isMeta === true;  // LINE 627: Check isMeta flag
            
            // LINE 628-634: Check for internal message markers in content
            if (typeof entry.message?.content === 'string') {
              const content = entry.message.content;
              if (content.includes('<local-command-caveat>') ||
                  content.includes('<command-name>') ||
                  content.includes('<local-command-')) {
                isInternal = true;
              }
            }
            
            if (!isInternal) {
              userTurnCount++;
            }
          }
          if (userTurnCount > pruneAtTurn) {
            pruneAt = i;
            break;
          }
        } catch {}
      }
      
      // Write pruned JSONL with ID replacements
      fs.writeFileSync(
        newJsonl,
        lines.slice(0, pruneAt)
          .map(l => l.replaceAll(oldAcpId, newAcpId))
          .join('\n') + '\n',
        'utf-8'
      );
    } else {
      // No pruning — clone all lines
      const content = fs.readFileSync(oldJsonl, 'utf-8');
      fs.writeFileSync(newJsonl, content.replaceAll(oldAcpId, newAcpId), 'utf-8');
    }
  }
  
  // Copy .json metadata file
  if (fs.existsSync(oldJson)) {
    let json = fs.readFileSync(oldJson, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);
    fs.writeFileSync(newJson, json, 'utf-8');
  }
  
  // Copy tasks directory
  if (fs.existsSync(oldTasksDir)) {
    fs.cpSync(oldTasksDir, newTasksDir, { recursive: true });
  }
}
```

### archiveSessionFiles()

**File:** `providers/claude/index.js` (Lines 672–694)

Moves session files to an archive directory and saves the session's original directory path:

```javascript
// FILE: providers/claude/index.js (Lines 672-694)
export function archiveSessionFiles(acpId, archiveDir) {
  const { config } = getProvider();
  const paths = getSessionPaths(acpId);
  
  if (paths.jsonl && fs.existsSync(paths.jsonl)) {
    fs.copyFileSync(paths.jsonl, path.join(archiveDir, `${acpId}.jsonl`));
    fs.unlinkSync(paths.jsonl);
  }
  
  // ... copy .json and tasks ...
  
  // CRITICAL: Save the exact session directory for restore (Lines 687-693)
  const sessionDir = path.dirname(paths.jsonl);  // e.g., ~/.claude/projects/encoded-cwd/
  fs.writeFileSync(
    path.join(archiveDir, 'restore_meta.json'),
    JSON.stringify({ sessionDir }, null, 2)  // LINE 692: Absolute path
  );
}
```

**Why?** When the session is restored, it must go back into its original project subdirectory. Without this metadata, restore would place it in the root and it would become invisible to Claude Code.

### restoreSessionFiles()

**File:** `providers/claude/index.js` (Lines 834–867)

Restores archived sessions to their original project subdirectories:

```javascript
// FILE: providers/claude/index.js (Lines 834-867, abbreviated)
export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { config } = getProvider();
  const sessionsRoot = config.paths.sessions;

  // CRITICAL: Read the absolute path from restore_meta.json (Lines 841-850)
  let targetDir = sessionsRoot;
  const metaPath = path.join(archiveDir, 'restore_meta.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.sessionDir) {
        targetDir = meta.sessionDir;  // LINE 847: Use the saved absolute path
      }
    } catch { /* fall through */ }
  }

  if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });

  // Copy files into the exact directory
  const jsonlSrc = path.join(archiveDir, `${savedAcpId}.jsonl`);
  if (fs.existsSync(jsonlSrc)) {
    fs.copyFileSync(jsonlSrc, path.join(targetDir, `${savedAcpId}.jsonl`));
  }
  // ... restore .json and tasks ...
}
```

---

## Internal Message Detection

Claude's JSONL format uses `type: "user"` for **both** real user messages **and** internal entries like tool results and local command caveats. There is no clean metadata flag, so the provider detects internal messages by inspecting content.

### Detection Logic

**Used in:** `cloneSession()` (Lines 626–638) and `parseSessionHistory()` (Lines 710–720)

```javascript
// FILE: providers/claude/index.js (Lines 626-638, from cloneSession)
if (entry.type === 'user') {
  let isInternal = entry.isMeta === true;  // LINE 627: Check isMeta flag (may be absent)
  
  if (typeof entry.message?.content === 'string') {
    const content = entry.message.content;
    // LINE 630-633: Check for internal message markers
    if (content.includes('<local-command-caveat>') ||
        content.includes('<command-name>') ||
        content.includes('<local-command-')) {
      isInternal = true;
    }
  }
  
  if (!isInternal) {
    userTurnCount++;  // LINE 637: Count only real user turns
  }
}
```

**Internal message markers:**
- `<local-command-caveat>` — Caveat about local command execution
- `<command-name>` — Marker for command execution
- `<local-command-` — Various local command markers

---

## parseSessionHistory() — Unified Timeline from JSONL

Claude's JSONL is a sequence of `type: "user"` and `type: "assistant"` entries. The provider reconstructs AcpUI's Unified Timeline (alternating user + assistant messages with tool steps inside).

**File:** `providers/claude/index.js` (Lines 699–832)

```javascript
// FILE: providers/claude/index.js (Lines 699-832, abbreviated)
export async function parseSessionHistory(filePath, Diff) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));

    const messages = [];
    let currentAssistant = null;

    for (const entry of entries) {
      if (entry.type === 'user') {  // LINE 710: User message
        // LINE 711-735: Parse user content, check for internal markers
        let isInternal = entry.isMeta === true;
        let textContent = '';
        let toolResults = [];

        if (typeof entry.message?.content === 'string') {
          const content = entry.message.content;
          if (content.includes('<local-command-caveat>') ||
              content.includes('<command-name>') ||
              content.includes('<local-command-')) {
            isInternal = true;
          } else {
            textContent = content;
          }
        } else if (Array.isArray(entry.message?.content)) {
          for (const block of entry.message.content) {
            if (block.type === 'text') {
              textContent += block.text + '\n';
            } else if (block.type === 'tool_result') {
              toolResults.push(block);  // LINE 729: Collect tool results
            }
          }
        }

        // LINE 737-751: Match tool results back to tool steps
        if (toolResults.length > 0 && currentAssistant) {
          for (const res of toolResults) {
            const toolStep = currentAssistant.timeline.find(
              t => t.type === 'tool' && t.event.id === res.tool_use_id
            );
            if (toolStep) {
              toolStep.event.status = res.is_error ? 'failed' : 'completed';
              let outputText = '';
              if (typeof res.content === 'string') {
                outputText = res.content;
              } else if (Array.isArray(res.content)) {
                outputText = res.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
              }
              toolStep.event.output = outputText || undefined;
            }
          }
        }

        // LINE 753-759: Emit real user messages (skip internal)
        if (!isInternal && textContent.trim()) {
          if (currentAssistant) {
            messages.push(currentAssistant);
            currentAssistant = null;
          }
          messages.push({
            role: 'user',
            content: textContent.trim(),
            id: entry.uuid || entry.message?.id || Date.now().toString()
          });
        }

      } else if (entry.type === 'assistant') {  // LINE 760: Assistant message
        if (!currentAssistant) {
          currentAssistant = {
            role: 'assistant',
            content: '',
            id: entry.uuid || entry.message?.id || Date.now().toString(),
            isStreaming: false,
            timeline: []
          };
        }

        // LINE 771-807: Process assistant message blocks
        for (const block of entry.message?.content || []) {
          if (block.type === 'text') {
            if (currentAssistant.content) currentAssistant.content += '\n\n';
            currentAssistant.content += block.text;
          } else if (block.type === 'thinking') {
            // LINE 776: Add thinking as thought step
            currentAssistant.timeline.push({ type: 'thought', content: block.thinking });
          } else if (block.type === 'tool_use') {
            // LINE 778-791: Add tool step with fallback diff
            const inp = block.input || {};
            const titleArg = inp.path || inp.filePath || inp.file_path || inp.command || inp.pattern || inp.query || '';
            const title = titleArg ? `Running ${block.name}: ${titleArg}` : `Running ${block.name}`;

            let fallbackOutput = null;
            const isWrite = ['write', 'write_file', 'strReplace', 'str_replace', 'edit'].includes(block.name);
            
            // LINE 785-791: Generate diff as fallback for write/edit tools
            if (isWrite && inp.command === 'strReplace' && inp.newStr) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', inp.oldStr || '', inp.newStr, 'old', 'new');
            } else if (isWrite && inp.newStr && inp.oldStr) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', inp.oldStr, inp.newStr, 'old', 'new');
            } else if (isWrite && inp.content) {
              fallbackOutput = Diff.createPatch(inp.path || 'file', '', inp.content, 'old', 'new');
            }

            currentAssistant.timeline.push({
              type: 'tool',
              isCollapsed: true,
              event: {
                id: block.id,
                title,
                status: 'pending_result',
                output: null,
                _fallbackOutput: fallbackOutput,
                startTime: Date.now(),
                endTime: Date.now()
              }
            });
          }
        }
      }
    }

    // LINE 812-814: Flush final assistant message
    if (currentAssistant) {
      messages.push(currentAssistant);
    }

    // LINE 816-826: Apply fallback outputs for tools with no result
    for (const msg of messages) {
      for (const step of (msg.timeline || [])) {
        if (step.type === 'tool' && step.event) {
          if (!step.event.output && step.event._fallbackOutput) {
            step.event.output = step.event._fallbackOutput;
          }
          delete step.event._fallbackOutput;
        }
      }
    }

    return messages;
  } catch (err) {
    throw new Error(`Failed to parse ${filePath}: ${err.stack}`);
  }
}
```

---

## Agent Support — Spawn-Time Only

Claude agents are applied at subprocess spawn time via the `_meta` field and cannot be changed post-creation.

### buildSessionParams()

**File:** `providers/claude/index.js` (Lines 912–916)

```javascript
// FILE: providers/claude/index.js (Lines 912-916)
export function buildSessionParams(agent) {
  const options = { disallowedTools: ['Bash', 'PowerShell', 'Agent'] };  // LINE 913: Always injected
  if (agent) options.agent = agent;  // LINE 914: Add agent name if provided
  return { _meta: { claudeCode: { options } } };  // LINE 915: Return _meta structure
}
```

**Key:** This ALWAYS returns an object, even if agent is `null`. The `disallowedTools` are always present because:
- `Bash` and `PowerShell` are replaced by AcpUI's custom `ux_invoke_shell`
- `Agent` is not supported (agents are defined in Claude's CLI, not via ACP)

### setInitialAgent()

**File:** `providers/claude/index.js` (Lines 907–910)

```javascript
// FILE: providers/claude/index.js (Lines 907-910)
export async function setInitialAgent(acpClient, sessionId, agent) {
  // Agent is applied at subprocess spawn time via buildSessionMeta — nothing to do post-creation.
  return;
}
```

**Why a no-op?** Agent context is baked into the Claude Code subprocess at spawn time. Once it's running, you cannot change the agent. If you need a different agent, you must create a new session.

### The _meta Field

See `providers/claude/SESSION_META_DATA.md` for complete reference. Key structure:

```javascript
{
  _meta: {
    claudeCode: {
      options: {
        agent: "my-agent-name",           // Agent name from ~/.claude/agents/
        disallowedTools: ['Bash', ...]    // Tools to hide from Claude
      }
    },
    systemPrompt: { append: "..." },      // Optional system prompt additions
    additionalRoots: ["C:/path"]          // Additional context directories
  }
}
```

---

## setConfigOption() — Three Routing Rules

Claude has three different ACP methods for setting configuration, depending on the option type:

**File:** `providers/claude/index.js` (Lines 523–561)

```javascript
// FILE: providers/claude/index.js (Lines 523-561)
export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'mode') {
    // LINE 530-533: Mode uses session/set_mode
    return acpClient.transport.sendRequest('session/set_mode', {
      sessionId,
      modeId: value
    });
  }

  if (optionId === 'model') {
    // LINE 537-540: Model uses session/set_model
    return acpClient.transport.sendRequest('session/set_model', {
      sessionId,
      modelId: value
    });
  }

  // LINE 544-548: Effort and other dynamic options use set_config_option
  const result = await acpClient.transport.sendRequest('session/set_config_option', {
    sessionId,
    configId: optionId,
    value: value
  });
  
  // LINE 549: Normalize result (filter model, remap effort)
  return normalizeClaudeConfigResult(result);
}

// LINE 552-561: Filter and remap results
function normalizeClaudeConfigResult(result) {
  if (!Array.isArray(result?.configOptions)) return result;

  return {
    ...result,
    configOptions: result.configOptions
      .filter(option => option?.id !== 'model')  // Remove 'model' — AcpUI has its own model UI
      .map(option => 
        option.id === 'effort' 
          ? { ...option, kind: 'reasoning_effort' }  // Remap 'effort' to expected kind
          : option
      )
  };
}
```

---

## Hooks — settings.json Hook Map

Claude's hooks come from `~/.claude/settings.json`, not from agent YAML files. The provider maps AcpUI hook types to Claude's PascalCase conventions.

### Hook Type Mapping

**File:** `providers/claude/index.js` (Lines 884–905)

```javascript
// FILE: providers/claude/index.js (Lines 884-889)
const CLAUDE_HOOK_MAP = {
  session_start: 'SessionStart',    // Runs at session creation
  pre_tool: 'PreToolUse',            // Runs before tool execution
  post_tool: 'PostToolUse',          // Runs after tool completes
  stop: 'Stop',                      // Runs when session stops
};

// FILE: providers/claude/index.js (Lines 891-905)
export async function getHooksForAgent(_agentName, hookType) {
  const nativeKey = CLAUDE_HOOK_MAP[hookType];
  if (!nativeKey) return [];  // LINE 893: Unknown hook type
  
  const { config } = getProvider();
  const settingsPath = path.join(
    path.dirname(config.paths.agents),  // Parent of ~/.claude/agents/
    'settings.json'                      // Read ~/.claude/settings.json
  );
  
  try {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    const entries = settings?.hooks?.[nativeKey] ?? [];  // LINE 898: e.g., hooks.SessionStart
    
    // LINE 899-901: Extract commands from hook entries
    return entries.flatMap(entry =>
      (entry.hooks ?? []).map(h => ({
        command: h.command,
        ...(entry.matcher ? { matcher: entry.matcher } : {})
      }))
    ).filter(e => e?.command);
  } catch {
    return [];  // No settings file or parse error
  }
}
```

### settings.json Structure

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": { "projectPath": "/path/to/project" },
        "hooks": [
          { "command": "echo 'Session started'" }
        ]
      }
    ],
    "PreToolUse": [
      {
        "hooks": [
          { "command": "echo 'About to run a tool'" }
        ]
      }
    ]
  }
}
```

---

## Extension Methods (_anthropic/ prefix)

Claude emits custom protocol events prefixed with `_anthropic/`. The provider's `parseExtension()` routes these:

**File:** `providers/claude/index.js` (Lines 324–353)

```javascript
// FILE: providers/claude/index.js (Lines 324-353)
export function parseExtension(method, params) {
  const { config } = getProvider();
  if (!method.startsWith(config.protocolPrefix)) return null;  // LINE 327: Must start with "_anthropic/"

  const type = method.slice(config.protocolPrefix.length);
  let result = null;

  switch (type) {
    case 'commands/available':  // LINE 333: Slash commands
      result = { type: 'commands', commands: params.commands };
      break;
    case 'metadata':  // LINE 336: Context usage
      result = { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
      break;
    case 'compaction/status':  // LINE 339: Session compaction state
      result = { type: 'compaction', sessionId: params.sessionId, status: params.status, summary: params.summary };
      break;
    case 'provider/status':  // LINE 342: Quota status (from quota proxy)
      result = { type: 'provider_status', status: params.status };
      break;
    case 'config_options':  // LINE 345: Dynamic options (effort, mode)
      result = { type: 'config_options', sessionId: params.sessionId, options: params.options };
      break;
    default:
      result = { type: 'unknown', method, params };  // LINE 349: Unknown extension
  }
  
  return result;  // LINE 352: Return normalized form
}
```

---

## Component Reference

### providers/claude/index.js

| Lines | Function | Purpose |
|-------|----------|---------|
| 14–41 | intercept() | Transform config_option_update and available_commands_update |
| 43–64 | intercept() continuation | Available commands normalization |
| 80–135 | extractToolOutput() | Multi-stage tool output lookup |
| 137–157 | extractClaudeToolResponse() helper | Recursive response parsing |
| 162–201 | extractFilePath() | 5-step file path detection |
| 206–221 | extractDiffFromToolCall() | Diff extraction |
| 406–445 | extractToolInvocation() | V2 canonical tool identity extraction |
| 226–297 | normalizeTool() | Tool normalization and title construction |
| 232–237 | mcpPrefix detection | Strip `mcp__AcpUI__` prefix |
| 246–249 | Tool name aliases | 'read' → 'read_file', etc. |
| 261 | UX_TOOL_TITLES | Map UX tool names to readable titles |
| 302–320 | categorizeToolCall() | Tool categorization using provider.json |
| 324–353 | parseExtension() | Route _anthropic/ extensions |
| – | emitCachedContext() | Replay cached `_anthropic/metadata` context usage after session load or hot-resume |
| 355–384 | prepareAcpEnvironment() | Quota proxy startup + ANTHROPIC_BASE_URL injection |
| 1071–1076 | onPromptStarted() / onPromptCompleted() | Required prompt lifecycle hook exports (intentional no-op for Claude) |
| 386–388 | getQuotaState() | Return latest quota data |
| 390–456 | buildClaudeProviderStatus() | Format quota for UI |
| 523–561 | setConfigOption() | Route mode/model/effort to ACP methods |
| 552–561 | normalizeClaudeConfigResult() | Filter model, remap effort |
| 573–590 | findSessionDir() | Locate session directory in project subdirs |
| 592–600 | getSessionPaths() | Return session file paths |
| 602–663 | cloneSession() | Clone session with internal message detection |
| 665–670 | deleteSessionFiles() | Delete session files |
| 672–694 | archiveSessionFiles() | Archive with restore_meta.json |
| 699–832 | parseSessionHistory() | JSONL to Unified Timeline |
| 710–720 | Internal message detection | Check isMeta and content markers |
| 834–867 | restoreSessionFiles() | Restore using restore_meta.json |
| 884–905 | CLAUDE_HOOK_MAP + getHooksForAgent() | Hook lookup from settings.json |
| 907–910 | setInitialAgent() | Intentional no-op |
| 912–916 | buildSessionParams() | Build _meta for session creation |
| 918–925 | performHandshake() | Send initialize request |

### providers/claude/quotaProxy.js

| Lines | Function | Purpose |
|-------|----------|---------|
| 20–65 | startClaudeQuotaProxy() | Start HTTP proxy, listen on loopback |
| 67–72 | stopClaudeQuotaProxy() | Stop and clean up proxy |
| 74–76 | getLatestClaudeQuota() | Return cached quota data |
| 78–117 | extractClaudeQuotaHeaders() | Parse anthropic-ratelimit-* headers |
| 119–168 | proxyRequest() | HTTP forwarding with header capture |
| 170–188 | resolveTarget() | Resolve Anthropic base URL from env |
| 190–196 | buildUpstreamUrl() | Construct upstream request URL |
| 198–206 | filterHeaders() | Remove hop-by-hop headers |

### Configuration Files

| File | Purpose |
|------|---------|
| `providers/claude/provider.json` | Provider identity, tool patterns, categories |
| `providers/claude/branding.json` | UI text and labels |
| `providers/claude/user.json` | Local overrides (optional) |
| `providers/claude/README.md` | Install and runtime guide |
| `providers/claude/SESSION_META_DATA.md` | _meta field reference |
| `providers/claude/ACP_PROTOCOL_SAMPLES.md` | Full captured protocol examples |

---

## Gotchas & Important Notes

### 1. toolIdPattern is DOUBLE underscore
Claude's pattern is `mcp__AcpUI__toolName` (two underscores between `mcp` and `AcpUI`). Some other daemons use single underscores. If the detection in normalizeTool() (Line 233) doesn't match, tools won't be recognized.

**Avoid:** Comparing to other daemon patterns without checking the actual value in provider.json.

### 2. Tool name aliases are context-dependent
Claude sends tool names as `'read'`, `'write'`, `'edit'` (short). The provider aliases them to `'read_file'`, etc. (Lines 246–249). But `toolCategories` in provider.json uses the SHORT names. If categorizeToolCall() looks up the aliased name, it won't find it.

**Avoid:** Mixing short vs. long names in the lookup chain. normalizeTool() should always apply aliases before categorizeToolCall() runs.

### 3. buildSessionParams ALWAYS returns an object
Even if agent is `null`, the function returns `{ _meta: { claudeCode: { options: { disallowedTools: [...] } } } }`. This is intentional — disallowedTools must always be injected to hide CLI-managed tools.

**Avoid:** Treating the return value as optional or null-able. It's always an object.

### 4. Session files are in project-scoped subdirectories
`~/.claude/projects/{encoded-cwd}/{sessionId}.jsonl` is not flat. The findSessionDir() function (Lines 573–590) must scan subdirectories. If you assume sessions are at `~/.claude/projects/{sessionId}.jsonl`, you will miss project-scoped sessions.

**Avoid:** Direct path construction like `path.join(sessionsRoot, sessionId + '.jsonl')`. Always use findSessionDir().

### 5. 'model' option is filtered out
intercept() (Lines 24–26) removes `'model'` from config_option_update because AcpUI has its own model UI. If you see a config_option_update with only `{ id: 'model', ... }`, intercept() returns `null` (suppresses it).

**Avoid:** Assuming every config_option_update produces an extension event. Some are filtered out.

### 6. 'effort' is renamed to 'reasoning_effort'
The ACP daemon sends `id: 'effort'`, but the UI expects `kind: 'reasoning_effort'`. Both intercept() (Line 26) and normalizeClaudeConfigResult() (Line 559) apply this remap. If you look for `option.id === 'effort'` on the UI side, you'll get `undefined`.

**Avoid:** Hardcoding 'effort' as the identifier. Use 'reasoning_effort' in UI code.

### 7. Internal messages use type:"user" with no clean flag
Claude's JSONL mixes real user messages and internal entries (tool results, command caveats) all under `type: "user"`. Detection is by content inspection (isMeta flag + XML markers). Older sessions may lack the isMeta flag entirely.

**Avoid:** Assuming every `type: "user"` entry is a real turn. Always check for markers (Lines 627–634, 710–720).

### 8. Quota data appears only after first Anthropic API call
The proxy starts empty. Quota data is populated only after Claude Code makes an API call to Anthropic and receives rate-limit headers. Launching AcpUI without sending a prompt won't show quota.

**Avoid:** Expecting quota status at boot. Wait for the first API call.

### 9. The proxy is a singleton
Once started, the proxy reuses its state (Lines 23–30). If `ANTHROPIC_BASE_URL` is already set to a loopback address, the proxy still starts but resolveTarget() (Line 21) may override it depending on the safety checks.

**Avoid:** Assuming multiple proxy instances. There's only one per provider.

### 10. archiveSessionFiles saves restore_meta.json with absolute path
The sessionDir is saved as an absolute path (Line 692). Without this metadata, restoreSessionFiles() falls back to the root directory, and the session becomes invisible to Claude Code (which only sees sessions in project subdirs).

**Avoid:** Skipping the restore_meta.json step. It's critical for correct restoration.

---

## Existing References

- **`providers/claude/ACP_PROTOCOL_SAMPLES.md`** — Full captured protocol with real request/response JSON examples. Load this when debugging protocol issues.
- **`providers/claude/SESSION_META_DATA.md`** — Complete reference for the `_meta` field in `session/new` and `session/load` requests.
- **`providers/claude/README.md`** — Installation, configuration, and runtime guide for operators.

---

## Unit Tests

Test files: `providers/claude/test/index.test.js`

Run tests:
```bash
npm test -- providers/claude
```

---

## How to Use This Guide

### For Implementing or Extending Claude Features

1. **Start here:** Read the "Overview" section to understand what Claude-specific behavior you're dealing with.
2. **Understand the flow:** Read the relevant section (e.g., "The Quota Proxy", "Tool Pipeline", "Session Files").
3. **Find the code:** Use the exact line numbers to navigate to `index.js` or `quotaProxy.js`.
4. **Check for gotchas:** Review the gotchas section for edge cases.
5. **Reference the protocol:** For protocol details, see `ACP_PROTOCOL_SAMPLES.md`.

### For Debugging Issues with Claude

1. **Identify the problem:** Is it about tools, sessions, quota, hooks, or something else?
2. **Locate the function:** Use the Component Reference table to find the relevant function.
3. **Read the code:** Jump to the exact lines and trace the execution.
4. **Check gotchas:** See if the issue matches a known gotcha.
5. **Check the logs:** Look for `[CLAUDE QUOTA]` messages (from quotaProxy) or `[CLAUDE]` messages in the provider logs.

### For Adding a New Feature

1. **Understand the contract:** Read the Provider System doc first.
2. **See how Claude does it:** Load the relevant section in this doc.
3. **Follow the pattern:** Replicate the structure for your new feature.
4. **Test internal messages:** If dealing with sessions, always test with fork pruning (internal message detection).
5. **Test the proxy:** If adding features that make API calls, verify quota capture works.

---

## Summary

Claude is AcpUI's reference provider implementation. It demonstrates the full contract:

- **Quota proxy** — Unique to Claude; shows how a provider can inject environment setup and capture metadata.
- **intercept() transforms** — Specific rewrites for config_option_update and available_commands_update.
- **Tool pipeline** — Complete normalization from MCP IDs to UI categories.
- **Session files** — Project-scoped filesystem layout with internal message detection for fork pruning.
- **Unified Timeline reconstruction** — parseSessionHistory() maps Claude's JSONL format to the Unified Timeline.
- **Agent support** — Spawn-time only; demonstrates why some provider features are immutable post-creation.
- **Hook system** — settings.json integration shows provider-specific configuration lookup.
- **Three config methods** — setConfigOption() routing demonstrates protocol flexibility.

The critical contract: **Claude's implementation is not the only way to implement these functions.** Other providers will handle tools, sessions, and config differently. This doc shows how Claude does it; use the Provider System doc to understand the generic patterns.

**When working on Claude provider code, always load this doc alongside `[Feature Doc] - Provider System.md`.**
