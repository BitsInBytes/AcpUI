# ACP UI — Backend

Node.js middleware bridging the web UI to an ACP-compatible CLI via the Agent Client Protocol. Runs natively on the host OS.

## Provider System

The backend is strictly provider-agnostic and supports multiple concurrent providers configured via `configuration/providers.json`. `providerRegistry.js` loads the configuration from the registry file. `providerRuntimeManager.js` initializes and manages isolated `AcpClient` instances for each enabled provider, utilizing `AsyncLocalStorage` to ensure thread-safe context isolation across concurrent AI agents.

Dynamic model catalogs are discovered per session from ACP responses or model-shaped config options, normalized by `modelOptions.js`, persisted in SQLite, and re-applied with `session/set_model` when a saved chat is loaded. The provider's `models.quickAccess[]` entries are fallback/footer shortcuts, not the complete model list.

Each provider directory (e.g., `./providers/my-provider`) contains:

- `provider.json` — Protocol identity, MCP configuration, and tool categorization.
- `branding.json` — UI labels, text strings, and iconography.
- `user.json` — **REQUIRED.** Deployment contract defining absolute paths, executable settings, model defaults, and optional footer quick-access models.
- `index.js` — **REQUIRED.** The logic module implementing the Provider Interface Contract (data normalization, Unified Timeline parsing, and session file operations).

## Hardening & Reliability

- **Background Auto-Load** — Sequentially warms up all pinned chats into memory immediately after a successful ACP handshake.
- **Hot-Resume Optimization** — Exposes memory-resident metadata to the UI to skip redundant `session/load` RPC calls during session switching.
- **Exponential Back-off** — Automatically manages daemon restarts with increasing delays (2s, 4s, 8s, 16s, 30s) to prevent resource thrashing during persistent provider failures.
- **Handshake Mutex** — Protects the bootstrap lifecycle from race conditions during simultaneous socket connections or manual refreshes.
- **LAN Security** — Hardened CORS origin validation that permits access from local network IPs (192.168.x.x, etc.) while blocking public traffic.
- **High Coverage** — Core logic is rigorously verified with comprehensive unit and integration tests (93%+ line coverage for critical services).

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
  providerRegistry.js    — Loads multi-provider configuration registry
  providerRuntimeManager.js — Manages isolated ACP client instances per provider
  providerLoader.js      — Loads provider config, resolves env vars
  acpClient.js           — ACP connection lifecycle, JSON-RPC handshake, request/response,
                            drain, permissions, provider extension routing
  acpUpdateHandler.js    — Routes updates; implements "Sticky Metadata" to preserve tool context
  acpTitleGenerator.js   — Auto-generates chat titles via a secondary ACP session using the configured `titleGeneration` model ID
  modelOptions.js        — Normalizes dynamic ACP model catalogs, currentModelId, quick-access entries, and raw ID resolution
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
| `session/new` | Creates session with `cwd`, `mcpServers`, and optional provider-specific params from `buildSessionParams` (e.g. `_meta` for agent forwarding); captures dynamic model catalog and `currentModelId` when advertised |
| `session/load` | Resumes session with `mcpServers` and optional provider-specific params from `buildSessionParams`; captures restored model state and immediately re-applies the DB model if needed |
| `session/prompt` | `prompt` field; array of ContentBlock |
| `session/set_model` | Sets model using the real **Model ID** from the dynamic catalog or provider quick-access fallback |
| `session/set_mode` | Sets agent mode |
| `session/configure` / provider-specific `session/set_config_option` | Sets per-session dynamic configuration options through the provider hook |
| `session/cancel` | Notification (no response expected) |

Incoming updates arrive as `session/update` notifications with `sessionUpdate` types: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `usage_update`, `turn_end`.

Permission requests arrive as `session/request_permission` with JSON-RPC `id`; responded with `outcome: 'selected'` or `outcome: 'cancelled'`.

## Features

- **Multi-provider system** — concurrent support for multiple ACP providers isolated by ID
- **Dynamic model discovery** — captures provider-advertised model catalogs from ACP responses or model-shaped config options, persists `currentModelId`/`modelOptions`, and emits `session_model_options`
- **Model re-apply on load** — saved chats restore the DB-selected model immediately during session load instead of waiting for the next prompt
- **Per-workspace agents** — `create_session` accepts `cwd` and `agent`; forwarded to the daemon via `buildSessionParams` (spawn-time) and `setInitialAgent` (post-creation), depending on the provider's implementation
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
- **Agent hooks** — `session_start`, `pre_tool`, `post_tool`, and `stop` hooks isolated per provider
- **Custom commands** — loaded from `commands.json`, emitted to UI on connect
- **Workspace config** — `workspaces.json` with label/path/agent/pinned per workspace
- **Scratch pad notes** — per-session markdown notes stored in SQLite
- **Canvas artifacts** — per-session code artifacts with file sync
- **Image compression** — attachments compressed via `sharp` before sending to ACP
- **Whisper STT** — whisper-server auto-starts, model stays loaded in memory
- **Environment editor** — read/write `.env` via socket events
- **Stdio MCP proxy architecture** — tools executed via /api/mcp/tool-call, no separate HTTP port
- **MCP tools: ux_invoke_shell** — Executes shell commands via `node-pty` with live streaming to the UI (`tool_output_stream` event), ANSI stripping, 30-min inactivity timeout, and heartbeat to keep MCP connection alive
- **Sub-agent system** — `ux_invoke_subagents` MCP tool spawns parallel ACP sessions, each visible in the UI as a child session; tracked by `subAgentRegistry`; emits `sub_agent_started`/`sub_agent_completed` events; ephemeral session files cleaned up via `acpCleanup`
- **Counsel tool** — `ux_invoke_counsel` MCP tool spawns Advocate, Critic, Pragmatist + optional domain experts via `ux_invoke_subagents`; agent roles configured in `counsel.json`
- **Sub-agent cancellation** — `cancel_prompt` aborts running sub-agents isolated by provider context before cancelling the parent session

## Testing

```bash
npx vitest run              # 527 tests across 56 files
npx vitest run --coverage
```
