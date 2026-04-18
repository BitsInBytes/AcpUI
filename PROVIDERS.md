# ACP Provider System Specification

This document defines the interface and schemas for AcpUI Providers. The provider system decouples the core application from specific AI daemon implementations (ACP - Agent Client Protocol), allowing the UI to remain agnostic while supporting complex, provider-specific behaviors.

---

## 1. Architecture Overview

AcpUI operates on a three-tier architecture:

1.  **Frontend (React)**: Consumes a normalized "Unified Timeline". All UI strings, model labels, and protocol routing are derived from the provider's branding configuration.
2.  **Backend (Node.js)**: Orchestrates the ACP daemon lifecycle, multiplexes JSON-RPC communication, and handles session persistence. It delegates all data transformation and file-system logic to the provider module.
3.  **Provider (The Implementation)**: A directory containing configuration and a logic module that translates the daemon's native language into the AcpUI standard.

---

## 2. Directory Structure

A provider must reside in a dedicated directory (e.g., `./providers/my-provider`) with the following structure:

```
my-provider/
├── provider.json      # REQUIRED: Protocol and identity configuration
├── branding.json      # REQUIRED: UI labels and text strings
├── user.json          # REQUIRED: Local paths, models, and executable settings
└── index.js           # REQUIRED: The logic module (Interface Contract)
```

Providers are registered in `configuration/providers.json`.

---

## 3. Configuration Schemas

### A. `provider.json` (Protocol & Identity)
Defines the low-level communication identity and how the provider's tools map to UI features.

```jsonc
{
  "name": "Provider Name",           // Human-readable name
  "protocolPrefix": "prefix/",       // Prefix for custom extension methods (e.g., _companyName/)
  "mcpName": "AcpUI",                // The name of the AcpUI MCP server. Use "AcpUI" for most scenarios.
  "defaultSystemAgentName": "auto",  // REQUIRED. The REAL default agent name of the daemon.
                                     // Used to detect if a session has diverged from the baseline.
  "supportsAgentSwitching": false,   // Whether the ACP daemon supports switching agents mid-session.
  "cliManagedHooks": ["stop"],       // Hooks the CLI handles natively (AcpUI will skip these)
  "toolIdPattern": "mcp__{mcpName}__{toolName}", // How the daemon reports MCP tool names. 
                                                 // Used to map daemon events to UI-hooked tools.
  "toolCategories": {                // Maps daemon tool names to UI categories
    "read_file":  { "category": "file_read",  "isFileOperation": true },
    "write_file": { "category": "file_write", "isFileOperation": true },
    "grep":       { "category": "grep" }
  },
  "clientInfo": {                    // Passed to the daemon during 'initialize'
    "name": "MyClient",
    "version": "1.0.0"
  }
}
```

### B. `branding.json` (The "Look")
Defines all strings rendered in the UI. The frontend has zero hardcoded provider names.

```jsonc
{
  "title": "Application Title",      // browser tab title
  "assistantName": "Assistant",      // Label above messages
  "busyText": "Thinking...",         // Placeholder during generation
  "hooksText": "Hooks running...",   // Placeholder during post-process hooks
  "warmingUpText": "Starting...",    // Placeholder during daemon boot
  "resumingText": "Resuming...",     // Placeholder during session load
  "inputPlaceholder": "Message...",  // Default input text
  "emptyChatMessage": "Start here.", // Message shown in empty sessions
  "notificationTitle": "Assistant",  // Desktop notification header
  "appHeader": "Workspace",          // Header text
  "sessionLabel": "Conversation",    // Session settings label
  "modelLabel": "Model Tier"         // Model selection label
}
```

### C. `user.json` (The "How")
Contains local machine settings. This file is typically git-ignored in production but serves as the deployment contract. **Paths must be absolute.**

```jsonc
{
  "command": "executable-name",      // Command to spawn (e.g., "node" or "my-cli")
  "args": ["arg1", "acp"],           // Arguments to pass to the command
  "paths": {
    // These paths are expected to be absolute and typically point to the provider CLI's home directory.
    "sessions": "/path/to/logs",     // Where .jsonl files are stored
    "agents": "/path/to/agents",     // Where agent definitions live
    "attachments": "/path/to/files"  // Where uploads are stored
  },
  "models": {
    // Default model ID used for new sessions. This must be the real provider model ID.
    "default": "mid-tier",

    // Optional footer quick-access entries. The list can contain zero, one, or many models.
    // If this list is empty, the footer model label is displayed but is not clickable.
    // These entries are not the full dynamic model catalog.
    "quickAccess": [
      { "id": "high-end", "displayName": "Flagship", "description": "Highest capability" },
      { "id": "mid-tier", "displayName": "Balanced", "description": "Everyday work" },
      { "id": "low-end", "displayName": "Fast", "description": "Fast responses" }
    ],
    
    // Titling and sub-agent settings MUST use the model ID, NOT a display name.
    "titleGeneration": "low-end",    // Model ID used for titling sessions
    "subAgent": "mid-tier"           // Model ID used for sub-agent sessions
  }
}
```

### D. Dynamic Model Contract

AcpUI treats model selection as a first-class application contract, not as a provider-specific UI config option.

Providers and ACP daemons can advertise the full per-session model catalog dynamically. The backend normalizes that catalog into:

```jsonc
{
  "currentModelId": "provider-real-model-id",
  "modelOptions": [
    {
      "id": "provider-real-model-id",
      "name": "Provider Display Name",
      "description": "Optional detail shown in settings"
    }
  ]
}
```

Supported sources, in priority order:

- `session/new` or `session/load` result: `models.currentModelId` and `models.availableModels`.
- `session/new` or `session/load` result: top-level `currentModelId` and `modelOptions`.
- Dynamic config option: a `select` option whose `id`, `category`, or `kind` is `model`, with `currentValue` and `options`.
- Provider `user.json` `models.quickAccess[]` entries as fallback catalog entries.

Model option entries may use any of these equivalent input shapes before normalization:

```jsonc
{ "id": "model-id", "name": "Display Name", "description": "Optional" }
{ "modelId": "model-id", "displayName": "Display Name" }
{ "value": "model-id", "name": "Display Name" }
```

Contract rules:

- `currentModelId` is the source of truth for the selected model. It must be the real provider model ID.
- The legacy session `model` field should contain the raw model ID.
- `session/set_model` must receive the real model ID, never a UI display name.
- Providers should emit or normalize full model data to this contract and keep `models.quickAccess[]` limited to footer shortcuts.
- If a provider exposes model as a generic config option, the backend captures it as model state before provider interceptors can hide it from generic config rendering. This prevents duplicate model controls while preserving the catalog.

### E. Provider Status Contract

Providers can publish provider-level status through a provider extension method:

```text
{protocolPrefix}provider/status
```

This is intentionally display-oriented and provider-owned. AcpUI does not interpret the meaning of quotas, cost, model limits, reset windows, or any other provider-specific data. The provider translates raw data into summary rows for the sidebar and full sections for the details modal.

```jsonc
{
  "status": {
    "providerId": "provider-id",
    "title": "Provider Name",
    "subtitle": "Optional short state",
    "updatedAt": "2026-04-18T22:56:25.236Z",
    "summary": {
      "title": "Usage",
      "items": [
        {
          "id": "five-hour",
          "label": "5h",
          "value": "3%",
          "tone": "success",
          "progress": { "value": 0.03 }
        }
      ]
    },
    "sections": [
      {
        "id": "usage",
        "title": "Usage Windows",
        "items": [
          {
            "id": "five-hour",
            "label": "5h",
            "value": "3%",
            "detail": "Allowed - Resets Apr 25, 10:50 PM",
            "tone": "success",
            "progress": { "value": 0.03 }
          }
        ]
      }
    ]
  }
}
```

Contract rules:

- `summary.items` is the compact always-visible sidebar layer. Keep it short.
- `sections` is the complete details layer. Include any raw/provider-specific rows that are useful for inspection.
- `progress.value` is normalized from `0` to `1`; providers own that conversion.
- `tone` is optional and may be `neutral`, `info`, `success`, `warning`, or `danger`.
- Values are already formatted for display. The frontend should not know provider-specific units or semantics.

---

## 4. `index.js` Contract (The Logic)

The provider module must export a specific set of functions. If a feature is not needed, it must implement a minimal pass-through.

### Data Normalization & Interception

| Function | Responsibility |
| :--- | :--- |
| `intercept(payload)` | **Critical.** Called on every raw JSON-RPC line from stdout. Allows mutating commands/config before routing. Return `null` to swallow the message. |
| `normalizeUpdate(update)` | Translates non-standard daemon updates into standard ACP `session/update` shapes. |
| `extractToolOutput(update)` | Extracts text or diffs from `tool_call_update`. **Golden Rule:** If a tool is streaming (e.g., `rawInput`), this should extract partial content to provide real-time UI updates. |
| `extractFilePath(update, resolve)` | Identifies the file being targeted by a tool. Used for "Sticky Metadata" so the UI knows which file is being "Written..." even if the daemon sends generic status updates. |
| `normalizeTool(event, update)` | Produces a human-readable `title` and `toolName`. Should inject arguments (like filenames) into the title for visibility. |
| `categorizeToolCall(event)` | Maps a tool to a UI category (`file_read`, `file_edit`, `shell`, `glob`). |

### Session & History Management

| Function | Responsibility |
| :--- | :--- |
| `getSessionPaths(acpId)` | Locates the `.jsonl` and `.json` files for a session. Must handle project-scoped subdirectories. |
| `cloneSession(oldId, newId, pruneTurn)` | **Critical for Forking.** Copies session files. If `pruneTurn` is set, it must truncate the history. **Golden Rule:** Must distinguish "internal" messages (caveats, internal tool calls) from real user turns to avoid premature truncation. |
| `parseSessionHistory(path, Diff)` | Reconstructs the **Unified Timeline** from a `.jsonl` file. Maps `assistant` and `user` entries into a sequence of `thought`, `tool`, and `text` steps. |
| `archiveSessionFiles(...)` | Moves files to long-term storage. |
| `deleteSessionFiles(acpId)` | Cleans up all persistence associated with a session. |

### Lifecycle Hooks

| Function | Responsibility |
| :--- | :--- |
| `prepareAcpEnvironment(env, context)` | Prepares the environment used to spawn the ACP daemon. Providers must return an environment object. Use this for provider-owned sidecars, local proxies, or environment injection. Providers that do not need setup should return `env` unchanged. |
| `performHandshake(client)` | Owns the full initialization sequence. Must call `client.sendRequest('initialize', ...)` and any provider-specific follow-up (e.g., `authenticate`). The provider controls ordering — if the daemon requires two requests in-flight simultaneously before responding to either, send both before awaiting (e.g., `await Promise.all([initPromise, authPromise])`). |
| `buildSessionParams(agent)` | Returns extra params to spread into `session/new` and `session/load` ACP requests. The provider owns the full object shape — the backend spreads whatever is returned verbatim. Return `undefined` if no extra params are needed (the default). See [Agent Forwarding](#agent-forwarding) below. |
| `setInitialAgent(client, sessionId, agent)` | Called after session creation to apply an agent via a post-creation mechanism (e.g., sending a slash command as a prompt). Only implement if your daemon supports runtime agent switching. If your daemon requires the agent at spawn time, implement `buildSessionParams` instead and leave this as a no-op. |
| `setConfigOption(...)` | Translates UI config changes (like "Reasoning Effort") to native daemon requests. Model selection is not a generic config option; it flows through the dynamic model contract and `session/set_model`. |
| `getHooksForAgent(...)` | Resolves post-processing hooks from agent definitions. |

---

## 5. Agent Forwarding

When the user selects a named agent, AcpUI passes the agent name to the provider via two hooks at different points in the session lifecycle. How you implement these depends entirely on when your daemon accepts agent configuration.

### `buildSessionParams(agent)` — spawn-time forwarding

Use this when your daemon must receive the agent at the point of session creation (i.e., it is applied as a startup option, not a runtime command). The backend calls this before sending `session/new` or `session/load` and spreads the returned object into the request params.

```js
// Example: daemon reads agent from _meta on session/new and session/load
export function buildSessionParams(agent) {
  if (!agent) return undefined;
  return { _meta: { myDaemon: { options: { agent } } } };
}
```

The backend spreads the return value verbatim — the provider fully controls the key names and nesting. Return `undefined` (or nothing) when no agent is set, or when the provider does not use this mechanism.

### `setInitialAgent(client, sessionId, agent)` — post-creation forwarding

Use this when your daemon supports switching agents at runtime after a session exists (e.g., via a slash command sent as a `session/prompt`). The backend calls this immediately after `session/new` or `session/load` completes.

```js
// Example: daemon switches agent via a /agent slash command
export async function setInitialAgent(client, sessionId, agent) {
  if (!agent) return;
  await client.sendRequest('session/prompt', {
    sessionId,
    prompt: [{ type: 'text', text: `/agent ${agent}` }]
  });
}
```

### Choosing between the two

| Scenario | Use |
|---|---|
| Daemon applies agent at subprocess start (startup flag / env var) | `buildSessionParams` |
| Daemon supports runtime agent switching via a command or request | `setInitialAgent` |
| Daemon supports both | Both — `buildSessionParams` for new/load, `setInitialAgent` as a fallback override |
| Provider does not support named agents | Neither — inherit the no-op defaults |

Both hooks are called on every `session/new` and `session/load`. If `agent` is `undefined` or empty, both should be no-ops.

---

## 7. Implementation Patterns (The "High-Fidelity" Standard)

When implementing a provider, follow these patterns to ensure a professional user experience:

### Real-Time Tool Streaming
Do not wait for `status: "completed"` to show output. In `extractToolOutput`, parse the `rawInput` (even if partial JSON) to extract content fields. This allows the UI to render code as it's being generated.

### Sticky Metadata
Daemons often emit a `tool_call` with a filename, followed by many `tool_call_update` messages that *omit* the filename. The backend caches the first filename; your `extractFilePath` should reliably find it in the first packet so the UI can "stick" it to the entire tool execution block.

### Internal Message Filtering
When parsing history or pruning for forks, look for "meta" flags or content markers (e.g., hidden command caveats). These should not count as "User Turns". If you treat an internal command as a user turn, a session pruned at turn 1 might contain only a system warning and no actual conversation.

### Unified Timeline Construction
In `parseSessionHistory`, do not simply return a list of messages. Return a `timeline` of steps. 
- `type: "thought"` for internal reasoning.
- `type: "tool"` for actions.
- `type: "text"` for final responses.
This allows the UI to render the "thinking" process and tool logs inline with the conversation.


---

## 8. Debugging & Protocol Capture

When developing or troubleshooting a provider, you can invoke the ACP daemon directly to inspect the raw JSON-RPC traffic without the backend/frontend in the way.

### Quick Test

Create a Node.js script (e.g., `acp_capture.js`) in the project root:

```javascript
const { spawn } = require('child_process');
const fs = require('fs');

const lines = [];
function log(label) { lines.push('', `=== ${label} ===`); }
function capture(line) { lines.push(line); }

const proc = spawn('<command>', ['<args>'], {
  env: { ...process.env, TERM: 'dumb', CI: 'true', FORCE_COLOR: '0' },
  cwd: process.cwd()
});

let buf = '';
proc.stdout.on('data', d => {
  buf += d.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) capture(line);
  }
});

function send(json) { proc.stdin.write(json + '\n'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function run() {
  // Some daemons hold the initialize response until a second request (e.g., authenticate)
  // is received. Send both before awaiting either if that's the case.
  log('initialize');
  send(JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      clientInfo: { name: 'AcpUI', version: '1.0.0' }
    }
  }));
  await sleep(4000);

  log('session/new');
  send(JSON.stringify({
    jsonrpc: '2.0', id: 2, method: 'session/new',
    params: { cwd: process.cwd(), mcpServers: [] }
  }));
  await sleep(8000);

  // Extract session ID from captured output
  const sidMatch = lines.join('\n').match(/"sessionId"\s*:\s*"([0-9a-f-]{36})"/);
  const sid = sidMatch?.[1];
  if (!sid) { console.error('No session ID found'); proc.kill(); process.exit(1); }

  // Add more interactions here: session/prompt, session/set_model, session/load, etc.

  fs.writeFileSync('acp_capture_output.txt', lines.join('\n'), 'utf8');
  console.log(`Captured ${lines.length} lines`);
  proc.kill();
}

run();
```

Replace `<command>` and `<args>` with the values from your provider's `user.json`.

### What to Capture

For a complete protocol reference, test these interactions in order:

| Step | Method | Purpose |
|------|--------|---------|
| 1 | `initialize` (+ any required auth handshake, e.g. `authenticate`) | Capabilities, auth, agent info. Note whether the daemon responds immediately or only after a paired request. |
| 2 | `session/new` | Session creation, modes, models, extension notifications |
| 3 | `session/prompt` with `/agent <name>` | Agent switching mechanism and side effects |
| 4 | `session/set_model` | Model switching with a real model ID from the dynamic catalog |
| 5 | `session/prompt` with a simple question | Streaming chunks, metadata, turn completion |
| 6 | `session/load` | History replay, mode/model preservation |

### What to Look For

- **Extension notifications** — methods prefixed with your `protocolPrefix`. These arrive as notifications (no `id`) between or after responses.
- **Ordering** — notifications often arrive *before* the response they relate to. Document the sequence.
- **Unsupported methods** — test methods like `session/set_mode` to see if they work, crash the process, or are silently ignored.
- **Field differences** — compare what the daemon sends vs what your provider normalizes. Look for PascalCase types, flat string content, non-standard tool output formats.
- **Model state** — capture dynamic model catalogs, `currentModelId`, model config option updates, and whether model options change after switching models or sending prompts.

### Output

Save the formatted results as `ACP_PROTOCOL_SAMPLES.md` in your provider directory. Sanitize any personal data (local paths, custom agent names, session UUIDs) before committing to a public repo.
