# Feature Doc — Kiro Provider

## Overview

Kiro is implemented via the `kiro-cli` ACP daemon. This document is a **sidecar supplement** to `[Feature Doc] - Provider System.md` and assumes you understand the provider contract. It exists solely to show how Kiro specifically implements or deviates from that contract, with real code, line numbers, and Kiro-specific terminology.

**Load this doc alongside `[Feature Doc] - Provider System.md` when working on the Kiro provider.** This doc makes no sense in isolation.

---

## What Kiro Implements

Kiro implements all required provider contract functions:

- **intercept()** — Maps agent switch notifications to include currentModelId
- **normalizeUpdate()** — Converts PascalCase types to snake_case and normalizes string content to `{ text }` format
- **extractToolOutput()** — Extracts tool output from rawOutput.items array
- **extractFilePath()** — Multi-step detection from locations, content, or arguments
- **extractDiffFromToolCall()** — Extracts diffs from content array or rawInput
- **extractToolInvocation()** — **V2 Tool Routing**: Extracts canonical identity using `toolIdPattern` (`@{mcpName}/{toolName}`)
- **normalizeTool()** — Strips `@ServerName/` MCP prefix using pattern and resolves generic tool IDs to standard names
- **categorizeToolCall()** — Maps Kiro's tool names to UI categories
- **parseExtension()** — Routes Kiro's `_kiro.dev/` protocol extensions
- **emitCachedContext()** — Replays persisted context usage when the backend loads or hot-resumes a session
- **performHandshake()** — Single `initialize` call
- **setInitialAgent()** — Actively switches agents via `/agent {name}` prompt post-creation
- **buildSessionParams()** — Returns `undefined`
- **getHooksForAgent()** — Reads agent-specific hook configs from `~/.kiro/agents/{agentName}.json`
- **onPromptStarted() / onPromptCompleted()** — Explicit no-op lifecycle hooks required by the provider contract
- **setConfigOption()** — Only handles 'model'; returns null for other options
- **Session file operations** — Flat directory layout
- **parseSessionHistory()** — Reconstructs Unified Timeline from Kiro's JSONL format

### Kiro-Specific Characteristics

| Aspect | Implementation |
|--------|-----------------|
| **Agent Switching** | Post-creation via `/agent` slash command |
| **Tool ID Pattern** | `@AcpUI/toolName` (single @ symbol) |
| **Session Layout** | Flat directory; no project-scoped subdirectories |
| **Update Normalization** | PascalCase types converted to snake_case |
| **Content Format** | Flat string normalized to `{ text }` structure |
| **Hook Configuration** | Per-agent JSON files in agents directory |
| **Session JSONL** | `kind`-based format: `Prompt`, `AssistantMessage`, `ToolResults` |

---

## How Kiro Starts — Startup Flow

### Step 1: Spawn & Handshake

**File:** `providers/kiro/index.js` (Lines 332–339)

Kiro's startup is straightforward. `prepareAcpEnvironment()` (Line 314-316) does nothing special:

```javascript
// FILE: providers/kiro/index.js (Lines 314-316)
export async function prepareAcpEnvironment(env) {
  return env;  // LINE 315: No modification needed
}
```

Then `performHandshake()` sends a single `initialize` request:

```javascript
// FILE: providers/kiro/index.js (Lines 332-339)
export async function performHandshake(acpClient) {
  const { config } = getProvider();
  await acpClient.transport.sendRequest('initialize', {  // LINE 334: Single initialize call
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
    clientInfo: config.clientInfo || { name: 'ACP-UI', version: '1.0.0' }
  });
}
```

### Step 2: Set Initial Agent (If Provided)

**File:** `providers/kiro/index.js` (Lines 345–365)

Kiro actively switches agents post-creation via the `/agent` slash command:

```javascript
// FILE: providers/kiro/index.js (Lines 345-365)
export async function setInitialAgent(acpClient, sessionId, agent) {
  if (!agent) return;  // LINE 346: No agent specified

  console.log(`[KIRO PROVIDER] Setting initial agent to: ${agent}`);

  const sendWithTimeout = (method, params, timeout = 30000) => {
    return Promise.race([
      acpClient.transport.sendRequest(method, params),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), timeout))
    ]);
  };

  acpClient.stream.beginDraining(sessionId);  // LINE 357: Pause stream to avoid race conditions
  await sendWithTimeout('session/prompt', {
    sessionId: sessionId,
    prompt: [{ type: 'text', text: `/agent ${agent}` }]  // LINE 360: Send /agent command
  });
  await acpClient.stream.waitForDrainToFinish(sessionId, 1000);  // LINE 362: Resume stream
  
  console.log(`[KIRO PROVIDER] Agent switch complete.`);
}
```

**Key:** Kiro sends an actual prompt (`/agent {name}`) to switch agents. The stream must be paused/resumed to prevent message ordering issues.

---

## Configuration Files

### provider.json

**File:** `providers/kiro/provider.json` (Complete)

```json
{
    "name": "Kiro",
    "protocolPrefix": "_kiro.dev/",
    "mcpName": "AcpUI",
    "defaultSystemAgentName": "kiro_default",
    "supportsAgentSwitching": true,
    "cliManagedHooks": ["stop"],
    "toolIdPattern": "@{mcpName}/{toolName}",
    "toolCategories": {
        "bash": { "category": "shell", "isShellCommand": true, "isStreamable": true },
        "read_file": { "category": "file_read", "isFileOperation": true },
        "read_file_parallel": { "category": "file_read", "isFileOperation": true },
        "write_file": { "category": "file_write", "isFileOperation": true },
        "replace": { "category": "file_edit", "isFileOperation": true },
        "list_directory": { "category": "glob", "isFileOperation": true },
        "glob": { "category": "glob", "isFileOperation": true }
    },
    "clientInfo": {
        "name": "AcpUI",
        "version": "1.0.0"
    }
}
```

**Critical fields:**
- **`protocolPrefix: "_kiro.dev/"`** — All Kiro extensions use this prefix (e.g., `_kiro.dev/agent/switched`)
- **`toolIdPattern: "@{mcpName}/{toolName}"`** — **SINGLE @ symbol**. Becomes `@AcpUI/ux_invoke_shell`.
- **`supportsAgentSwitching: true`** — Agents CAN be changed post-creation. This enables post-spawn agent switching via slash commands.
- **`defaultSystemAgentName: "kiro_default"`** — The default agent if none is specified
- **`cliManagedHooks: ["stop"]`** — The "stop" hook is managed by Kiro CLI (via `agent/exit` method), not via JSON config
- **`toolCategories`** — Uses final tool names (`read_file`, `write_file`, `replace`, etc.), not short aliases

### branding.json

**File:** `providers/kiro/branding.json` (Complete)

```json
{
    "title": "Kiro",
    "assistantName": "Kiro",
    "busyText": "Kiro is busy...",
    "hooksText": "Hooks running...",
    "warmingUpText": "Engine warming up...",
    "resumingText": "Resuming...",
    "inputPlaceholder": "Send a message...",
    "emptyChatMessage": "Send a message to start chatting with Kiro.",
    "notificationTitle": "Kiro",
    "appHeader": "Kiro",
    "sessionLabel": "Kiro Session",
    "modelLabel": "Kiro model",
    "maxImageDimension": 1568
}
```

**Note:** Kiro has `maxImageDimension: 1568` — indicates image attachment support.

### user.json (Example)

```json
{
    "command": "kiro-cli",
    "args": ["acp"],
    "defaultSubAgentName": "agent-dev",
    "paths": {
        "home": "~/.kiro",
        "sessions": "~/.kiro/sessions/cli",
        "agents": "~/.kiro/agents",
        "attachments": "~/.kiro/attachments",
        "archive": "~/.kiro/archive"
    },
    "models": {
        "default": "claude-sonnet-4.6",
        "quickAccess": [
            { "id": "claude-opus-4.6", "displayName": "Opus" },
            { "id": "claude-sonnet-4.6", "displayName": "Sonnet" },
            { "id": "claude-haiku-4.5", "displayName": "Haiku" }
        ]
    }
}
```

**Note:** Kiro's session directory is **flat** (`~/.kiro/sessions/cli/`) — all sessions sit directly in this directory.

---

## normalizeUpdate() — PascalCase to snake_case Conversion

**File:** `providers/kiro/index.js` (Lines 49–61)

Kiro sends update types in PascalCase (e.g., `AgentMessageChunk`, `ToolUseStart`). These must be converted to snake_case for the ACP standard pipeline. The provider normalizes on entry:

```javascript
// FILE: providers/kiro/index.js (Lines 49-61)
export function normalizeUpdate(update) {
  // Normalize PascalCase types
  if (!update.sessionUpdate && update.type) {
    update.sessionUpdate = toSnakeCase(update.type);  // LINE 52: Convert type to sessionUpdate field
  }

  // Normalize flat string content to { text } format (LINE 55-57)
  if (typeof update.content === 'string') {
    return {
      ...update,
      _originalContent: update.content,  // Preserve original for debugging
      content: { text: update.content }  // Wrap in standard format
    };
  }

  return update;
}

// Helper function (Lines 40-43)
function toSnakeCase(str) {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase().replace(/^_/, '');
}
```

**Why?** Kiro's PascalCase (`AgentMessageChunk`) doesn't match the ACP standard (`agent_message_chunk`). The normalization bridges the gap.

---

## intercept() — Agent Switch Normalization

**File:** `providers/kiro/index.js` (Lines 15–36)

When Kiro switches agents, it sends an `agent/switched` extension event that includes the active model. This is mapped to AcpUI's expected field name:

```javascript
// FILE: providers/kiro/index.js (Lines 15-36)
export function intercept(payload) {
  const { config } = getProvider();

  // Kiro reports the active model on agent switch notifications
  if (
    payload.method === `${config.protocolPrefix}agent/switched` &&
    typeof payload.params?.model === 'string' &&
    !payload.params.currentModelId  // Only if not already set
  ) {
    return {
      ...payload,
      params: {
        ...payload.params,
        currentModelId: payload.params.model  // LINE 30: Map 'model' to 'currentModelId'
      }
    };
  }

  return payload;  // LINE 35: Most messages pass through unchanged
}
```

**Purpose:** When Kiro switches agents, it includes the active model in the `model` field. This is normalized to `currentModelId` so the backend can persist it correctly.

---

## Tool Pipeline — How Kiro Tools Are Normalized

Kiro's tool handling uses the V2 Tool Invocation system, resolving canonical identities before display normalization.

### 1. V2 Tool Invocation Routing

**File:** `providers/kiro/index.js` (Lines 546–575)

Kiro implements `extractToolInvocation()` to provide authoritative metadata for the backend tool registry. It uses `toolIdPattern` (`@{mcpName}/{toolName}`) from `provider.json` to resolve the canonical tool name.

```javascript
export function extractToolInvocation(update = {}, context = {}) {
  const event = context.event || {};
  const { config } = getProvider();
  const normalized = normalizeTool({ ...event }, update);
  const input = mergeInputObjects(collectInputObjects(
    update.rawInput,
    update.arguments,
    update.params,
    update.input,
    update.toolCall?.arguments
  ));
  const rawName = update.name || update.toolName || event.toolName || event.title || event.id || '';
  const title = update.title || event.title || '';
  const mcpMatch = matchToolIdPattern(rawName, config) || matchToolIdPattern(title, config);
  const canonicalName = normalized.toolName || '';

  return {
    toolCallId: update.toolCallId || event.id,
    kind: mcpMatch ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
    rawName,
    canonicalName,
    mcpServer: mcpMatch?.mcpName,
    mcpToolName: mcpMatch?.toolName,
    input,
    title: normalized.title || title,
    filePath: normalized.filePath || event.filePath,
    category: categorizeToolCall({ ...normalized, toolName: canonicalName }) || {}
  };
}
```

### 2. Tool ID Pattern Detection

**File:** `providers/kiro/index.js` (Lines 506–510)

Kiro's tools use identifiers matching the pattern `@{mcpName}/{toolName}` (e.g. `@AcpUI/ux_invoke_shell`). `normalizeTool()` uses `matchToolIdPattern` and `replaceToolIdPattern` to manage these identifiers:

```javascript
// FILE: providers/kiro/index.js (Lines 506-510)
const configuredToolMatch = matchToolIdPattern(toolName, config);
if (configuredToolMatch?.toolName) toolName = configuredToolMatch.toolName;

// Clean configured MCP tool ids from the display title (Line 521)
if (event.title) {
  event = { ...event, title: replaceToolIdPattern(event.title, config) };
}
```

### 3. Resolve Generic Tool IDs from Title

**File:** `providers/kiro/index.js` (Lines 512–534)

If the tool ID is still generic after pattern matching, Kiro extracts from the title:

```javascript
// FILE: providers/kiro/index.js (Lines 512-534)
if (toolName.startsWith('tooluse_') || toolName.startsWith('call_') || toolName.startsWith('toolu_')) {
  const title = event.title || '';
  const titleToolMatch = matchToolIdPattern(title, config);
  if (titleToolMatch?.toolName) toolName = titleToolMatch.toolName;
}
```

**Key:** If the tool name is generic, Kiro uses the configured pattern to resolve it from the display title.

### 4. Clean Title and Format

**File:** `providers/kiro/index.js` (Lines 407–431)

Remove MCP prefixes from display title and apply UX tool naming:

```javascript
// FILE: providers/kiro/index.js (Lines 407-431)
// Clean any @ServerName/ prefix from the display title
if (event.title) {
  event = { ...event, title: event.title.replace(/@[^/]+\//g, '') };  // LINE 409: Strip prefix
}

// Format title: replace any "Running: <toolName>" prefix with a human-readable label
if (event.title && toolName) {
  const UX_TOOL_TITLES = {
    ux_invoke_shell: 'Invoke Shell',
    ux_invoke_subagents: 'Invoke Subagents',
    ux_invoke_counsel: 'Invoke Counsel'
  };
  const pretty = UX_TOOL_TITLES[toolName] ||
    toolName.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  event = { ...event, title: event.title.replace(/Running:\s*\S+/, pretty) };
}

return { ...event, toolName };
```

### 4. Categorization

**File:** `providers/kiro/index.js` (Lines 436–450)

```javascript
// FILE: providers/kiro/index.js (Lines 436-450)
export function categorizeToolCall(event) {
  const { config } = getProvider();
  const toolName = event.toolName;
  if (!toolName) return null;

  const metadata = (config.toolCategories || {})[toolName];  // LINE 441: Look up in provider.json
  if (!metadata) return null;

  return {
    toolCategory: metadata.category,
    isFileOperation: metadata.isFileOperation || false,
    isShellCommand: metadata.isShellCommand || false,  // LINE 447: Kiro has shell-specific metadata
    isStreamable: metadata.isStreamable || false
  };
}
```

**Note:** Kiro includes `isShellCommand` and `isStreamable` metadata, unique to this provider.

---

## extractToolOutput() — Kiro's Unique rawOutput Format

**File:** `providers/kiro/index.js` (Lines 67–85)

Kiro stores tool output in `rawOutput.items` array, not the standard `content` array:

```javascript
// FILE: providers/kiro/index.js (Lines 67-85)
export function extractToolOutput(update) {
  if (update.rawOutput?.items) {
    const parts = update.rawOutput.items.map(item => {
      if (item.Text) return item.Text;  // LINE 70: Extract Text field
      if (item.Json?.content) {
        // LINE 71-72: Handle JSON responses
        return item.Json.content.map(c => c.text || '').join('');
      }
      if (item.Json) return JSON.stringify(item.Json, null, 2);  // LINE 74: Stringify JSON
      return '';
    }).filter(Boolean);
    
    const joined = parts.join('\n');
    
    // Skip plain success messages so diffs from tool_start are preserved (LINE 79)
    if (joined && !/^Successfully (created|replaced|inserted)\b/i.test(joined)) {
      return joined;
    }
    
    return undefined;
  }
  return undefined;
}
```

**Key:** Kiro's format is `rawOutput.items[{ Text?, Json? }]`, not the standard `content[]`.

---

## extractFilePath() — Multi-Step Detection

**File:** `providers/kiro/index.js` (Lines 91–123)

Kiro embeds file paths in multiple places:

```javascript
// FILE: providers/kiro/index.js (Lines 91-123)
export function extractFilePath(update, resolvePath) {
  const kind = update.kind || '';
  const title = (update.title || '').toLowerCase();

  // NOISE FILTERING: Skip generic commands (Lines 95-96)
  if (title.startsWith('listing') || title.startsWith('running:')) return undefined;

  // KIND FILTERING: Only extract for file-related tools (Lines 98-103)
  if (!['edit', 'read'].includes(kind)) {
    const id = (update.toolCallId || '').toLowerCase();
    if (!['write_file', 'replace', 'read_file', 'read_file_parallel'].some(t => id.includes(t))) {
      return undefined;
    }
  }

  // STEP 1: Check locations (Kiro sends these for file tools) (Lines 106-108)
  if (update.locations?.length > 0 && update.locations[0].path) {
    return resolvePath(update.locations[0].path);
  }

  // STEP 2: Check content for diff paths (Lines 111-113)
  if (update.content && Array.isArray(update.content) && update.content.length > 0 && update.content[0].path) {
    return resolvePath(update.content[0].path);
  }

  // STEP 3: Check standard tool arguments (Lines 116-120)
  const args = update.arguments || update.params || update.rawInput;
  if (args) {
    const p = args.path || args.file_path || args.filePath;
    if (p) return resolvePath(p);
  }

  return undefined;
}
```

---

## Session Files — Flat Layout

Kiro stores sessions in a **flat directory** structure.

### Layout

```
~/.kiro/sessions/cli/
├── {sessionId}.jsonl
├── {sessionId}.json
└── {sessionId}/
    └── (task files)
```

All sessions are directly in `~/.kiro/sessions/cli/`, with no subdirectories for different projects.

### getSessionPaths()

**File:** `providers/kiro/index.js` (Lines 197–205)

```javascript
// FILE: providers/kiro/index.js (Lines 197-205)
export function getSessionPaths(acpId) {
  const { config } = getProvider();
  const dir = config.paths.sessions;  // LINE 199: Direct directory (no subdirectory scanning)
  return {
    jsonl: path.join(dir, `${acpId}.jsonl`),
    json: path.join(dir, `${acpId}.json`),
    tasksDir: path.join(dir, acpId),
  };
}
```

**Simple:** Direct path construction since sessions are not scoped to projects.

### cloneSession()

**File:** `providers/kiro/index.js` (Lines 210–245)

```javascript
// FILE: providers/kiro/index.js (Lines 210-245)
export function cloneSession(oldAcpId, newAcpId, pruneAtTurn) {
  const oldPaths = getSessionPaths(oldAcpId);
  const newPaths = getSessionPaths(newAcpId);

  // Clone JSONL (optionally pruned)
  if (fs.existsSync(oldPaths.jsonl)) {
    const lines = fs.readFileSync(oldPaths.jsonl, 'utf-8').split('\n').filter(l => l.trim());
    
    if (pruneAtTurn != null) {
      let userTurnCount = 0;
      let pruneAt = lines.length;
      
      for (let i = 0; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          // LINE 224: Kiro uses 'Prompt' kind for user turns
          if (entry.kind === 'Prompt') userTurnCount++;
          if (userTurnCount > pruneAtTurn) { pruneAt = i; break; }
        } catch { /* skip */ }
      }
      
      fs.writeFileSync(newPaths.jsonl, lines.slice(0, pruneAt).join('\n') + '\n', 'utf-8');
    } else {
      fs.copyFileSync(oldPaths.jsonl, newPaths.jsonl);  // LINE 230: No ID replacement needed (flat layout)
    }
  }

  // Clone JSON with ID replacement
  if (fs.existsSync(oldPaths.json)) {
    let json = fs.readFileSync(oldPaths.json, 'utf-8');
    json = json.replaceAll(oldAcpId, newAcpId);  // LINE 237: Simple text replacement
    fs.writeFileSync(newPaths.json, json, 'utf-8');
  }

  // Clone tasks folder
  if (fs.existsSync(oldPaths.tasksDir)) {
    fs.cpSync(oldPaths.tasksDir, newPaths.tasksDir, { recursive: true });
  }
}
```

**Key:** User turns in Kiro JSONL are marked by `kind: 'Prompt'`, not `type: 'user'`.

### archiveSessionFiles() & restoreSessionFiles()

**File:** `providers/kiro/index.js` (Lines 254–286)

Both are straightforward because the flat layout doesn't require metadata:

```javascript
// FILE: providers/kiro/index.js (Lines 254-286, abbreviated)
export function archiveSessionFiles(acpId, archiveDir) {
  const paths = getSessionPaths(acpId);
  // Copy files to archiveDir (no restore_meta.json needed for flat layout)
  if (paths.jsonl && fs.existsSync(paths.jsonl)) {
    fs.copyFileSync(paths.jsonl, path.join(archiveDir, `${acpId}.jsonl`));
    fs.unlinkSync(paths.jsonl);
  }
  // ... copy .json and tasks ...
}

export function restoreSessionFiles(savedAcpId, archiveDir) {
  const { config } = getProvider();
  const sessionsDir = config.paths.sessions;  // Direct directory
  
  const jsonlSrc = path.join(archiveDir, `${savedAcpId}.jsonl`);
  if (fs.existsSync(jsonlSrc)) {
    fs.copyFileSync(jsonlSrc, path.join(sessionsDir, `${savedAcpId}.jsonl`));  // Restore directly
  }
  // ... restore .json and tasks ...
}
```

**No metadata file needed** — flat layout makes restoration trivial.

---

## parseSessionHistory() — Kiro's JSONL Format

Kiro's JSONL uses a `kind`-based entry format:

**Kiro entry kinds:**
- `Prompt` — User message
- `AssistantMessage` — Assistant response
- `ToolResults` — Tool execution results

**File:** `providers/kiro/index.js` (Lines 455–566)

```javascript
// FILE: providers/kiro/index.js (Lines 455-566, abbreviated)
export async function parseSessionHistory(filePath, Diff) {
  if (!fs.existsSync(filePath)) return null;

  try {
    const lines = fs.readFileSync(filePath, 'utf-8').split('\n').filter(l => l.trim());
    const entries = lines.map(l => JSON.parse(l));

    const messages = [];
    let currentAssistant = null;

    for (const entry of entries) {
      const { kind, data } = entry;

      // PROMPT: User message (LINE 468)
      if (kind === 'Prompt') {
        if (currentAssistant) {
          messages.push(currentAssistant);
          currentAssistant = null;
        }

        const textBlocks = (data.content || []).filter(b => b.kind === 'text');
        const text = textBlocks.map(b => b.data).join('\n');
        if (text) {
          messages.push({ role: 'user', content: text, id: data.message_id });
        }
      }

      // ASSISTANT MESSAGE: Assistant response (LINE 480)
      else if (kind === 'AssistantMessage') {
        if (!currentAssistant) {
          currentAssistant = {
            role: 'assistant',
            content: '',
            id: data.message_id,
            isStreaming: false,
            timeline: []
          };
        }

        for (const block of data.content || []) {
          if (block.kind === 'text') {
            if (currentAssistant.content) currentAssistant.content += '\n\n';
            currentAssistant.content += block.data;  // LINE 495: Access .data field
          } else if (block.kind === 'toolUse') {
            // LINE 496-511: Process tool use blocks
            const tool = block.data;
            const inp = tool.input || {};
            const titleArg = inp.path || inp.filePath || inp.file_path || inp.command || inp.pattern || inp.query || '';
            const title = titleArg ? `Running ${tool.name}: ${titleArg}` : `Running ${tool.name}`;

            // Generate fallback diffs for write/edit tools
            let fallbackOutput = null;
            const isWrite = ['write', 'write_file', 'strReplace', 'str_replace', 'edit'].includes(tool.name);
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
                id: tool.toolUseId,  // LINE 517: Use toolUseId field
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

      // TOOL RESULTS: Tool execution results (LINE 528)
      else if (kind === 'ToolResults') {
        if (currentAssistant && data.results) {
          // LINE 530-544: Attach results to pending tool calls
          for (const [toolUseId, resultData] of Object.entries(data.results)) {
            const toolStep = currentAssistant.timeline.find(
              t => t.type === 'tool' && t.event.id === toolUseId
            );
            if (toolStep) {
              toolStep.event.status = 'completed';
              let toolOutput = extractToolOutput(resultData);
              if (toolOutput === undefined) {
                toolOutput = toolStep.event._fallbackOutput || undefined;
              }
              toolStep.event.output = toolOutput;
            }
          }
        }
      }
    }

    // Flush final assistant message
    if (currentAssistant) messages.push(currentAssistant);

    // Cleanup fallback metadata
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
    throw new Error(`Failed to parse ${filePath}: ${err.message}`);
  }
}
```

**Key characteristics of Kiro's format:**
- Entries use `kind` field to identify type: `Prompt`, `AssistantMessage`, `ToolResults`
- Text content is stored in `block.data` field
- Tool ID is stored as `tool.toolUseId`
- Tool results are in a separate `ToolResults` entry (not embedded in user messages)

---

## Hooks — Agent-Specific Configuration

Kiro stores hooks in per-agent JSON configuration files.

**File:** `providers/kiro/index.js` (Lines 307–330)

```javascript
// FILE: providers/kiro/index.js (Lines 307-330)
const KIRO_HOOK_MAP = {
  session_start: 'agentSpawn',      // Runs when agent starts
  pre_tool: 'preToolUse',           // Runs before tool execution
  post_tool: 'postToolUse',         // Runs after tool completes
  stop: 'stop',                     // Runs when agent stops
};

export async function getHooksForAgent(agentName, hookType) {
  const nativeKey = KIRO_HOOK_MAP[hookType];
  if (!nativeKey || !agentName) return [];
  
  // LINE 321: Read agent's specific config file
  const configPath = path.join(getAgentsDir(), `${agentName}.json`);
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    
    // LINE 324: Access hooks under the native key (e.g., hooks.agentSpawn)
    const raw = config.hooks?.[nativeKey] ?? [];
    
    // LINE 325: Handle both string and object formats
    const entries = Array.isArray(raw) ? raw : [raw];
    
    // LINE 326: Map strings to command objects
    return entries.map(e => typeof e === 'string' ? { command: e } : e).filter(e => e?.command);
  } catch {
    return [];
  }
}
```

### Agent Configuration File

**Example:** `~/.kiro/agents/code-reviewer.json`

```json
{
  "name": "code-reviewer",
  "description": "Code review agent",
  "model": "claude-opus-4.6",
  "tools": ["read_file", "grep", "@AcpUI/*"],
  "allowedTools": ["read_file", "@AcpUI/*"],
  "hooks": {
    "agentSpawn": [
      { "command": "echo 'Agent starting'" }
    ],
    "preToolUse": {
      "matcher": "read_file",
      "command": "echo 'Reading file'"
    },
    "postToolUse": [
      { "command": "echo 'Tool complete'" }
    ]
  }
}
```

**Hook types are camelCase** in Kiro's configuration.

---

## Extension Methods (_kiro.dev/ prefix)

Kiro emits custom protocol events with the `_kiro.dev/` prefix. The provider's `parseExtension()` routes these:

**File:** `providers/kiro/index.js` (Lines 163–190)

```javascript
// FILE: providers/kiro/index.js (Lines 163-190)
export function parseExtension(method, params) {
  const { config } = getProvider();
  if (!method.startsWith(config.protocolPrefix)) return null;  // LINE 165: Must start with "_kiro.dev/"

  const type = method.slice(config.protocolPrefix.length);

  switch (type) {
    case 'commands/available':  // LINE 170: Slash commands
      return { type: 'commands', commands: params.commands };
    
    case 'metadata':  // LINE 172: Context usage
      return { type: 'metadata', sessionId: params.sessionId, contextUsagePercentage: params.contextUsagePercentage };
    
    case 'compaction/status':  // LINE 174: Session compaction
      return { type: 'compaction', sessionId: params.sessionId, status: params.status, summary: params.summary };
    
    case 'agent/switched':  // LINE 176: Agent switched (Kiro-specific)
      return {
        type: 'agent_switched',
        sessionId: params.sessionId,
        agentName: params.agentName,
        previousAgentName: params.previousAgentName,
        welcomeMessage: params.welcomeMessage,
        currentModelId: params.currentModelId || params.model || null  // LINE 183: May come from 'model' field
      };
    
    case 'session/update':  // LINE 185: Generic session updates
      return { type: 'session_update', ...params };
    
    default:
      return { type: 'unknown', method, params };
  }
}
```

**Kiro-unique:** `agent/switched` event fires when agents are switched (enabled by `supportsAgentSwitching: true`).

---

## setConfigOption() — Model-Only Support

Kiro only supports setting the model. Other dynamic config options are not advertised:

**File:** `providers/kiro/index.js` (Lines 371–382)

```javascript
// FILE: providers/kiro/index.js (Lines 371-382)
export async function setConfigOption(acpClient, sessionId, optionId, value) {
  if (optionId === 'model') {
    // LINE 373-376: Only model is supported
    return acpClient.transport.sendRequest('session/set_model', {
      sessionId,
      modelId: value
    });
  }

  // Kiro does not advertise dynamic config options, and session/set_mode crashes
  // current kiro-cli versions. Avoid falling through to generic config methods.
  return null;  // LINE 381: Return null for unsupported options (don't crash)
}
```

**Important:** Return `null` for unsupported options, not undefined. This prevents undefined behavior.

---

## buildSessionParams() — No _meta Injection

**File:** `providers/kiro/index.js` (Lines 367–369)

```javascript
// FILE: providers/kiro/index.js (Lines 367-369)
export function buildSessionParams(_agent) {
  return undefined;  // LINE 368: No _meta needed for Kiro
}
```

**Purpose:** Kiro doesn't use `_meta` field for session creation. Agent is set post-creation via slash command. Returns `undefined`.

---

## Component Reference

### providers/kiro/index.js

| Lines | Function | Purpose |
|-------|----------|---------|
| 15–36 | intercept() | Map agent switch notifications to currentModelId |
| 40–43 | toSnakeCase() | Convert PascalCase to snake_case |
| 49–61 | normalizeUpdate() | Convert PascalCase types and normalize content |
| 67–85 | extractToolOutput() | Extract from rawOutput.items array |
| 91–123 | extractFilePath() | Multi-step file path detection |
| 129–155 | extractDiffFromToolCall() | Extract diffs from content or rawInput |
| 163–190 | parseExtension() | Route _kiro.dev/ extensions |
| – | emitCachedContext() | Replay cached `_kiro.dev/metadata` context usage after session load or hot-resume |
| 197–205 | getSessionPaths() | Return session file paths (flat layout) |
| 210–245 | cloneSession() | Clone with pruning (simple, no subdir scanning) |
| 247–252 | deleteSessionFiles() | Delete session files |
| 254–268 | archiveSessionFiles() | Archive without metadata |
| 270–286 | restoreSessionFiles() | Restore directly (flat layout) |
| 289–303 | Path helpers | getSessionDir(), getAttachmentsDir(), getAgentsDir() |
| 307–330 | KIRO_HOOK_MAP + getHooksForAgent() | Hook lookup from agent JSON |
| 332–339 | performHandshake() | Send initialize request |
| 345–365 | setInitialAgent() | Switch agent via /agent prompt |
| 367–369 | buildSessionParams() | Return undefined |
| 488–495 | onPromptStarted() / onPromptCompleted() | Required prompt lifecycle hook exports (intentional no-op for Kiro) |
| 371–382 | setConfigOption() | Set model only |
| 389–431 | normalizeTool() | Strip MCP prefix, resolve generic IDs, format title |
| 436–450 | categorizeToolCall() | Tool categorization |
| 546–575 | extractToolInvocation() | V2 canonical tool identity extraction |
| 455–566 | parseSessionHistory() | JSONL to Unified Timeline |

### Configuration Files

| File | Purpose |
|------|---------|
| `providers/kiro/provider.json` | Provider identity, tool patterns, categories |
| `providers/kiro/branding.json` | UI text and labels |
| `providers/kiro/user.json` | Local overrides (optional) |
| `providers/kiro/README.md` | Install and agent config guide |
| `providers/kiro/ACP_PROTOCOL_SAMPLES.md` | Full captured protocol examples |

---

## Gotchas & Important Notes

### 1. toolIdPattern uses single @ symbol
Kiro's pattern is `@AcpUI/toolName` (one @ symbol). The MCP prefix detection must match this specific format.

**Avoid:** Incorrect regex patterns for MCP prefix detection.

### 2. JSONL format uses kind-based structure
Kiro entries use `kind: 'Prompt'`, `'AssistantMessage'`, `'ToolResults'`. Text is stored in `block.data`, not `block.text`.

**Avoid:** Assuming JSONL structure is consistent across all providers.

### 3. Session layout is flat
All sessions sit directly in `~/.kiro/sessions/cli/`. No subdirectory scanning is needed.

**Avoid:** Implementing complex directory scanning for session discovery.

### 4. setInitialAgent() actively switches agents
Kiro sends `/agent {name}` as a prompt to switch agents post-creation. The stream must be paused/resumed to avoid race conditions.

**Avoid:** Treating this as a no-op or missing the async stream handling.

### 5. buildSessionParams() returns undefined
Kiro doesn't use `_meta` field injection. Returns `undefined` explicitly.

**Avoid:** Assuming all providers return structured session parameters.

### 6. normalizeUpdate() is critical
Kiro's PascalCase types won't match the ACP standard without conversion. If you skip normalization, tool updates won't route correctly.

**Avoid:** Skipping normalizeUpdate() or calling it after other processing.

### 7. normalizeUpdate() also wraps string content
String content is wrapped in `{ text }` format. The original is preserved in `_originalContent`. Don't assume content is always an object.

**Avoid:** Assuming content structure is consistent; check for string vs object.

### 8. intercept() is needed for agent/switched events
Agent switch notifications include the new model, but in the `model` field. intercept() maps it to `currentModelId` so the backend can persist it.

**Avoid:** Assuming model changes are only from setConfigOption().

### 9. extractToolOutput() uses rawOutput.items array
Kiro stores output in `rawOutput.items[{ Text?, Json? }]` format with Text and Json fields.

**Avoid:** Assuming tool output follows a standard `content[]` array structure.

### 10. Hooks are per-agent in JSON files
Each agent has its own hook config in `~/.kiro/agents/{agentName}.json`.

**Avoid:** Assuming hooks are stored in a global configuration file.

### 11. Hook names are camelCase
Kiro uses `agentSpawn`, `preToolUse`, `postToolUse`, `stop` in agent configurations.

**Avoid:** Hardcoding hook names from one provider; use the hook map.

### 12. No prepareAcpEnvironment() customization needed
Kiro doesn't customize the environment. prepareAcpEnvironment() returns env unchanged.

**Avoid:** Assuming all providers need environment setup or modification.

### 13. setConfigOption() returns null for unsupported options
If an option is not 'model', return `null` (not undefined). This prevents fallthrough to generic methods that would crash.

**Avoid:** Returning undefined or throwing for unsupported options.

### 14. No restore metadata needed for flat layout
Since sessions are not scoped to projects, archiveSessionFiles() and restoreSessionFiles() don't need metadata.

**Avoid:** Assuming all providers require metadata for session restoration.

### 15. normalizeUpdate() should run before tools extract data
If update.sessionUpdate is not set, tools won't match in the timeline. Ensure normalizeUpdate() runs early in the pipeline.

**Avoid:** Processing tool updates before normalizeUpdate() is called.

---

## Existing References

- **`providers/kiro/ACP_PROTOCOL_SAMPLES.md`** — Full captured protocol with real request/response JSON examples. Load this when debugging protocol issues.
- **`providers/kiro/README.md`** — Agent configuration guide and tool permission system documentation.

---

## Unit Tests

Test files: `providers/kiro/test/index.test.js`

Run tests:
```bash
npm test -- providers/kiro
```

---

## How to Use This Guide

### For Implementing or Extending Kiro Features

1. **Start here:** Read the "Overview" section to understand Kiro's key differences (agent switching, flat layout, PascalCase normalization).
2. **Understand the flow:** Read the relevant section (e.g., "Tool Pipeline", "Session Files", "Hooks").
3. **Find the code:** Use exact line numbers to navigate to `index.js`.
4. **Check gotchas:** Review the gotchas section for edge cases specific to Kiro.
5. **Reference protocol:** For protocol details, see `ACP_PROTOCOL_SAMPLES.md`.

### For Debugging Issues with Kiro

1. **Identify the problem:** Is it about agents, tools, sessions, hooks, or normalization?
2. **Locate the function:** Use the Component Reference table to find the relevant function.
3. **Trace the code:** Jump to exact lines and follow the execution.
4. **Check data formats:** Verify JSONL format, hook config structure, and tool naming.
5. **Check for normalization:** Verify normalizeUpdate() has run for PascalCase fields.

### For Adding a New Feature

1. **Understand the contract:** Read the Provider System doc first.
2. **See how Kiro does it:** Load the relevant section in this doc.
3. **Follow the pattern:** Replicate the structure for your new feature.
4. **Test format differences:** Always test with Kiro's unique formats (flat sessions, rawOutput.items, etc.).
5. **Update hooks:** If affecting agents, ensure hook handling is provider-aware.

---

## Summary

Kiro is AcpUI's **agent-switching provider** with distinctive implementation patterns:

- **Agent switching is post-creation** — Active via `/agent` slash command with stream management
- **Flat session layout** — All sessions in a single directory with simple path construction
- **PascalCase type normalization** — Update types converted to snake_case on entry
- **Single @ MCP prefix** — Tool ID format `@AcpUI/toolName`
- **kind-based JSONL format** — Entries marked by `kind: 'Prompt'`, `'AssistantMessage'`, `'ToolResults'`
- **Per-agent hook configuration** — Each agent has its own JSON hook file
- **Hook map translation** — camelCase hook types mapped to provider implementation
- **Simple model-only config** — setConfigOption() only handles model changes

The critical contract: **Kiro demonstrates post-creation agent switching and flat session management. These patterns differ from other provider implementations.**

**When working on Kiro provider code, always load this doc alongside `[Feature Doc] - Provider System.md`.**
