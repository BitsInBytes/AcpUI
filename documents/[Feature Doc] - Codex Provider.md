# Codex Provider

The Codex provider integrates AcpUI with the `codex-acp` daemon. It owns Codex-specific startup, authentication, quota status, dynamic model/config handling, rollout JSONL lifecycle, context replay, and MCP tool normalization.

This doc matters because Codex exposes models, config options, tools, quota, and saved history through several protocol shapes. The provider normalizes those shapes before generic AcpUI backend and frontend code consume them.

## Overview

### What It Does

- Starts `codex-acp` from provider config and performs ACP `initialize`.
- Sends optional `authenticate` requests from `authMethod`, provider API-key fields, and environment keys.
- Prepares child-process environment values including `CODEX_API_KEY`, `OPENAI_API_KEY`, and `NO_BROWSER`.
- Captures dynamic model catalogs from ACP responses and Codex config-option updates.
- Filters Codex's `model` config option while keeping `reasoning_effort` as a provider setting.
- Converts Codex command updates into `_codex/commands/available` slash-command extensions.
- Normalizes Codex built-in tools, core AcpUI MCP tools, optional IO MCP tools, and optional Google search MCP tools.
- Suppresses native Codex `ws_` web-search artifacts when they carry no query, output, or content.
- Manages Codex rollout JSONL files for fork, archive, restore, delete, and rehydration.
- Fetches quota status from saved ChatGPT OAuth credentials and emits `_codex/provider/status`.
- Persists context usage in `acp_session_context.json` and replays it through `_codex/metadata`.
- Emits Codex MCP timeout metadata only when `acpSupportsMcpTimeouts` is enabled.

### Why This Matters

- Codex model data is dynamic, so model catalogs and provider config options must stay separated.
- Codex rollout files are recursive and schema-rich, so cloning and parsing are provider-owned.
- Codex MCP tool IDs use `AcpUI/<toolName>`, while backend Tool System V2 expects canonical names such as `ux_invoke_shell` and `ux_read_file`.
- Optional IO/Search MCP tool categories come from shared AcpUI tool registry handlers, while the provider extracts identity and input from Codex payloads.
- Codex can emit native `ws_` web-search updates with no visible query or output; the provider filters those artifacts before they become timeline tools.
- Quota status depends on `paths.home/auth.json`, not on ACP session state.
- Context usage needs a provider cache because a loaded or hot-resumed session can render before fresh `usage_update` events arrive.

Architectural role: provider-specific backend adapter for Codex ACP, integrated through provider loader, ACP update handling, MCP proxy, Tool System V2, SQLite session persistence, and frontend Unified Timeline rendering.

## How It Works - End-to-End Flow

1. **Provider registration loads Codex config**

   File: `providers/codex/provider.json` (Config keys: `protocolPrefix`, `mcpName`, `toolIdPattern`, `toolCategories`, `clientInfo`)

   ```json
   {
     "name": "Codex",
     "protocolPrefix": "_codex/",
     "mcpName": "AcpUI",
     "toolIdPattern": "{mcpName}/{toolName}",
     "clientInfo": { "name": "AcpUI", "version": "1.0.0" }
   }
   ```

   `backend/services/providerLoader.js` loads `provider.json`, `branding.json`, and local `user.json`, then imports `providers/codex/index.js` through `getProviderModule()`.

2. **Environment prep configures the daemon process**

   File: `providers/codex/index.js` (Function: `prepareAcpEnvironment`)

   `prepareAcpEnvironment()` copies the backend environment, injects Codex/OpenAI API keys, sets `NO_BROWSER=1` when `noBrowser` is true, stores provider-extension/log callbacks, loads `acp_session_context.json`, and starts an initial quota fetch when `fetchQuotaStatus` is enabled.

   ```javascript
   // FILE: providers/codex/index.js (Function: prepareAcpEnvironment)
   if (config.codexApiKey) next.CODEX_API_KEY = config.codexApiKey;
   if (config.openaiApiKey) next.OPENAI_API_KEY = config.openaiApiKey;
   if (config.apiKey) {
     const keyName = config.apiKeyEnv === 'OPENAI_API_KEY' ? 'OPENAI_API_KEY' : 'CODEX_API_KEY';
     next[keyName] = config.apiKey;
   }
   if (config.noBrowser === true) next.NO_BROWSER = '1';
   ```

3. **Handshake initializes Codex ACP and authenticates when configured**

   File: `providers/codex/index.js` (Functions: `performHandshake`, `resolveAuthMethod`)

   `performHandshake()` sends `initialize` with protocol version `1`, `clientCapabilities.terminal=true`, and `clientInfo` from provider config. It then sends `authenticate` when `resolveAuthMethod()` returns `chatgpt`, `codex-api-key`, or `openai-api-key`.

   ```javascript
   // FILE: providers/codex/index.js (Function: performHandshake)
   await acpClient.transport.sendRequest('initialize', {
     protocolVersion: 1,
     clientCapabilities: { terminal: true },
     clientInfo: config.clientInfo || { name: 'AcpUI', version: '1.0.0' }
   });
   const auth = resolveAuthMethod(config);
   if (auth) await acpClient.transport.sendRequest('authenticate', auth);
   ```

4. **Session creation injects the AcpUI MCP proxy**

   File: `backend/mcp/mcpServer.js` (Function: `getMcpServers`)
   File: `providers/codex/index.js` (Functions: `buildSessionParams`, `getMcpServerMeta`)

   `buildSessionParams()` returns `undefined`, so Codex receives the generic `session/new` or `session/load` payload plus the MCP server entry. `getMcpServers()` names the stdio proxy from `mcpName`, binds provider/session context with `ACP_UI_MCP_PROXY_ID`, and appends provider `_meta` when `getMcpServerMeta()` returns timeout data.

5. **Model and config state are normalized separately**

   File: `providers/codex/index.js` (Functions: `normalizeModelState`, `normalizeConfigOptions`, `intercept`)
   File: `backend/sockets/sessionHandlers.js` (Function: `captureModelState`)
   File: `backend/services/acpUpdateHandler.js` (Function: `handleUpdate`)

   `normalizeModelState()` deduplicates model options, preserves slash-qualified model IDs, augments model options from the Codex `model` select option, and sets `replaceModelOptions: true`. `normalizeConfigOptions()` removes `model` and marks `reasoning_effort` / `effort` with `kind: "reasoning_effort"`.

   `intercept()` rewrites Codex `config_option_update` notifications into `_codex/config_options` provider extensions containing `options`, `modelOptions`, `replace`, and `removeOptionIds`.

6. **Command updates become slash commands**

   File: `providers/codex/index.js` (Functions: `intercept`, `normalizeCommands`, `parseExtension`)

   Codex emits command names without requiring a slash. The provider converts them into `_codex/commands/available` and prefixes command names for the UI.

   ```javascript
   // FILE: providers/codex/index.js (Function: normalizeCommands)
   return commands.map(command => ({
     name: command.name.startsWith('/') ? command.name : `/${command.name}`,
     description: command.description || '',
     ...(command.input?.hint ? { meta: { hint: command.input.hint } } : {})
   }));
   ```

7. **Quota status is provider-owned**

   File: `providers/codex/index.js` (Functions: `fetchCodexQuota`, `refreshCodexOAuthToken`, `buildCodexProviderStatus`, `fetchAndEmitQuota`, `onPromptStarted`, `onPromptCompleted`, `stopQuotaFetching`)

   `fetchCodexQuota()` reads `auth.json` under `paths.home`, sends OAuth bearer headers to `quotaStatusEndpoint` or the default ChatGPT usage endpoint, and retries after OAuth refresh when a `401` response arrives and `refreshQuotaOAuth` is enabled. `refreshCodexOAuthToken()` derives `client_id` from the access-token JWT payload and writes refreshed tokens back to `auth.json`.

   `onPromptStarted()` starts interval polling while prompts are active. `onPromptCompleted()` stops polling when no prompt remains active and triggers a turn-complete quota refresh.

8. **Context usage is cached and replayed**

   File: `providers/codex/index.js` (Functions: `intercept`, `_loadContextState`, `_saveContextState`, `emitCachedContext`)

   `intercept()` watches `usage_update`, calculates `(used / size) * 100`, stores the percentage by session ID, and persists the map to `paths.home/acp_session_context.json`. `emitCachedContext(sessionId)` emits `_codex/metadata` with `contextUsagePercentage` once per session when cached data exists.

9. **Tool calls become canonical Tool System V2 invocations**

   File: `providers/codex/index.js` (Functions: `normalizeTool`, `extractToolInvocation`, `categorizeToolCall`, `extractToolOutput`, `extractFilePath`, `extractDiffFromToolCall`)
   File: `backend/services/tools/toolInvocationResolver.js` (Functions: `resolveToolInvocation`, `applyInvocationToEvent`)
   File: `backend/services/tools/providerToolNormalization.js` (Functions: `mcpInvocationFromRaw`, `inputFromToolUpdate`, `resolvePatternToolName`, `commandFromRawInput`)

   Codex titles AcpUI MCP tools as `Tool: AcpUI/<toolName>` and can include raw invocation data in `rawInput.invocation`. The provider extracts canonical name, MCP server, MCP tool name, input, title, file path, output, and category.

   ```javascript
   // FILE: providers/codex/index.js (Function: extractToolInvocation)
   return {
     toolCallId: update.toolCallId || event.id,
     kind: invocation.server || invocation.tool ? 'mcp' : (canonicalName ? 'provider_builtin' : 'unknown'),
     rawName,
     canonicalName,
     mcpServer: invocation.server,
     mcpToolName: invocation.tool,
     input,
     title: normalized.title || update.title || event.title,
     filePath: normalized.filePath,
     category: categorizeToolCall({ ...normalized, toolName: canonicalName }) || {}
   };
   ```

10. **MCP handler execution metadata wins when available**

    File: `backend/mcp/mcpServer.js` (Functions: `createToolHandlers`, `wrapToolHandlers`)
    File: `backend/services/tools/mcpExecutionRegistry.js` (Functions: `begin`, `complete`, `fail`, `describeAcpUxToolExecution`, `invocationFromMcpExecution`)
    File: `backend/services/tools/handlers/ioToolHandler.js` (Handlers: `onStart`, `onUpdate`, `onEnd`)

    `wrapToolHandlers()` records public MCP tool input in `mcpExecutionRegistry.begin()`, completes/fails the record after handler execution, and lets `resolveToolInvocation()` prefer handler-known title/category/file metadata over generic provider titles.

    Shared AcpUI title behavior comes from `backend/services/tools/acpUiToolTitles.js` (`acpUiToolTitle`, `subAgentCheckToolTitle`) and `backend/services/tools/acpUxTools.js` (`ACP_UX_IO_TOOL_CONFIG`):

    | Tool | Title pattern | Category source |
    |---|---|---|
    | `ux_read_file` | `Read File: <basename>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_write_file` | `Write File: <basename>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_replace` | `Replace In File: <basename>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_list_directory` | `List Directory: <dir_path>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_glob` | `Glob: <description or pattern>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_grep_search` | `Search: <description or pattern>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_web_fetch` | `Fetch: <url>` | `ACP_UX_IO_TOOL_CONFIG` |
    | `ux_google_web_search` | `Web Search: <query>` | `ACP_UX_IO_TOOL_CONFIG` |

11. **Rollout files drive session-file lifecycle**

    File: `providers/codex/index.js` (Functions: `getSessionPaths`, `cloneSession`, `deleteSessionFiles`, `archiveSessionFiles`, `restoreSessionFiles`)

    `getSessionPaths()` searches session roots recursively for a JSONL filename containing the session ID, then by file content. The configured `paths.sessions` root is searched first; when it is nested under `paths.home/sessions`, the canonical `paths.home/sessions` root is searched as a fallback before `<sessionId>.jsonl` under the configured sessions directory is returned. `cloneSession()` copies the rollout, companion JSON file, and task directory; it replaces the old session ID with the fork ID and prunes at whole turn boundaries when `pruneAtTurn` is provided. `archiveSessionFiles()` writes `restore_meta.json`, copies active files into the archive, and removes the active copies. `restoreSessionFiles()` restores files from archive metadata.

12. **History parsing creates Unified Timeline messages**

    File: `providers/codex/index.js` (Functions: `parseSessionHistory`, `handleEventMsg`, `handleResponseItem`, `resetFromCompactedRecord`)

    `parseSessionHistory()` reads Codex JSONL records and returns AcpUI messages. It handles `event_msg` records such as `user_message`, `agent_message`, `agent_reasoning`, `exec_command_begin`, `exec_command_end`, `mcp_tool_call_begin`, `mcp_tool_call_end`, `web_search_begin`, `web_search_end`, `patch_apply_begin`, and `patch_apply_end`. It handles `response_item` records such as `message`, `reasoning`, `function_call`, `function_call_output`, `custom_tool_call`, and `custom_tool_call_output`. `compacted` records replace prior history with user messages from `replacement_history`.

## Architecture Diagram

```mermaid
flowchart TB
  Config[providers/codex config/docs] --> Loader[providerLoader\ngetProvider/getProviderModule]
  Loader --> Provider[providers/codex/index.js]
  Provider --> Env[prepareAcpEnvironment]
  Provider --> Handshake[performHandshake]
  Env --> Daemon[codex-acp]
  Handshake --> Daemon
  Daemon --> Client[acpClient\nhandleAcpMessage]
  Client --> Intercept[intercept]
  Intercept --> Updates[acpUpdateHandler\nhandleUpdate]
  Updates --> Resolver[toolInvocationResolver]
  Resolver --> Registry[toolRegistry + handlers]
  Registry --> Events[Socket.IO system_event]
  Updates --> Extensions[provider_extension]
  Events --> UI[Unified Timeline]
  Extensions --> UI
  Provider --> Rollouts[paths.sessions JSONL]
  Provider --> Context[paths.home/acp_session_context.json]
  Provider --> Quota[paths.home/auth.json + quota endpoint]
  Registry --> McpApi[/api/mcp/tool-call]
```

## The Critical Contract

### Contract: Codex Normalization Before Generic Emission

1. `providers/codex/provider.json` must keep `protocolPrefix: "_codex/"`, `mcpName: "AcpUI"`, and `toolIdPattern: "{mcpName}/{toolName}"` aligned with Codex MCP titles and raw invocations.
2. `providers/codex/index.js` must explicitly export every provider contract function required by `backend/test/providerContract.test.js`.
3. `intercept()` must return rewritten extension payloads, return `null` only to swallow a message, and return the original payload for pass-through messages.
4. `normalizeConfigOptions()` must remove `model`; model choices flow through model state and `modelOptions`.
5. `normalizeModelState()` must preserve full Codex model IDs and set `replaceModelOptions: true`.
6. `setConfigOption()` must route `mode` to `session/set_mode`, `model` to `session/set_model`, and generic options to `session/set_config_option` with raw string values.
7. `extractToolInvocation()` must return stable identity fields so `toolInvocationResolver` can mark AcpUI MCP tools, merge sticky metadata, and dispatch tool handlers.
8. `parseSessionHistory()` must treat rollout JSONL as mixed `event_msg`, `response_item`, and `compacted` records while preserving turn boundaries.
9. `getMcpServerMeta()` must return `undefined` unless `acpSupportsMcpTimeouts` is exactly `true` and at least one positive timeout exists.
10. Native `ws_` web-search updates with no visible query/output/content must be swallowed live and replayed as no-ops; AcpUI MCP search calls must still pass through.

Breaking this contract causes duplicated model controls, missing slash commands, generic tool titles, missing shell/sub-agent panels, blank native web-search rows, lost context usage, broken quota status, or malformed replayed timelines.

## Configuration / Provider-Specific Behavior

### Provider Directory Files

| File | Anchors | Purpose |
|---|---|---|
| `providers/codex/provider.json` | `name`, `protocolPrefix`, `mcpName`, `toolIdPattern`, `toolCategories`, `clientInfo` | Provider identity, extension prefix, MCP tool ID format, built-in/core tool categories. |
| `providers/codex/branding.json` | `title`, `assistantName`, `busyText`, `inputPlaceholder`, `modelLabel`, `maxImageDimension` | Codex UI branding payload. |
| `providers/codex/user.json.example` | `command`, `args`, `authMethod`, `fetchQuotaStatus`, `refreshQuotaOAuth`, `quotaStatusIntervalMs`, `defaultSubAgentName`, `paths`, `models`, `acpSupportsMcpTimeouts` | Local deployment config template. |
| `providers/codex/README.md` | `Authentication`, `Quota Status`, `Context Usage Persistence`, `Configuring Agents and Tool Permissions`, `MCP Tools`, `Session Files`, `Tests` | Human setup and operation guide. |
| `providers/codex/ACP_PROTOCOL_SAMPLES.md` | `initialize`, `authenticate`, `session/new`, `available_commands_update`, `set_model`, `set_mode`, `set_config_option`, `Tool Calls` | Codex ACP protocol shapes the provider normalizes. |
| `providers/codex/index.js` | Provider contract exports | Runtime behavior, normalization, quota, context, session file lifecycle, and replay parsing. |

### Important Config Keys

| Config key | Runtime behavior |
|---|---|
| `command`, `args` | Spawn command for `codex-acp`. |
| `authMethod` | Selects `chatgpt`, `codex-api-key`, `openai-api-key`, `auto`, or disabled auth behavior. |
| `codexApiKey`, `openaiApiKey`, `apiKey`, `apiKeyEnv` | Controls API-key environment injection and auto-auth method selection. |
| `noBrowser` | Adds `NO_BROWSER=1` to the child process environment. |
| `fetchQuotaStatus` | Enables startup quota fetch and prompt-scoped polling. |
| `refreshQuotaOAuth` | Allows OAuth refresh after quota endpoint `401` responses. |
| `quotaStatusIntervalMs` | Poll interval while prompts are in flight; `0` disables interval polling. |
| `quotaStatusEndpoint`, `quotaOAuthRefreshEndpoint` | Override quota and OAuth refresh endpoints. |
| `paths.home` | Location of `auth.json` and `acp_session_context.json`. |
| `paths.sessions` | Primary recursive rollout JSONL search root; nested roots under `paths.home/sessions` also allow fallback search of `paths.home/sessions`. |
| `paths.agents`, `paths.attachments`, `paths.archive` | Codex agents, attachment, and archive directories. |
| `models.default`, `models.quickAccess`, `models.titleGeneration`, `models.subAgent` | Provider model defaults and AcpUI quick-select options. |
| `acpSupportsMcpTimeouts`, `acpMcpStartupTimeoutSec`, `acpMcpToolTimeoutSec` | Controls `_meta.codex_acp` timeout overrides. |

### MCP Tool Availability

AcpUI MCP tools are controlled by `configuration/mcp.json` or the file referenced by `MCP_CONFIG`.

- Core tools: `ux_invoke_shell`, `ux_invoke_subagents`, `ux_check_subagents`, `ux_abort_subagents`, `ux_invoke_counsel`.
- Optional IO tools: `ux_read_file`, `ux_write_file`, `ux_replace`, `ux_list_directory`, `ux_glob`, `ux_grep_search`, `ux_web_fetch`.
- Optional Google search tool: `ux_google_web_search`.

Codex sees enabled tools through the `AcpUI` MCP stdio server. The provider extracts identity from `AcpUI/<toolName>` titles and `rawInput.invocation`; backend handlers record authoritative titles and categories for enabled tools. Codex display titles use `Run Subagents` for `ux_invoke_subagents`, `Check Subagents: Waiting for agents to finish` for default `ux_check_subagents`, `Check Subagents: Quick status check` when `waitForCompletion: false`, `Abort Subagents` for `ux_abort_subagents`, and `Run Counsel` for `ux_invoke_counsel`. `ux_invoke_subagents` and `ux_invoke_counsel` return after spawn and include instructions to call `ux_check_subagents` for status/results or `ux_abort_subagents` to stop running agents; pass `waitForCompletion: false` to check status without waiting.

## Data Flow / Rendering Pipeline

### Model and Config Flow

```text
Codex session/new or session/load response
  -> backend/sockets/sessionHandlers.js captureModelState
  -> providers/codex/index.js normalizeModelState
  -> model selector receives currentModelId + modelOptions
  -> providers/codex/index.js normalizeConfigOptions
  -> provider settings receive non-model options
```

Config extension flow:

```text
Codex session/update config_option_update
  -> providers/codex/index.js intercept
  -> _codex/config_options provider extension
  -> backend/services/acpClient.js handleProviderExtension
  -> DB config option persistence + frontend provider_extension
```

### Tool Invocation Flow

```text
Codex tool_call / tool_call_update
  -> providers/codex/index.js intercept (drops empty native ws_ web-search artifacts)
  -> backend/services/acpUpdateHandler.js handleUpdate
  -> providers/codex/index.js normalizeTool + extractToolInvocation
  -> backend/services/tools/toolInvocationResolver.js resolveToolInvocation
  -> backend/services/tools/toolRegistry dispatch
  -> backend/services/tools/handlers/* apply metadata
  -> Socket.IO system_event
  -> frontend ToolStep
```

Canonical provider extraction shape:

```javascript
{
  toolCallId: 'call-id',
  kind: 'mcp',
  rawName: 'ux_read_file',
  canonicalName: 'ux_read_file',
  mcpServer: 'AcpUI',
  mcpToolName: 'ux_read_file',
  input: { file_path: 'D:/repo/src/app.ts' },
  title: 'Read File: app.ts',
  filePath: 'D:/repo/src/app.ts',
  category: {}
}
```

`toolInvocationResolver` upgrades AcpUI MCP identities to `kind: "acpui_mcp"`, sets `isAcpUxTool`, and merges handler-derived `titleSource`, category, file path, and public input from `mcpExecutionRegistry` when available.

Native Codex web-search calls use `ws_` IDs and are provider built-ins. `intercept()` drops native `ws_` updates with no query, output, or content so blank `Web search` rows do not appear live; `parseSessionHistory()` applies the same rule for `web_search_begin` and `web_search_end` records during replay. AcpUI MCP search calls such as `ux_google_web_search` still pass through because they have `AcpUI/<toolName>` or `rawInput.invocation` identity.

### Quota and Context Flow

```text
prepareAcpEnvironment
  -> load acp_session_context.json
  -> fetchAndEmitQuota with emitInitial when enabled
  -> provider_extension _codex/provider/status

prompt starts
  -> onPromptStarted
  -> quota interval polling while active prompts exist

prompt completes
  -> onPromptCompleted
  -> stop interval when no prompts are active
  -> fetchAndEmitQuota turn-complete refresh

usage_update
  -> intercept caches contextUsagePercentage
  -> _saveContextState persists acp_session_context.json
  -> emitCachedContext replays _codex/metadata on load/hot-resume
```

### Rollout Replay Flow

```text
Codex rollout JSONL
  -> parseSessionHistory
  -> event_msg / response_item / compacted record handlers
  -> AcpUI messages
  -> assistant.timeline thought/tool steps
  -> frontend Unified Timeline rendering
```

## Component Reference

### Provider and Backend

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Provider Runtime | `providers/codex/index.js` | `prepareAcpEnvironment`, `performHandshake`, `setConfigOption`, `buildSessionParams`, `setInitialAgent`, `getHooksForAgent` | Startup, auth, environment, config routing, no-op agent hooks. |
| Provider Models | `providers/codex/index.js` | `normalizeModelState`, `normalizeConfigOptions`, `intercept`, `parseExtension` | Dynamic model/config updates and provider extension parsing. |
| Provider Tools | `providers/codex/index.js` | `normalizeTool`, `extractToolInvocation`, `categorizeToolCall`, `extractToolOutput`, `extractFilePath`, `extractDiffFromToolCall` | Codex tool identity, title, output, file path, and diff extraction. |
| Provider Quota | `providers/codex/index.js` | `fetchCodexQuota`, `readCodexAuth`, `refreshCodexOAuthToken`, `buildCodexProviderStatus`, `fetchAndEmitQuota`, `getQuotaState`, `stopQuotaFetching`, `onPromptStarted`, `onPromptCompleted` | Quota fetching, OAuth refresh, provider status, prompt-scoped polling. |
| Provider Context | `providers/codex/index.js` | `emitCachedContext`, `_loadContextState`, `_saveContextState` | Context usage persistence and replay. |
| Provider Files | `providers/codex/index.js` | `getSessionPaths`, `cloneSession`, `deleteSessionFiles`, `archiveSessionFiles`, `restoreSessionFiles`, `parseSessionHistory` | Rollout lifecycle and history parsing. |
| Provider Loader | `backend/services/providerLoader.js` | `getProvider`, `getProviderModule`, `getProviderModuleSync`, `bindProviderModule` | Loads Codex config/module and binds provider context. |
| ACP Updates | `backend/services/acpUpdateHandler.js` | `handleUpdate` | Applies provider normalization, resolves tools, dispatches handlers, emits stream events. |
| Session Socket | `backend/sockets/sessionHandlers.js` | `captureModelState`, `create_session`, `set_session_option`, `set_session_model`, `fork_session` | Captures Codex model/config state and calls provider file hooks. |
| MCP Server | `backend/mcp/mcpServer.js` | `getMcpServers`, `createToolHandlers`, `wrapToolHandlers` | Injects MCP proxy and wraps enabled MCP tools. |
| MCP API | `backend/routes/mcpApi.js` | `GET /api/mcp/tools`, `POST /api/mcp/tool-call`, `resolveToolContext` | Advertises enabled tools and executes MCP calls. |
| Tool Resolver | `backend/services/tools/toolInvocationResolver.js` | `resolveToolInvocation`, `applyInvocationToEvent` | Merges provider extraction, sticky state, and MCP execution metadata. |
| MCP Execution | `backend/services/tools/mcpExecutionRegistry.js` | `begin`, `complete`, `fail`, `describeAcpUxToolExecution`, `invocationFromMcpExecution` | Tracks public input and authoritative display metadata. |
| Tool Names | `backend/services/tools/acpUxTools.js` | `ACP_UX_TOOL_NAMES`, `ACP_UX_CORE_TOOL_NAMES`, `ACP_UX_IO_TOOL_NAMES`, `ACP_UX_IO_TOOL_CONFIG`, `isAcpUxToolName` | Shared core and optional AcpUI MCP tool registry. |
| Tool Titles | `backend/services/tools/acpUiToolTitles.js` | `acpUiToolTitle`, `subAgentCheckToolTitle`, `basenameForToolPath` | Shared optional IO/Search titles and wait-vs-quick sub-agent status titles. |
| Provider Tool Helpers | `backend/services/tools/providerToolNormalization.js` | `mcpInvocationFromRaw`, `inputFromToolUpdate`, `resolvePatternToolName`, `commandFromRawInput`, `stripToolTitlePrefix` | Shared provider parsing helpers. |
| IO Tool Handler | `backend/services/tools/handlers/ioToolHandler.js` | `onStart`, `onUpdate`, `onEnd` | Applies optional IO/Search categories, titles, and file paths. |

### Configuration, Docs, and Tests

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Provider Config | `providers/codex/provider.json` | `protocolPrefix`, `mcpName`, `toolIdPattern`, `toolCategories`, `clientInfo` | Codex identity and tool category seed. |
| Provider Branding | `providers/codex/branding.json` | `assistantName`, `busyText`, `modelLabel`, `maxImageDimension` | UI branding payload. |
| Provider User Config | `providers/codex/user.json.example` | `authMethod`, `fetchQuotaStatus`, `paths`, `models`, `acpSupportsMcpTimeouts` | Local settings template. |
| Provider README | `providers/codex/README.md` | `Authentication`, `Quota Status`, `Context Usage Persistence`, `MCP Tools`, `Session Files`, `Tests` | Human setup guide. |
| Protocol Reference | `providers/codex/ACP_PROTOCOL_SAMPLES.md` | `initialize`, `authenticate`, `session/new`, `available_commands_update`, `Tool Calls` | Protocol examples. |
| MCP Config | `configuration/mcp.json.example` | `tools.invokeShell.enabled`, `tools.subagents.enabled`, `tools.counsel.enabled`, `tools.io.enabled`, `tools.googleSearch.enabled`, `googleSearch.apiKey` | Tool advertisement and handler availability. |
| Codex Provider Tests | `providers/codex/test/index.test.js` | `Codex Provider`, `performHandshake`, `prepareAcpEnvironment`, `quota status`, `prompt lifecycle hooks`, `intercept`, `normalizeModelState`, `setConfigOption`, `tool helpers`, `getMcpServerMeta`, `session file operations` | Codex behavior coverage. |
| Contract Tests | `backend/test/providerContract.test.js` | `every provider explicitly exports every contract function` | Required provider exports. |
| Tool Resolver Tests | `backend/test/toolInvocationResolver.test.js` | `uses provider extraction as canonical tool identity`, `prefers centrally recorded MCP execution details over provider generic titles`, `records sub-agent check title from waitForCompletion input`, `can claim a recent MCP execution when the provider tool id arrives later` | Tool System V2 merge behavior. |
| Tool Normalization Tests | `backend/test/providerToolNormalization.test.js` | `extracts Codex-style MCP invocation metadata and command text`, `resolves AcpUI tool names from nested candidates and human MCP titles` | Shared parsing helpers. |
| MCP Server Tests | `backend/test/mcpServer.test.js` | `createToolHandlers`, optional IO/Search handler cases, idempotent subagent/counsel cases | MCP handler registration and execution wrapping. |
| MCP API Tests | `backend/test/mcpApi.test.js` | `GET /api/mcp/tools`, `POST /api/mcp/tool-call` | Tool advertisement and execution route behavior. |

## Gotchas & Important Notes

1. **`model` config options are filtered out**
   - Codex exposes model selection as model catalog state and as a config option.
   - `normalizeConfigOptions()` removes `model` so the UI does not render duplicate model controls.

2. **`reasoning_effort` stays in provider settings**
   - `normalizeConfigOptions()` marks `reasoning_effort` and `effort` with `kind: "reasoning_effort"`.
   - Keep effort handling separate from model catalog handling.

3. **Generic config options use raw values**
   - `setConfigOption()` sends `{ sessionId, configId, value }` for generic options.
   - Codex expects raw values such as `high`, not wrapped value objects.

4. **AcpUI MCP tool titles have two sources**
   - Provider `normalizeTool()` builds titles from Codex payloads.
   - `mcpExecutionRegistry` and tool handlers can replace generic provider titles with handler-known titles such as `Invoke Shell: Run tests` or `Web Search: current docs`.

5. **Optional IO/Search tools need shared registry support**
   - Provider extraction recognizes names like `ux_read_file` and `ux_google_web_search`.
   - Categories and title details for optional tools come from `ACP_UX_IO_TOOL_CONFIG` and `ioToolHandler`.

6. **Native empty web-search artifacts are filtered**
   - Codex can emit native `ws_` `Web search` updates with no query/output/content.
   - `intercept()` swallows those live updates, and `parseSessionHistory()` removes matching `web_search_begin` / `web_search_end` replay records.
   - Do not apply this filter to AcpUI MCP searches; `ux_google_web_search` calls must remain visible.

7. **Quota refresh depends on JWT-shaped access tokens**
   - `refreshCodexOAuthToken()` derives `client_id` from the access-token JWT payload.
   - Opaque tokens or missing `client_id` fields make refresh fail with a clear error.

8. **Quota polling is prompt-scoped**
   - `onPromptStarted()` and `onPromptCompleted()` maintain active prompt count.
   - Streaming chunks alone do not start polling.

9. **Rollout cloning is turn-boundary aware**
   - `cloneSession()` prunes at the next whole turn boundary based on `turn_context`, `event_msg`, and `response_item` turn metadata.
   - Avoid direct file slicing that can leave orphaned turn records.

10. **History parsing handles multiple record families**
    - `parseSessionHistory()` handles `event_msg`, `response_item`, and `compacted` records.
    - Missing one record family drops thoughts, tools, user prompts, or compacted replacement history.

11. **MCP timeout metadata is opt-in**
    - `getMcpServerMeta()` returns data only when `acpSupportsMcpTimeouts` is exactly `true`.
    - Invalid timeout values are omitted, and an empty timeout object returns `undefined`.

## Unit Tests

### Provider Tests

File: `providers/codex/test/index.test.js`

Important test groups and cases:

- `performHandshake`: `sends initialize and skips auth when no auto auth source exists`, `authenticates with codex-api-key when CODEX_API_KEY is present`.
- `prepareAcpEnvironment`: `injects configured API keys into the child environment`, `emits persisted context for a loaded session on request`.
- `quota status`: `fetches quota with Codex OAuth headers from auth.json`, `derives client ID from access_token JWT payload and refreshes on 401`, `fails when access_token JWT has no client_id field`, `builds provider status with 5h, weekly, and credit details`, `emits provider status when quota fetching is enabled`.
- `prompt lifecycle hooks`: `exports onPromptStarted and onPromptCompleted`, `onPromptCompleted is a no-op for unknown sessions`.
- `intercept`: command normalization, config-option filtering, model-only update handling, native empty web-search suppression, error promotion, and polling guard behavior.
- `normalizeModelState`: slash-qualified model IDs, non-effort slash IDs, and config-option model catalogs.
- `setConfigOption`: `mode`, `model`, and generic option routing.
- `tool helpers`: output extraction, file paths, diffs, AcpUI MCP title normalization, optional IO/Search title normalization, standard input locations, canonical invocation metadata, and built-in tool name normalization.
- `getMcpServerMeta`: timeout metadata gating and numeric parsing.
- `session file operations`: nested session-root fallback, recursive clone/prune, modern turn pruning, rollout parsing, native empty web-search replay suppression, modern record parsing, and compacted history reset.

### Backend Tool and Contract Tests

- `backend/test/providerContract.test.js` (Test: `every provider explicitly exports every contract function`)
- `backend/test/providerToolNormalization.test.js` (Tests: `extracts Codex-style MCP invocation metadata and command text`, `resolves AcpUI tool names from nested candidates and human MCP titles`)
- `backend/test/toolInvocationResolver.test.js` (Tests: `uses provider extraction as canonical tool identity`, `prefers centrally recorded MCP execution details over provider generic titles`, `records sub-agent check title from waitForCompletion input`, `can claim a recent MCP execution when the provider tool id arrives later`)
- `backend/test/mcpServer.test.js` (Anchors: `createToolHandlers`, optional IO/Search registration, subagent/counsel idempotency)
- `backend/test/mcpApi.test.js` (Routes: `GET /api/mcp/tools`, `POST /api/mcp/tool-call`)

## How to Use This Guide

### For implementing/extending this feature

1. Start in `providers/codex/index.js` and confirm the export is covered by `backend/test/providerContract.test.js`.
2. Check `providers/codex/provider.json` when the change affects `protocolPrefix`, `mcpName`, `toolIdPattern`, or `toolCategories`.
3. Use `normalizeModelState()`, `normalizeConfigOptions()`, and `intercept()` for model/config protocol changes.
4. Use `normalizeTool()` and `extractToolInvocation()` for Codex tool payload changes, then verify `toolInvocationResolver` behavior.
5. Use `parseSessionHistory()` and related rollout helpers for JSONL replay, fork, archive, restore, and delete behavior.
6. Add or update tests in `providers/codex/test/index.test.js` and the relevant backend tool test when shared tool behavior changes.

### For debugging issues with this feature

1. Verify `providers/codex/user.json` values for `command`, `args`, `authMethod`, `paths.home`, `paths.sessions`, and quota settings.
2. For handshake/auth failures, inspect `performHandshake()`, `resolveAuthMethod()`, and `prepareAcpEnvironment()`.
3. For duplicated or missing model/settings UI, inspect `normalizeModelState()`, `normalizeConfigOptions()`, and `intercept()`.
4. For tool title/category/file-path issues, inspect `normalizeTool()`, `extractToolInvocation()`, `mcpExecutionRegistry`, and `ioToolHandler`.
5. For quota status issues, inspect `readCodexAuth()`, `fetchCodexQuota()`, `refreshCodexOAuthToken()`, and `buildCodexProviderStatus()`.
6. For replay/fork/archive issues, inspect `getSessionPaths()`, `cloneSession()`, `archiveSessionFiles()`, `restoreSessionFiles()`, and `parseSessionHistory()`.

## Summary

- The Codex provider is centered on `providers/codex/index.js` and configured by `providers/codex/provider.json`, `branding.json`, and local `user.json`.
- `performHandshake()` sends ACP `initialize` and optional Codex auth.
- `prepareAcpEnvironment()` handles API-key environment injection, context-cache loading, and initial quota status setup.
- `normalizeModelState()` and `normalizeConfigOptions()` keep dynamic model catalogs separate from provider settings.
- `intercept()` converts Codex command/config/usage/error shapes into AcpUI provider extensions or pass-through payloads.
- `extractToolInvocation()` and `normalizeTool()` canonicalize Codex built-in and MCP tool calls for Tool System V2.
- `mcpExecutionRegistry`, `acpUiToolTitle`, `ACP_UX_IO_TOOL_CONFIG`, and `ioToolHandler` provide authoritative metadata for optional IO/Search MCP tools.
- `parseSessionHistory()` converts mixed Codex rollout JSONL records into AcpUI messages and timeline steps.
- The critical contract is stable provider exports plus Codex-specific normalization before generic backend emission.
