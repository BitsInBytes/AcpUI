# ACP UI — Backend

Node.js middleware bridging the web UI to an ACP-compatible CLI via the Agent Client Protocol. Runs natively on the host OS.

## Provider System

The backend is strictly provider-agnostic. The `ACP_PROVIDER` env var points to a provider directory (e.g., `./providers/my-provider`) containing:

- `provider.json` — Protocol identity, MCP configuration, and tool categorization.
- `branding.json` — UI labels, text strings, and iconography.
- `user.json` — **REQUIRED.** Deployment contract defining absolute paths, executable settings, and three mandatory quick-access model aliases (**flagship**, **balanced**, **fast**).
- `index.js` — **REQUIRED.** The logic module implementing the Provider Interface Contract (data normalization, Unified Timeline parsing, and session file operations).

`providerLoader.js` reads the config once at startup. Every service that needs paths, branding, quick model aliases, or provider hooks calls `getProvider()` instead of hardcoding provider details.

Dynamic model catalogs are discovered per session from ACP responses or model-shaped config options, normalized by `modelOptions.js`, persisted in SQLite, and re-applied with `session/set_model` when a saved chat is loaded. The provider's three quick aliases remain the fallback/default shortcuts, not the complete model list.

Other env vars: `COUNSEL_CONFIG` overrides the path to `configuration/counsel.json` (counsel agent definitions).

## Architecture

```
server.js                — Express + HTTPS + Socket.IO setup, service initialization

sockets/
  index.js               — Connection handler; emits ready, voice_enabled, workspace_cwds,
                            branding, sidebar_settings, custom_commands, inspect_config on
                            connect; session room join/leave (watch_session, unwatch_session)
  sessionHandlers.js     — load_sessions, save_snapshot, delete_session, create_session,
                            get_session_history, rehydrate_session, fork_session,
                            merge_fork, export_session, get_notes, save_notes,
                            open_in_editor, set_session_option, set_session_model
  archiveHandlers.js     — archive_session, list_archives, restore_archive, delete_archive
  canvasHandlers.js      — canvas_save, canvas_load, canvas_delete, canvas_apply_to_file,
                            canvas_read_file
  promptHandlers.js      — prompt, cancel_prompt, respond_permission, set_mode
  systemHandlers.js      — get_stats, get_logs
  systemSettingsHandlers.js — get_env, update_env, get_workspaces_config, save_workspaces_config
  folderHandlers.js      — folder CRUD, move folder, move session to folder
  fileExplorerHandlers.js — explorer_list, explorer_read, explorer_write, explorer_root
  gitHandlers.js         — git_status, git_diff, git_stage, git_unstage, git_show_head,
                            get_inspect_files
  terminalHandlers.js    — terminal_spawn, terminal_input, terminal_resize, terminal_kill
                            (multi-terminal PTY via node-pty)
  voiceHandlers.js       — process_voice

services/
  providerLoader.js      — Loads provider config from ACP_PROVIDER path, resolves env vars
  acpClient.js           — ACP connection lifecycle, JSON-RPC handshake, request/response,
                            drain, permissions, provider extension routing
  acpUpdateHandler.js    — Routes updates; implements "Sticky Metadata" to preserve tool context
  acpTitleGenerator.js   — Auto-generates chat titles via a secondary ACP session using the configured `titleGeneration` model ID
  modelOptions.js        — Normalizes dynamic ACP model catalogs, currentModelId, and quick alias/raw ID resolution
  hookRunner.js          — Standardized hook system: executes `session_start`, `pre_tool`, `post_tool`, and `stop` scripts
  jsonlParser.js         — Delegates to provider's `parseSessionHistory` to reconstruct the **Unified Timeline**
  sessionManager.js      — autoSaveTurn with 5s delay, permission-aware
  attachmentVault.js     — File upload storage at provider-configured attachments path
  workspaceConfig.js     — Loads workspace definitions from configuration/workspaces.json
  commandsConfig.js      — Loads custom slash commands from configuration/commands.json
  counselConfig.js       — Loads counsel agent config (core + optional experts) from configuration/counsel.json
  logger.js              — Timestamped file + console logging, broadcasts via Socket.IO

routes/
  index.js               — Express route aggregator
  upload.js              — File upload endpoint
  static.js              — Static file serving

mcp/
  mcpServer.js           — MCP tool handlers — plain async functions, no MCP SDK dependency
  stdio-proxy.js         — Thin stdio MCP proxy (spawned by ACP per session)
  routes/mcpApi.js       — Internal API for stdio proxy (GET /tools, POST /tool-call)
  subAgentRegistry.js    — Tracks sub-agent ACP sessions, parent linkage, and status
  acpCleanup.js          — Deletes ephemeral ACP session files (.jsonl, .json, tasks)

voiceService.js          — whisper-server management and transcription
database.js              — SQLite (sessions, folders, canvas artifacts, notes, fork metadata, dynamic model state)
```

## ACP Protocol

Communicates with the CLI daemon using JSON-RPC 2.0 over NDJSON (stdin/stdout):

| Method | Notes |
|--------|-------|
| `initialize` | Handshake with `protocolVersion`, `clientCapabilities`, `clientInfo` from provider |
| `session/new` | Creates session with `cwd`, `mcpServers`; captures dynamic model catalog and `currentModelId` when advertised |
| `session/load` | Resumes session with `mcpServers`; captures restored model state and immediately re-applies the DB model if needed |
| `session/prompt` | `prompt` field; array of ContentBlock |
| `session/set_model` | Sets model using the real **Model ID** from the dynamic catalog or provider quick alias fallback |
| `session/set_mode` | Sets agent mode |
| `session/configure` / provider-specific `session/set_config_option` | Sets per-session dynamic configuration options through the provider hook |
| `session/cancel` | Notification (no response expected) |

Incoming updates arrive as `session/update` notifications with `sessionUpdate` types: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `turn_end`.

Permission requests arrive as `session/request_permission` with JSON-RPC `id`; responded with `outcome: 'selected'` or `outcome: 'cancelled'`.

## Features

- **Provider system** — all paths, branding, quick model aliases, and CLI command configured via `ACP_PROVIDER`
- **Dynamic model discovery** — captures provider-advertised model catalogs from ACP responses or model-shaped config options, persists `currentModelId`/`modelOptions`, and emits `session_model_options`
- **Model re-apply on load** — saved chats restore the DB-selected model immediately during session load instead of waiting for the next prompt
- **Per-workspace agents** — `create_session` accepts `cwd` and `agent`, switches agent via `/agent` prompt
- **Session forking** — `fork_session` clones JSONL, JSON, tasks, and attachments at a message index
- **Cascade delete** — `delete_session` removes child forks and sub-agents (DB records, ACP files, attachments) to prevent orphans
- **Fork merging** — `merge_fork` summarizes fork work, deletes fork, sends summary to parent via `merge_message` event
- **Session export** — `export_session` writes session JSON, JSONL, and attachments to a target directory
- **Auto title generation** — on first response chunk, spawns a secondary session for title
- **Periodic streaming saves** — every 3s during active streaming, permission-aware
- **Session archive** — moves session files + attachments to archive path, saves metadata for restore
- **JSONL rehydration** — parses JSONL session files to rebuild UI messages when DB is stale
- **Permission system** — ACP-compliant `selected`/`cancelled` outcome responses, tracks pending permissions
- **Sidebar folders** — nested folder CRUD with reparenting on delete
- **File explorer** — read/write files with path traversal protection
- **Git integration** — status, diff, stage, unstage, show HEAD, inspect changed `.cs` files
- **Multi-terminal PTY** — `node-pty` terminals per socket, with spawn/input/resize/kill lifecycle
- **Agent hooks** — `session_start`, `post_tool`, `stop` hooks loaded from provider agents path
- **Custom commands** — loaded from `commands.json`, emitted to UI on connect
- **Workspace config** — `workspaces.json` with label/path/agent/pinned per workspace
- **Scratch pad notes** — per-session markdown notes stored in SQLite
- **Canvas artifacts** — per-session code artifacts with file sync
- **Image compression** — attachments compressed via `sharp` before sending to ACP
- **Whisper STT** — whisper-server auto-starts, model stays loaded in memory
- **Environment editor** — read/write `.env` via socket events
- **Stdio MCP proxy architecture** — tools executed via /api/mcp/tool-call, no separate HTTP port
- **MCP tools: run_shell_command** — Executes shell commands via `node-pty` with live streaming to the UI (`tool_output_stream` event), ANSI stripping, 30-min inactivity timeout, and heartbeat to keep MCP connection alive
- **Sub-agent system** — `invoke_sub_agents` MCP tool spawns parallel ACP sessions, each visible in the UI as a child session; tracked by `subAgentRegistry`; emits `sub_agent_started`/`sub_agent_completed` events; ephemeral session files cleaned up via `acpCleanup`
- **Counsel tool** — `counsel` MCP tool spawns Advocate, Critic, Pragmatist + optional domain experts via `invoke_sub_agents`; agent roles configured in `counsel.json`
- **Sub-agent cancellation** — `cancel_prompt` aborts running sub-agents via `acpClient._abortSubAgents()` before cancelling the parent session

## Provider Extension Events

Extension events from the ACP daemon are forwarded as `provider_extension` socket events. The extension prefix is configured in `provider.json` (e.g., `_companyName/`).

| Example Event | Purpose |
|---------------|---------|
| `*/commands/available` | Dynamic slash command list |
| `*/metadata` | Context usage percentage |
| `*/compaction/status` | Compaction lifecycle events |
| `*/config_options` | Dynamic per-session configuration controls (e.g., Reasoning Effort) |

## Model State Events

Dynamic model updates are provider-agnostic socket events, not provider extension events.

| Event | Purpose |
|-------|---------|
| `session_model_options` | Broadcasts `{ sessionId, currentModelId, modelOptions }` when the ACP advertises or changes model state |

## Testing

```bash
npx vitest run              # 464 tests across 44 files
npx vitest run --coverage
```
