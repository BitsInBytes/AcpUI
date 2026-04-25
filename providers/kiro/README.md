# Kiro ACP Provider

Technical reference for Kiro-specific protocol behavior, data format quirks, and configuration. General AcpUI features (sub-agents, shell tool, permissions, compaction) are documented in the main backend README.

## Protocol

The provider spawns the executable defined in `user.json` as a child process. Communication is JSON-RPC 2.0 over NDJSON (newline-delimited JSON) on stdin/stdout.

The `protocolPrefix` for this provider is `_kiro.dev/`. This is configured in `provider.json` and used to route extension events.

## Data Normalization

The provider's wire format differs from the standard ACP format in several ways that `index.js` normalizes before the backend processes updates.

### PascalCase Update Types

Updates may use PascalCase types (e.g. `AgentMessageChunk`). The provider converts these to snake_case (`agent_message_chunk`) and maps them to `sessionUpdate`.

### Flat String Content

Updates may send `content` as a plain string. The provider wraps these into `{ text: "..." }` objects for consistency.

### Tool Output (`rawOutput.items`)

Tool results are returned in `rawOutput.items[]` rather than standard `content[]`. Each item is typically:

- `{ Text: "..." }` — plain text
- `{ Json: { content: [{ text }] } }` — structured content
- `{ Json: ... }` — arbitrary JSON (serialized to string)

Plain success messages are suppressed so that file diffs from `tool_start` are preserved in the UI.

### Tool Name Resolution

Tool call IDs may use generic identifiers. When this occurs, the provider infers the tool name from the `title` field mapping it to standard identifiers like `bash`, `list_directory`, `read_file`, `write_file`, and `replace`.

### File Path Extraction

File paths are extracted from multiple locations depending on the tool:

1. `locations[0].path` — primary source for file tools
2. `content[0].path` — used in diff updates
3. `arguments.path`, `arguments.file_path`, `arguments.filePath` — standard tool input fields

### Diff Extraction

File diffs are sent in `content[]` items with `type: "diff"`. For write operations, diffs are constructed from the command parameters and the corresponding content fields.

## Extension Protocol

Extension events are sent as JSON-RPC notifications using the `protocolPrefix`. The provider maps these to typed events:

| Extension method | Emitted type | Key fields |
|-----------------|-------------|------------|
| `commands/available` | `commands` | `commands` |
| `metadata` | `metadata` | `sessionId`, `contextUsagePercentage` |
| `compaction/status` | `compaction` | `sessionId`, `status`, `summary` |
| `agent/switched` | `agent_switched` | `sessionId`, `agentName`, `previousAgentName`, `currentModelId` |
| `session/update` | `session_update` | (pass-through) |

`metadata` typically arrives just before `end_turn` and carries the context usage percentage displayed in the UI.

## Dynamic Models

Kiro advertises its full model catalog in the `models` object returned from `session/new` and `session/load`:

- `models.currentModelId` is the active real model ID.
- `models.availableModels[]` contains entries shaped as `{ modelId, name, description }`.

AcpUI normalizes those entries into the shared `{ id, name, description }` contract, persists them with the session, and shows the complete catalog in the session settings Config tab.

The three `user.json` model entries are only quick-access aliases for the chat footer. They must use the exact real model IDs Kiro reports. For current Kiro CLI samples, versioned Claude IDs use dots, not hyphens:

- `claude-opus-4.6`
- `claude-sonnet-4.6`
- `claude-haiku-4.5`

Kiro also reports the active model as `model` on `_kiro.dev/agent/switched`. The provider normalizes that field to `currentModelId` so agent changes update the same model state as session creation, session load, and explicit `session/set_model`.

## Session Files

Sessions are persisted to disk in the directory specified by `paths.sessions`:

| File | Purpose |
|------|---------|
| `{acpId}.jsonl` | Conversation log (one JSON entry per line) |
| `{acpId}.json` | Session metadata |
| `{acpId}/` | Task list files |

## Agent Switching

This provider uses a prompt-based mechanism (e.g., a slash command) to switch the active agent for a session. This is handled before the first user prompt, and the confirmation response is drained so it does not appear as a chat message.

Important: do not replace this with Kiro's advertised native mode-setting API. The CLI currently advertises a built-in mode switch function, but calling `session/set_mode` crashes the ACP process. This is a Kiro CLI bug, not an AcpUI protocol preference.

The intentional workaround is:

1. Begin a drain for the session.
2. Send `/agent <agentName>` as a `session/prompt`.
3. Wait for the drain to finish so Kiro's agent-switch confirmation does not surface in the chat.
4. Continue with the user's first real prompt.

This keeps agent selection reliable until Kiro's native mode-setting implementation is fixed.

## Hooks

Hooks are defined per-agent in the agent definition files. Supported hook types include:

| Hook | Trigger | Executed by |
|------|---------|-------------|
| `session_start` | Session created | AcpUI backend |
| `pre_tool` | Before a tool call | AcpUI backend |
| `post_tool` | After a tool call | AcpUI backend |
| `stop` | After a turn ends | **ACP engine** |

Specific hooks like `stop` are executed by the ACP engine itself. The backend does not invoke them to avoid double execution.

### post_tool Matcher

The `matcher` field filters which tool calls trigger a `post_tool` hook by matching against tool titles or categories.

## Configuration

Configuration is split across `provider.json` (protocol identity), `branding.json` (UI labels), and `user.json` (local machine settings).

See the [PROVIDERS.md](../../PROVIDERS.md) in the project root for the full schema specification.
