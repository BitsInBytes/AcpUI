# Google Search MCP Tool

## Overview

`ux_google_web_search` is an optional AcpUI MCP tool that exposes grounded Google Search through the backend MCP proxy. It is available to ACP agents only when MCP configuration enables the tool and provides a non-empty `googleSearch.apiKey`.

This feature sits across MCP tool advertisement, route-mounted tool execution, service-level Google GenAI calls, and Tool System V2 timeline metadata. Most breakage comes from changing one of those contracts without updating the others.

### What It Does

- Advertises `ux_google_web_search` with a JSON Schema requiring `query`.
- Registers the runtime handler only when effective MCP config enables Google search.
- Reads API key, timeout, and output limit from `configuration/mcp.json` (or `MCP_CONFIG`), with env-first key lookup via `googleSearch.apiKeyEnv`.
- Calls `@google/genai` with `models.generateContent`, model `gemini-2.5-flash`, and `tools: [{ googleSearch: {} }]`.
- Formats response text with citation markers and a `Sources:` section when grounding metadata is present.
- Returns MCP text content and records Tool System V2 title/category metadata for the UI timeline.

### Why This Matters

- Agents must not discover a tool that cannot execute.
- The API key must stay out of MCP tool input and remain config-owned.
- The service output is plain text, so citations, empty results, truncation, and errors are part of the user-visible contract.
- Tool System V2 depends on the canonical name `ux_google_web_search` for `Web Search: <query>` titles and `web_search` category data.
- The stdio MCP proxy fetches tool definitions per ACP session, so config and route registration affect what agents see.

Feature role: backend MCP tool, backend service, route-mounted MCP API, Tool System V2 metadata path.

## How It Works - End-to-End Flow

1. **MCP config is loaded and normalized**
   - File: `backend/services/mcpConfig.js` (Functions: `getMcpConfig`, `normalizeMcpConfig`, `isGoogleSearchMcpEnabled`, `getGoogleSearchMcpConfig`)
   - `MCP_CONFIG` selects the JSON config file; the default path is `configuration/mcp.json`.
   - `tools.googleSearch` accepts boolean form or object form with `enabled`; effective enablement requires a trimmed non-empty API key resolved from `googleSearch.apiKeyEnv` (preferred) or `googleSearch.apiKey`.

   ```javascript
   // FILE: backend/services/mcpConfig.js (Function: normalizeMcpConfig)
   const googleSearchApiKeyEnv = stringSetting(googleSearch.apiKeyEnv, 'MCP_GOOGLE_SEARCH_API_KEY');
   const envGoogleSearchApiKey = stringSetting(env?.[googleSearchApiKeyEnv], '');
   const configGoogleSearchApiKey = stringSetting(googleSearch.apiKey, '');
   const googleSearchApiKey = envGoogleSearchApiKey || configGoogleSearchApiKey;
   const requestedGoogleSearch = boolSetting(tools.googleSearch);

   tools: {
     googleSearch: requestedGoogleSearch && Boolean(googleSearchApiKey)
   }
   ```

2. **The backend mounts the MCP API before the general router**
   - File: `backend/server.js` (Route mount: `/api/mcp`, Startup assignment: `mcpApiRouter = createMcpApiRoutes(io)`)
   - `/api/mcp` returns `503` until the Socket.IO-backed router is created, then delegates requests to `backend/routes/mcpApi.js`.
   - `createMcpApiRoutes(io)` creates the active handler map by calling `createToolHandlers(io)`.

3. **ACP sessions receive a stdio proxy server config**
   - File: `backend/mcp/mcpServer.js` (Function: `getMcpServers`)
   - The provider's `mcpName` controls the MCP server name. `getMcpServers` points the ACP session at `backend/mcp/stdio-proxy.js` and passes `ACP_SESSION_PROVIDER_ID`, `ACP_UI_MCP_PROXY_ID`, `ACP_UI_MCP_PROXY_AUTH_TOKEN`, and `BACKEND_PORT` through environment entries.

4. **The stdio proxy fetches tool definitions from the backend**
   - File: `backend/mcp/stdio-proxy.js` (Function: `runProxy`, Handlers: `ListToolsRequestSchema`, `CallToolRequestSchema`)
   - `runProxy` calls `GET /api/mcp/tools` with provider/proxy query values, registers the returned tools with the MCP SDK, and forwards tool calls to `POST /api/mcp/tool-call` with `x-acpui-mcp-proxy-auth`.
   - The ListTools response preserves `name`, `title`, `description`, `inputSchema`, `annotations`, `execution`, `outputSchema`, and `_meta` when present.

5. **`GET /tools` advertises Google search only when enabled**
   - File: `backend/routes/mcpApi.js` (Function: `createMcpApiRoutes`, Route handler: `GET /tools`)
   - The route appends `getGoogleSearchMcpToolDefinitions()` only when `isGoogleSearchMcpEnabled()` is true.

   ```javascript
   // FILE: backend/routes/mcpApi.js (Route handler: GET /tools)
   if (isGoogleSearchMcpEnabled()) {
     toolList.push(...getGoogleSearchMcpToolDefinitions());
   }
   ```

6. **The tool definition exposes the MCP schema**
   - File: `backend/mcp/ioMcpToolDefinitions.js` (Function: `getGoogleSearchMcpToolDefinitions`)
   - The definition uses canonical name `ACP_UX_TOOL_NAMES.googleWebSearch`, title `Google web search`, read-only/open-world annotations, and a single required `query` string.

   ```javascript
   // FILE: backend/mcp/ioMcpToolDefinitions.js (Function: getGoogleSearchMcpToolDefinitions)
   {
     name: ACP_UX_TOOL_NAMES.googleWebSearch,
     title: 'Google web search',
     annotations: { readOnlyHint: true, openWorldHint: true },
     inputSchema: {
       type: 'object',
       properties: { query: { type: 'string', description: 'The search query.' } },
       required: ['query']
     }
   }
   ```

7. **Runtime handlers are registered under the same gate**
   - File: `backend/mcp/mcpServer.js` (Function: `createToolHandlers`)
   - `createGoogleSearchMcpToolHandlers()` is merged into the handler map only when effective config enables Google search.
   - `wrapToolHandlers` wraps the handler map so AcpUI MCP executions are recorded in `mcpExecutionRegistry`.

   ```javascript
   // FILE: backend/mcp/mcpServer.js (Function: createToolHandlers)
   if (isGoogleSearchMcpEnabled()) {
     Object.assign(tools, createGoogleSearchMcpToolHandlers());
   }

   return wrapToolHandlers(tools, io);
   ```

8. **`POST /tool-call` augments context and executes the handler**
   - File: `backend/routes/mcpApi.js` (Route handler: `POST /tool-call`, Helpers: `resolveExecutionContext`, `createToolCallAbortSignal`)
   - The route requires a valid proxy id, matching proxy auth token, and bound ACP session, then adds `providerId`, `acpSessionId`, `mcpProxyId`, `mcpRequestId`, `requestMeta`, and `abortSignal` before calling the named handler from the `createToolHandlers(io)` map.
   - Unknown tool names return `404`. Handler errors return MCP text content shaped as `Error: <message>` unless the request/response is already aborted.

9. **Tool System V2 records public input and display metadata**
   - File: `backend/mcp/mcpServer.js` (Function: `wrapToolHandlers`)
   - File: `backend/services/tools/mcpExecutionRegistry.js` (Functions: `publicMcpToolInput`, `begin`, `describeAcpUxToolExecution`, `invocationFromMcpExecution`)
   - `publicMcpToolInput` removes internal context fields before recording input. For this tool, the public input is `{ query: '<search query>' }`.
   - The registry emits a `system_event` with `type: 'tool_update'`, `canonicalName: 'ux_google_web_search'`, `title: 'Web Search: <query>'`, and `toolCategory: 'web_search'` when session context and tool call id are available.

10. **The Google handler delegates to the service**
    - File: `backend/mcp/ioMcpToolHandlers.js` (Function: `createGoogleSearchMcpToolHandlers`)
    - The handler destructures `query`, passes `abortSignal`, calls `googleWebSearch(query, { abortSignal })`, and wraps the returned string in MCP text content.
    - Service duration is bounded by `googleSearch.timeoutMs`, and route abort now short-circuits in-flight handler waits.

    ```javascript
    // FILE: backend/mcp/ioMcpToolHandlers.js (Function: createGoogleSearchMcpToolHandlers)
    [ACP_UX_TOOL_NAMES.googleWebSearch]: async ({ query, abortSignal }) => {
      return textResult(await googleWebSearch(query, { abortSignal }));
    }
    ```

11. **The service calls Google GenAI and formats grounded output**
    - File: `backend/services/ioMcp/googleWebSearch.js` (Function: `googleWebSearch`, Helpers: `withTimeout`, `limitOutput`, `truncateUtf8`)
    - The service reads `apiKey`, `timeoutMs`, and `maxOutputBytes` from `getGoogleSearchMcpConfig()`, with optional overrides used by direct service tests.
    - Missing `apiKey` throws `googleSearch.apiKey is missing in MCP config.` before the SDK call.
    - The SDK request uses `contents: [{ role: 'user', parts: [{ text: query }] }]`, Google Search grounding, and `temperature: 0.3`.
    - Empty response text returns `No search results or information found for query: "<query>"`.
    - Grounding chunks produce a numbered `Sources:` list, and grounding supports insert citation markers at support segment positions.
    - Final successful output is prefixed with `Web search results for "<query>":` and truncated by UTF-8 byte count when needed.

12. **Resolver uses centralized execution data for UI events**
    - File: `backend/services/tools/toolInvocationResolver.js` (Function: `resolveToolInvocation`, Function: `applyInvocationToEvent`)
    - File: `backend/services/tools/acpUiToolTitles.js` (Function: `acpUiToolTitle`)
    - File: `backend/services/tools/acpUxTools.js` (Keys: `ACP_UX_TOOL_NAMES.googleWebSearch`, `ACP_UX_IO_TOOL_CONFIG`)
    - Provider extraction and cached tool state are merged with `mcpExecutionRegistry` data so UI events keep canonical identity, title, category, and public input.

## Architecture Diagram

```mermaid
flowchart TD
  A[configuration/mcp.json or MCP_CONFIG] --> B[backend/services/mcpConfig.js\nnormalizeMcpConfig]
  B --> C{tools.googleSearch enabled\nand apiKey non-empty}

  D[backend/server.js\n/api/mcp mount] --> E[backend/routes/mcpApi.js\ncreateMcpApiRoutes]
  C --> E
  E --> F[backend/mcp/mcpServer.js\ncreateToolHandlers + wrapToolHandlers]
  C --> F

  G[ACP session] --> H[backend/mcp/mcpServer.js\ngetMcpServers]
  H --> I[backend/mcp/stdio-proxy.js\nrunProxy]
  I -->|GET /api/mcp/tools| E
  E --> J[backend/mcp/ioMcpToolDefinitions.js\ngetGoogleSearchMcpToolDefinitions]
  I -->|ListToolsRequestSchema| G

  G -->|CallToolRequestSchema| I
  I -->|POST /api/mcp/tool-call| E
  E --> F
  F --> K[backend/mcp/ioMcpToolHandlers.js\ncreateGoogleSearchMcpToolHandlers]
  K --> L[backend/services/ioMcp/googleWebSearch.js\ngoogleWebSearch]
  L --> M[@google/genai\nmodels.generateContent]
  L --> N[MCP text output\nresult, sources, truncation, or error]

  F --> O[backend/services/tools/mcpExecutionRegistry.js\ntool_update metadata]
  O --> P[Socket.IO system_event\nWeb Search: query]
```

## Critical Contract

The critical contract is schema, handler, config, and display metadata alignment for the canonical tool name `ux_google_web_search`.

1. **Effective enablement contract**
   - `tools.googleSearch` alone is insufficient.
   - Effective enablement requires `tools.googleSearch` truthy and `googleSearch.apiKey` non-empty after trimming.
   - Anchors: `backend/services/mcpConfig.js` (`normalizeMcpConfig`, `isGoogleSearchMcpEnabled`, `getGoogleSearchMcpConfig`).

2. **Schema/handler parity contract**
   - `GET /api/mcp/tools` must advertise only handlers that `POST /api/mcp/tool-call` can execute.
   - The advertised name and registered handler key must both be `ACP_UX_TOOL_NAMES.googleWebSearch`.
   - Anchors: `backend/routes/mcpApi.js` (`GET /tools`), `backend/mcp/ioMcpToolDefinitions.js` (`getGoogleSearchMcpToolDefinitions`), `backend/mcp/mcpServer.js` (`createToolHandlers`), `backend/mcp/ioMcpToolHandlers.js` (`createGoogleSearchMcpToolHandlers`).

3. **Input/config ownership contract**
   - MCP input contains only `query`.
   - API key, timeout, and output limit come from MCP config, not tool arguments.
   - Anchors: `backend/mcp/ioMcpToolDefinitions.js` (`inputSchema`), `backend/services/ioMcp/googleWebSearch.js` (`googleWebSearch`).

4. **Tool System V2 identity contract**
   - `ux_google_web_search` must remain in `ACP_UX_TOOL_NAMES`, `ACP_UX_IO_TOOL_CONFIG`, and the IO tool registry loop.
   - The display title is `Web Search: <query>` and the category is `web_search`.
   - Anchors: `backend/services/tools/acpUxTools.js`, `backend/services/tools/acpUiToolTitles.js`, `backend/services/tools/index.js`, `backend/services/tools/mcpExecutionRegistry.js`, `backend/services/tools/toolInvocationResolver.js`.

If any part drifts, ACP agents can miss the tool, see an unexecutable tool, leak config into input, or render generic timeline metadata.

## Configuration

Primary file: `configuration/mcp.json`, or a JSON file selected by the `MCP_CONFIG` environment variable.

Canonical example shape: `configuration/mcp.json.example`.

```json
{
  "tools": {
    "googleSearch": { "enabled": true }
  },
  "googleSearch": {
    "apiKey": "",
    "apiKeyEnv": "MCP_GOOGLE_SEARCH_API_KEY",
    "timeoutMs": 15000,
    "maxOutputBytes": 262144
  }
}
```

Relevant keys:

- `tools.googleSearch` or `tools.googleSearch.enabled`: requests advertisement and handler registration.
- `googleSearch.apiKeyEnv`: preferred environment-variable name used to resolve the API key.
- `googleSearch.apiKey`: optional fallback when the configured env var is unset.
- `googleSearch.timeoutMs`: passed to `withTimeout`; default is `15000` when absent or invalid.
- `googleSearch.maxOutputBytes`: passed to `limitOutput`; default is `262144` when absent or invalid.

Provider behavior:

- The provider config supplies `mcpName`, which becomes the MCP server name returned by `GET /api/mcp/tools` and recorded in execution identity.
- Providers do not supply the Google API key through provider config or tool input.
- Provider tool-normalization code can map the title `Google web search` back to canonical name `ux_google_web_search` through `ACP_UX_MCP_TITLE_TO_TOOL_NAME`.

## Data Flow

### 1) Normalized config shape

```json
{
  "tools": {
    "googleSearch": true
  },
  "googleSearch": {
    "apiKey": "configured-key",
    "timeoutMs": 15000,
    "maxOutputBytes": 262144
  }
}
```

### 2) Advertised MCP tool definition

```json
{
  "name": "ux_google_web_search",
  "title": "Google web search",
  "description": "Perform a grounded Google Search using Google services and return a synthesized answer with citations.",
  "annotations": {
    "readOnlyHint": true,
    "destructiveHint": false,
    "idempotentHint": false,
    "openWorldHint": true
  },
  "inputSchema": {
    "type": "object",
    "properties": {
      "query": { "type": "string", "description": "The search query." }
    },
    "required": ["query"]
  }
}
```

### 3) MCP API tool call payload

```json
{
  "tool": "ux_google_web_search",
  "args": {
    "query": "<search query>"
  },
  "providerId": "test-provider",
  "proxyId": "proxy-abc",
  "mcpRequestId": "mcp_AcpUI_ux_google_web_search-1",
  "requestMeta": {
    "toolCallId": "tool-search-1"
  }
}
```

### 4) Handler arguments after route context augmentation

```json
{
  "query": "<search query>",
  "providerId": "test-provider",
  "acpSessionId": "acp-session-id",
  "mcpProxyId": "proxy-abc",
  "mcpRequestId": "mcp_AcpUI_ux_google_web_search-1",
  "requestMeta": { "toolCallId": "tool-search-1" },
  "abortSignal": "AbortSignal"
}
```

`publicMcpToolInput` records only public input for the execution registry:

```json
{
  "query": "<search query>"
}
```

### 5) Service-level output variants

Successful grounded result:

```text
Web search results for "<search query>":

<synthesized answer with optional [1] markers>

Sources:
[1] <title> (<uri>)
```

Empty response text:

```text
No search results or information found for query: "<search query>"
```

Truncated output:

```text
<valid UTF-8 prefix>

[ux_google_web_search output truncated after <maxOutputBytes> bytes; original output was <totalBytes> bytes.]
```

Service errors:

- Missing config key: `googleSearch.apiKey is missing in MCP config.`
- SDK or timeout failure: `Google Web Search failed: <message>`

### 6) MCP response envelope

```json
{
  "content": [
    {
      "type": "text",
      "text": "<service output>"
    }
  ]
}
```

### 7) Tool System V2 display projection

```json
{
  "identity": {
    "kind": "acpui_mcp",
    "canonicalName": "ux_google_web_search",
    "mcpToolName": "ux_google_web_search"
  },
  "input": {
    "query": "<search query>"
  },
  "display": {
    "title": "Web Search: <search query>",
    "titleSource": "mcp_handler"
  },
  "category": {
    "toolCategory": "web_search",
    "isFileOperation": false
  }
}
```

## Component Reference

| Area | File | Stable Anchors | Purpose |
|---|---|---|---|
| Config | `configuration/mcp.json.example` | `tools.googleSearch`, `googleSearch.apiKey`, `googleSearch.timeoutMs`, `googleSearch.maxOutputBytes` | Canonical optional Google search config shape |
| Backend route mount | `backend/server.js` | `/api/mcp`, `createMcpApiRoutes(io)`, `mcpApiRouter` | Mounts MCP API before general routes and initializes it with Socket.IO |
| Backend config | `backend/services/mcpConfig.js` | `getMcpConfig`, `normalizeMcpConfig`, `isGoogleSearchMcpEnabled`, `getGoogleSearchMcpConfig`, `resetMcpConfigForTests` | Loads, caches, normalizes, and gates MCP config |
| MCP session config | `backend/mcp/mcpServer.js` | `getMcpServers`, `createToolHandlers`, `wrapToolHandlers` | Creates stdio proxy config, registers handlers, and records executions |
| Stdio proxy | `backend/mcp/stdio-proxy.js` | `runProxy`, `ListToolsRequestSchema`, `CallToolRequestSchema`, `backendFetch` | Fetches tool definitions and forwards MCP calls to backend routes |
| MCP API | `backend/routes/mcpApi.js` | `createMcpApiRoutes`, `GET /tools`, `POST /tool-call`, `resolveExecutionContext`, `createToolCallAbortSignal` | Advertises tool schemas and executes authenticated tool calls |
| MCP schema | `backend/mcp/ioMcpToolDefinitions.js` | `getGoogleSearchMcpToolDefinitions`, `ACP_UX_TOOL_NAMES.googleWebSearch` | Defines `ux_google_web_search` schema, title, description, and annotations |
| MCP handler | `backend/mcp/ioMcpToolHandlers.js` | `createGoogleSearchMcpToolHandlers`, `textResult` | Converts `{ query }` into `googleWebSearch(query)` and MCP text content |
| Search service | `backend/services/ioMcp/googleWebSearch.js` | `googleWebSearch`, `withTimeout`, `limitOutput`, `truncateUtf8` | Executes grounded GenAI call, formats sources/citations, and bounds output |
| Tool naming | `backend/services/tools/acpUxTools.js` | `ACP_UX_TOOL_NAMES.googleWebSearch`, `ACP_UX_IO_TOOL_CONFIG`, `ACP_UX_IO_TOOL_NAMES` | Defines canonical name, display metadata, and registry inclusion |
| Title builder | `backend/services/tools/acpUiToolTitles.js` | `acpUiToolTitle`, `headerValue` | Builds `Web Search: <query>` from public input |
| Tool registry | `backend/services/tools/index.js` | `toolRegistry.register`, `ACP_UX_IO_TOOL_NAMES` loop | Registers the generic IO handler for all AcpUI IO tools, including Google search |
| Execution metadata | `backend/services/tools/mcpExecutionRegistry.js` | `publicMcpToolInput`, `begin`, `describeAcpUxToolExecution`, `invocationFromMcpExecution`, `emitMcpToolUpdate` | Records execution identity/input/output and emits timeline metadata |
| Invocation resolver | `backend/services/tools/toolInvocationResolver.js` | `resolveToolInvocation`, `applyInvocationToEvent` | Merges provider extraction, cached tool state, and central MCP execution data |
| Tool title normalization | `backend/services/tools/providerToolNormalization.js` | `ACP_UX_MCP_TITLE_TO_TOOL_NAME`, `resolveToolNameFromAcpUiMcpTitle` | Maps full MCP titles or prefixes such as `Google web search` before `: <detail>` suffixes to canonical tool names |
| Service tests | `backend/test/ioMcpGoogleSearch.test.js` | `IO MCP googleWebSearch` | Covers config key requirement, empty output, citations/sources, SDK errors, API key loading, truncation |
| Config tests | `backend/test/mcpConfig.test.js` | `MCP config` | Covers Google search config normalization and effective gating |
| API tests | `backend/test/mcpApi.test.js` | `MCP API Routes` | Covers tool advertisement, hidden states, POST context augmentation, abort behavior, error envelopes |
| Handler tests | `backend/test/mcpServer.test.js` | `mcpServer`, `optional IO MCP tools` | Covers Google handler registration and Tool System V2 title emission |
| Proxy tests | `backend/test/stdio-proxy.test.js` | `stdio-proxy` | Covers tool fetch, ListTools passthrough fields, CallTool forwarding, retry/abort behavior |
| Resolver tests | `backend/test/toolInvocationResolver.test.js` | `toolInvocationResolver` | Covers central MCP execution metadata precedence for Google search titles/input |

## Gotchas

1. **Enablement requires tool flag plus an API key source**
   - `tools.googleSearch` can request the tool, but `isGoogleSearchMcpEnabled()` returns true only when an API key resolves from `googleSearch.apiKeyEnv` (preferred) or `googleSearch.apiKey`.

2. **Config is cached in process**
   - `getMcpConfig()` caches the normalized config. Tests call `resetMcpConfigForTests()`. Runtime config edits need the backend path that refreshes process state, or a backend restart, before handler maps and tool definitions reflect them.

3. **Handler map is created when `createMcpApiRoutes(io)` runs**
   - `backend/routes/mcpApi.js` captures `const tools = createToolHandlers(io)`. A config change after router creation does not rebuild that handler map by itself.

4. **Schema and handler gates must match**
   - `GET /tools` and `createToolHandlers` both use `isGoogleSearchMcpEnabled()`. Changing only one path creates discovery/execution mismatch.

5. **There is no unprefixed runtime handler**
   - `ux_google_web_search` is registered. `google_web_search` is not registered in `createToolHandlers` and appears in tests only as an absent compatibility name.

6. **Tool input is `query` only**
   - `api_key`, timeout, and output limit are not accepted by the MCP schema. Direct service tests may pass options to `googleWebSearch`, but MCP calls do not.

7. **Route abort now short-circuits in-flight search calls**
   - `POST /tool-call` adds `abortSignal`, `createGoogleSearchMcpToolHandlers` passes it to `googleWebSearch`, and `withTimeout` races the SDK promise against timeout and abort. This stops waiting immediately on abort even when the SDK call itself has no direct cancellation hook.

8. **Empty SDK text uses a different output shape**
   - Empty `response.text` returns `No search results or information found for query: "<query>"` without the `Web search results for` prefix.

9. **Citation formatting depends on grounding metadata shape**
   - `groundingChunks` produce sources. `groundingSupports` with `segment.endIndex` and `groundingChunkIndices` produce inline markers. Missing supports still allows a `Sources:` list when chunks exist.

10. **Truncation happens after formatting**
    - `limitOutput` applies to the complete prefixed result including citations and sources, using UTF-8 bytes and preserving valid UTF-8 at the cutoff.

## Unit Tests

### Backend service tests

- `backend/test/ioMcpGoogleSearch.test.js`
  - `requires googleSearch.apiKey in MCP config`
  - `returns a no-results message for empty response text`
  - `formats grounded results with citations and sources`
  - `wraps SDK failures with tool-specific context`
  - `reads the API key configured in mcp.json`
  - `aborts search requests when abortSignal is triggered`
  - `truncates oversized search output`

### Config normalization and gating tests

- `backend/test/mcpConfig.test.js`
  - `normalizes IO, web fetch, and Google search settings`
  - `disables Google search when enabled without an MCP config API key`

### MCP API and proxy tests

- `backend/test/mcpApi.test.js`
  - `GET /tools hides optional IO and Google tools by default`
  - `GET /tools advertises Google search only when MCP config enables it`
  - `GET /tools does not advertise Google search when enabled without an MCP config API key`
  - `POST /tool-call with valid tool returns result`
  - `POST /tool-call passes resolved proxy context to handlers`
  - `POST /tool-call aborts the handler signal when the request fires the "aborted" event`
  - `POST /tool-call aborts the handler signal when the response closes before completion`

- `backend/test/stdio-proxy.test.js`
  - `runs the proxy lifecycle`
  - `handles ListTools and CallTool requests`
  - `does not retry when fetch throws an AbortError`

### MCP handler registration and title tests

- `backend/test/mcpServer.test.js`
  - `does not register optional IO or Google handlers by default`
  - `registers Google search handler when MCP config enables Google search`
  - `does not register Google search handler when enabled without an MCP config API key`
  - `emits web search query title for google_web_search`
  - `passes abortSignal into google web search handler calls`

### Invocation resolution tests

- `backend/test/toolInvocationResolver.test.js`
  - `prefers centrally recorded MCP execution details over provider generic titles`

## How to Use This Guide

### For implementing/extending this feature

1. Start in `backend/services/mcpConfig.js` and preserve the effective enablement rule: requested `tools.googleSearch` plus non-empty `googleSearch.apiKey`.
2. Keep schema and handler changes paired in `backend/mcp/ioMcpToolDefinitions.js`, `backend/mcp/ioMcpToolHandlers.js`, `backend/mcp/mcpServer.js`, and `backend/routes/mcpApi.js`.
3. Keep the canonical name stable in `backend/services/tools/acpUxTools.js`; display behavior flows through `acpUiToolTitle` and `mcpExecutionRegistry`.
4. Keep API key, timeout, and output limit config-owned. Do not add those fields to the MCP input schema.
5. Update focused tests in `backend/test/ioMcpGoogleSearch.test.js`, `backend/test/mcpConfig.test.js`, `backend/test/mcpApi.test.js`, `backend/test/mcpServer.test.js`, `backend/test/stdio-proxy.test.js`, and `backend/test/toolInvocationResolver.test.js`.

### For debugging issues with this feature

1. Check the effective config source in `backend/services/mcpConfig.js` using `getMcpConfig().source` and confirm `googleSearch.apiKey` is non-empty.
2. Verify advertisement through `backend/routes/mcpApi.js` (`GET /tools`) and `backend/mcp/ioMcpToolDefinitions.js` (`getGoogleSearchMcpToolDefinitions`).
3. Verify runtime registration in `backend/mcp/mcpServer.js` (`createToolHandlers`) and handler behavior in `backend/mcp/ioMcpToolHandlers.js` (`createGoogleSearchMcpToolHandlers`).
4. Verify proxy behavior in `backend/mcp/stdio-proxy.js` (`runProxy`) if the backend advertises the tool but an ACP session does not see it.
5. Verify service behavior in `backend/services/ioMcp/googleWebSearch.js` for API key errors, SDK failures, empty text, source formatting, timeout, and truncation.
6. Verify timeline metadata in `backend/services/tools/mcpExecutionRegistry.js` and `backend/services/tools/toolInvocationResolver.js` when the search runs but the UI title/category is generic.

## Summary

- `ux_google_web_search` is an optional backend MCP tool for grounded Google Search.
- Effective enablement requires requested `tools.googleSearch` plus a resolved API key from `googleSearch.apiKeyEnv` (preferred) or `googleSearch.apiKey`.
- The stdio proxy discovers the tool through `GET /api/mcp/tools` and executes it through `POST /api/mcp/tool-call`.
- The MCP schema accepts only `query`; API key, timeout, and output limit are config-owned.
- `googleWebSearch` calls `@google/genai`, formats grounding citations/sources, handles empty text, wraps SDK/timeout failures, and truncates by UTF-8 bytes.
- Tool System V2 records public input and projects `Web Search: <query>` with `web_search` category.
- Source changes in this area should keep config gating, schema advertisement, handler registration, service output, and metadata projection aligned.
