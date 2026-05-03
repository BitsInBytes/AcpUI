# Feature Doc — Gemini Provider

## Overview

Gemini is implemented via the `@google/gemini-cli` npm package running in ACP (Agent Client Protocol) mode. This document is a **sidecar supplement** to `[Feature Doc] - Provider System.md` and assumes you understand the provider contract. It exists solely to show how Gemini specifically implements or deviates from that contract, with real code, line numbers, and Gemini-specific terminology.

**Load this doc alongside `[Feature Doc] - Provider System.md` when working on the Gemini provider.** This doc makes no sense in isolation.

---

## What Gemini Implements

Gemini implements all required provider contract functions:

- **intercept()** — Caches tool arguments on `tool_call`, extracts Context Usage Percentage on `end_turn`, triggers OAuth quota fetching, and actively **swallows** the native Gemini `usage_update` event to prevent wild UI percentage swings.
- **normalizeUpdate()** — Strips `<system-reminder>` XML tags from message chunks and trims leading/trailing whitespace.
- **extractToolOutput()** — Multi-stage lookup for tool output. Fixes `read_file` by reading from disk directly. Reconstructs dropped structured outputs (like `list_directory`) using cached arguments.
- **extractFilePath()** — Fallback chain to find paths in `locations` arrays, `content` arrays, and parsed JSON `arguments`.
- **extractDiffFromToolCall()** — Extracts unified diffs or raw text from write/edit operations so they are syntax-highlighted in the UI immediately.
- **normalizeTool()** — Maps raw ACP `kind` enums (`read`, `edit`, `search`) to UI tool categories. Synthesizes human-readable titles when missing and appends target paths for visibility.
- **categorizeToolCall()** — Maps Gemini's standardized tool names to UI categories (`file_read`, `shell`, etc.).
- **parseExtension()** — Routes Gemini's protocol extensions (e.g. `metadata` for Context % and `provider_status` for Quota %).
- **prepareAcpEnvironment()** — Initializes background OAuth Quota fetching if enabled in `user.json`.
- **performHandshake()** — Sends `initialize` (intentionally omitting `fs` capabilities to avoid proxy hangs) and `authenticate` (supporting both API Key and OAuth flows) in parallel.
- **setConfigOption()** — Routes `mode` and `model` changes to their respective ACP endpoints.
- **Session file operations** — `getSessionPaths()`, `cloneSession()`, `archiveSessionFiles()`, `restoreSessionFiles()`, `deleteSessionFiles()`. Handles Gemini's project-hashed subdirectory layout.
- **parseSessionHistory()** — Reconstructs the Unified Timeline from Gemini's JSONL format, correctly applying `$rewindTo` truncations and extracting nested `tool_use` blocks.
- **Context Debug Logging** — Maintains `context_debug.log` (Line 11) to track token flow, prompt starts, and quota refreshes.
- **Smart Polling** — Controls background quota polling using `_activePromptCount` (Line 29) and `_inFlightSessions` (Line 30) to only poll when work is actually being done.

### Gemini-Unique Characteristics

| Aspect | Gemini | General Pattern |
|--------|--------|-----------------|
| **Context & Quota** | Extracted from `_meta.quota` on `end_turn`; OAuth fetched directly from Google APIs | Varies |
| **Session Layout** | Project-scoped subdirectories `~/.gemini/tmp/<project-hash>/chats/` | Varies; may be flat |
| **Tool ID Pattern** | `mcp_{mcpName}_{toolName}` (SINGLE underscore) | Varies by MCP registration |
| **Tool Output Drops** | CLI aggressively summarizes or drops structured tool outputs to save tokens; Provider reconstructs them manually | Varies |
| **History Rewinds** | Emits `$rewindTo` entries in JSONL instead of rewriting history | Varies |
| **Handshake** | `initialize` and `authenticate` MUST be sent in parallel | Varies |

---

## How Gemini Starts — Handshake Flow

### Step 1: prepareAcpEnvironment()

Before the Gemini CLI is spawned, `prepareAcpEnvironment()` initializes the background quota fetching system (if enabled).

**File:** `providers/gemini/index.js` (Lines 610-631)

```javascript
export async function prepareAcpEnvironment(env, context = {}) {
  logContext('PREPARE_ACP_ENVIRONMENT', { ... }); // LINE 611
  _emitProviderExtension = context.emitProviderExtension;
  _writeLog = context.writeLog;

  // Do NOT inject the API key as GEMINI_API_KEY into the subprocess environment.
  // ...
  
  const { config } = getProvider();
  const apiKey = resolveApiKey();

  if (!apiKey && config.fetchQuotaStatus) {
    _startQuotaFetching(config.paths.home).catch(err =>
      _writeLog?.(`[GEMINI QUOTA] Init failed: ${err.message}`)
    );
  }

  return env;
}
```

### Step 2: performHandshake()

Once the subprocess is running, the provider performs the ACP handshake. 

**File:** `providers/gemini/index.js` (Lines 1022-1052)

```javascript
export async function performHandshake(acpClient) {
  const { config } = getProvider();
  
  // Do NOT claim `fs` capability to prevent Gemini CLI from routing FS calls 
  // to AcpUI via JSON-RPC, which stalls indefinitely.
  const initPromise = acpClient.transport.sendRequest('initialize', {
    protocolVersion: 1,
    clientCapabilities: { terminal: true },
    clientInfo: config.clientInfo || { name: 'AcpUI', version: '1.0.0' }
  });

  const apiKey = resolveApiKey();

  const authPromise = apiKey
    ? acpClient.transport.sendRequest('authenticate', {
        methodId: 'gemini-api-key',
        _meta: { 'api-key': apiKey },
      })
    : acpClient.transport.sendRequest('authenticate', {
        methodId: 'oauth-personal',
      });

  // Both must be sent in parallel. Gemini holds initialize response until authenticate arrives.
  await Promise.all([initPromise, authPromise]);
}
```

---

## Tool Pipeline — Reconstructing Dropped Outputs

The Gemini CLI aggressively summarizes or drops structured tool outputs (like directory listings or search results) to save context tokens. The AcpUI provider actively combats this to ensure the user sees accurate data.

### 1. Argument Caching (intercept)

**File:** `providers/gemini/index.js` (Lines 94-99)

When a `tool_call` starts, its exact arguments are cached:

```javascript
    // Cache arguments when a tool starts so we can reconstruct dropped outputs
    if (payload.params?.update?.sessionUpdate === 'tool_call') {
      const update = payload.params.update;
      if (update.toolCallId && (update.arguments || update.rawInput)) {
        toolArgCache.set(update.toolCallId, update.arguments || update.rawInput);
      }
    }
```

### 2. Output Reconstruction (extractToolOutput)

**File:** `providers/gemini/index.js` (Lines 248-294)

When the tool completes, if the output is missing or heavily summarized (e.g. `"Found 10 matching file(s)"`), the provider uses the cached arguments to manually execute the command on the backend and return the real output to the UI.

```javascript
  // 6. Fix for Gemini list_directory returning no output
  if (update.status === 'completed' && update.toolCallId?.startsWith('list_directory')) {
    if (!raw || (Array.isArray(raw) && raw.length === 0)) {
       const argsRaw = toolArgCache.get(update.toolCallId) || {};
       const args = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : argsRaw;
       // ... extracts dirPath, resolves absolute path, runs fs.readdirSync ...
       return files.length > 0 ? files.join('\n') : '(empty directory)';
    }
  }
  
  // 7. Fix for empty search outputs
  if (update.status === 'completed' && (!raw || (Array.isArray(raw) && raw.length === 0))) {
     if (update.toolCallId?.startsWith('grep_search') || update.toolCallId?.startsWith('glob')) {
         return 'No matches found.';
     }
  }
```

### 3. File Read Fixing

**File:** `providers/gemini/index.js` (Lines 170-202)

Gemini's `read_file` often returns a summary instead of the actual file contents. The provider intercepts this and reads the file directly from disk.

```javascript
  // Fix for Gemini read_file returning only a summary string instead of file contents
  if (update.status === 'completed' && update.toolCallId?.startsWith('read_file')) {
    let filePath = update.locations?.[0]?.path;
    if (filePath && fs.existsSync(filePath)) {
        let content = fs.readFileSync(filePath, 'utf-8');
        // ... extracts summary to find requested line ranges, slices content ...
        return stripReminder(content);
    }
  }
```

---

## Context % and Quota Tracking

Gemini provides rich metadata in every prompt response that powers the UI footer and status panel.

### 1. Swallowing Native Usage Updates

**File:** `providers/gemini/index.js` (Lines 83-91)

The Gemini CLI emits unstable mid-stream `usage_update` events with arbitrary sizes, causing the UI context percentage to wildly inflate (e.g. 1370%). The provider **swallows these completely** and logs them to `context_debug.log`.

```javascript
      // Log usage_update events to understand the token flow
      if (update?.sessionUpdate === 'usage_update') {
        logContext('USAGE_UPDATE', { ... }); // LINE 84
        return null;
      }
```

### 2. Emitting Context %

**File:** `providers/gemini/index.js` (Lines 111-155)

Instead of the native event, the true context usage is calculated at `end_turn` from the `_meta.quota.token_count` field against a hardcoded context window.

```javascript
    if (payload?.result?.stopReason) {
      // ...
      if (payload.result?._meta?.quota && sessionId) {
        const quota = payload.result._meta.quota;
        // ...
        const percent = (inputTokens / windowSize) * 100;
        
        if (_emitProviderExtension) {
          _sessionContextInfo.set(sessionId, { percent, inputTokens, windowSize, model });
          _emitProviderExtension(`${config.protocolPrefix}metadata`, {
            sessionId,
            contextUsagePercentage: percent
          });
        }
```

### 3. OAuth Quota Fetching

If enabled via `fetchQuotaStatus: true` in `user.json`, the provider communicates with Google APIs to show remaining API quota in the Provider Status panel.

**Files:** `providers/gemini/index.js` (Lines 1056-1375)

The quota-fetching system uses **reactive 401-based token refresh** and emits status immediately on startup:

1. **Startup**: `_startQuotaFetching()` (Line 1215) is called from `prepareAcpEnvironment()`. It:
   - Discovers the user's `cloudaicompanionProject` ID via `loadCodeAssist`.
   - Immediately emits initial status using `emitInitial: true`.
   - Sets up a 30-second polling timer that only runs when `_activePromptCount > 0`.

2. **Client ID Derivation**: The OAuth client ID is **derived at runtime** from the `azp` field of the JWT `id_token` in `oauth_creds.json` via `_extractClientId()` (Line 1076). The **client secret** is hardcoded (Line 1074).

3. **Reactive Token Refresh** (on 401): `_fetchAndEmitQuota()` (Line 1256):
   - Attempts the quota request via `_requestQuota()` (Line 1102).
   - **On 401**: Re-reads token from disk, retries.
   - **On 401 again**: Calls `_refreshAndSaveToken()` (Line 1118), writes to disk, retries.
   - Emits status to UI via `_emitStatus()` (Line 1367).

---

## Session Files — Hashed Project Layout

Gemini stores sessions in project-scoped subdirectories, similar to Claude, but deeply nested under `chats/`.

### Layout

```
~/.gemini/tmp/
├── {project-hash}/
│   ├── chats/
│   │   ├── session-{timestamp}-{shortId}.jsonl
│   │   └── session-{timestamp}-{shortId}.json
│   └── ...
```

### `getShortId` and `findSessionDir`

**File:** `providers/gemini/index.js` (Lines 660-696)

Gemini uses only the first 8 characters of the UUID to name files.

```javascript
function getShortId(acpId) {
  return acpId.split('-')[0] || acpId;  // Extracts "a1b2c3d4" from "a1b2c3d4-..."
}
```

---

## JSONL History parsing & `$rewindTo`

**File:** `providers/gemini/index.js` (Lines 836-965)

Unlike other providers, Gemini does not physically truncate the JSONL file when a user rewinds history. Instead, it appends a `$rewindTo` record. The `parseSessionHistory` function must apply these rewinds sequentially before generating the final message array.

---

## Component Reference

| Lines | Function | Purpose |
|-------|----------|---------|
| 11–22 | logContext() | JSONL logging to `context_debug.log`. |
| 53–158 | intercept() | Emit context %, trigger quota fetch, cache tool args, track active prompts. |
| 163–185 | normalizeUpdate() | Strips `<system-reminder>` XML tags. |
| 205–302 | extractToolOutput() | Extracts from `result` / `content`, fixes `read_file` disk reads, reconstructions. |
| 314–343 | extractFilePath() | Extracts file paths from locations, content arrays, or parsed JSON args. |
| 355–385 | extractDiffFromToolCall() | Pulls unified diff patches from Write/Edit tools for live rendering. |
| 413–487 | normalizeTool() | Maps `kind` enums, synthesizes titles, strips MCP prefixes. |
| 492–513 | categorizeToolCall() | Routes AcpUI MCP tools and standard categories. |
| 515–534 | parseExtension() | Maps `{prefix}metadata` and `{prefix}provider/status`. |
| 610-631 | prepareAcpEnvironment() | Bootstraps background quota polling if allowed. |
| 660–696 | findSessionDir() / getShortId() | Resolves Gemini's deep project-hash directory structure. |
| 732–809 | cloneSession() | Truncates user turns and copies files into the same project dir. |
| 818–841 | archiveSessionFiles() | Archives session and saves absolute directory to `restore_meta.json`. |
| 894–1013 | parseSessionHistory() | Rebuilds timeline, applying `$rewindTo` and unpacking nested tool calls. |
| 1022–1052 | performHandshake() | Sends parallel init + auth, explicitly excluding `fs` capability. |
| 1076–1086 | _extractClientId() | Parses `id_token` JWT and extracts `azp` field for OAuth client ID. |
| 1088–1096 | _readTokenFromDisk() | Reads access token from `oauth_creds.json`. |
| 1102-1116 | _requestQuota() | Makes HTTP POST to retrieveUserQuota endpoint. |
| 1118–1166 | _refreshAndSaveToken() | Refreshes expired token using derived client_id + hardcoded secret; saves to disk. |
| 1168–1173 | stopQuotaFetching() | Clears polling timer (for cleanup/shutdown). |
| 1215–1254 | _startQuotaFetching() | Bootstrap: discover project ID, emit initial status, start 30s polling timer. |
| 1256–1293 | _fetchAndEmitQuota() | Reactive 401 fetch: read token, try request, refresh on 401, build/cache/emit status. |
| 1295–1365 | _buildStatus() | Build provider_status extension with formatted quota buckets. |
| 1367-1372 | _emitStatus() | Emits the latest cached status to the UI. |

---

## Gotchas & Important Notes

1. **`initialize` and `authenticate` MUST be parallel**
   Gemini CLI holds the `initialize` request indefinitely until `authenticate` is sent. Awaiting them sequentially will cause a permanent stall.
2. **Never claim `fs` client capability**
   If `fs` is claimed in `initialize`, Gemini will proxy every internal file read through JSON-RPC to AcpUI. AcpUI does not have listeners for this, resulting in a permanent stall on file operations.
3. **Session IDs are truncated**
   Gemini uses only the first 8 characters of a session UUID (e.g. `session-timestamp-a1b2c3d4.jsonl`). A standard `.split('-').pop()` will return the wrong segment. Use `.split('-')[0]`.
4. **Beware native `usage_update` events**
   The CLI emits intermediate chunk usage updates that wildly misrepresent the context window. They must be swallowed in `intercept()`.
5. **JSONL append-only history**
   Editing history in Gemini does not delete old JSONL lines; it appends a `$rewindTo` line. Your history parser must honor rewinds to avoid rendering ghost messages.
6. **Dropped Tool Outputs**
   Tools like `list_directory` will often complete successfully but return an empty `content` array to save tokens. AcpUI uses `toolArgCache` and `fs.readdirSync` to bypass this manually.
7. **API Key injection destroys OAuth**
   Never inject `GEMINI_API_KEY` into the subprocess `process.env`. If the CLI detects this, it permanently writes it to `~/.gemini/settings.json`, destroying the user's OAuth tokens. Pass the key explicitly via `_meta` in `authenticate`.
8. **OAuth client ID is derived from `id_token`, secret is hardcoded**
   The OAuth `client_id` is extracted at runtime from the `azp` field of the JWT `id_token` in `oauth_creds.json` via `_extractClientId()`. This adapts automatically if the Gemini CLI changes its OAuth client. The `client_secret` is hardcoded (intentionally — Google's installed-app OAuth pattern permits this). If token refresh silently stops working, verify that `oauth_creds.json` exists and contains valid `id_token` and `refresh_token` fields.
9. **Status emits immediately on startup with `emitInitial: true`**
   Unlike previous versions that waited for a session to activate, quota status now emits as soon as the Provider Status panel is available, using the `emitInitial` flag. This ensures users see quota data even before starting a conversation.
10. **Reactive 401-based token refresh (Codex pattern)**
   Token refresh is no longer proactive (checking `expiry_date` before each request). Instead, the provider tries the request first. If it gets a 401, it re-reads the token from disk (another process may have refreshed it), retries, and only if that fails does it refresh and save new credentials. This is more efficient and aligns with Codex's approach.
11. **Context Debug Log**
    A `context_debug.log` file is created in the provider directory. If you experience unexpected progress bar behavior, check this log for `INTERCEPT_CALLED`, `PROMPT_START`, and `SESSION_COMPLETED` events.
12. **Smart Polling Timer**
    Polling only occurs when `_activePromptCount > 0`. If no sessions are active, the polling timer is stopped to save battery and network bandwidth.
