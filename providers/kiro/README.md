# Kiro ACP Provider for AcpUI

This provider integrates AcpUI with Kiro, an extensible ACP-based agent platform.

## Configuring Agents and Tool Permissions

### 1. Creating Custom Agents

Custom agents allow you to create task-specific configurations with instructions, models, and tool access. These should be stored in:

```
~/.kiro/agents/
```

Each agent is a JSON file that defines:
- The agent name and description
- Default model for this agent
- Which tools are available (`tools`)
- Which tools are pre-trusted (`allowedTools`)
- Optional hooks for session lifecycle (`session_start`, `post_tool`, `stop`)

**Example agent configuration:**

```json
{
  "name": "code-reviewer",
  "description": "Reviews code with AcpUI tools enabled",
  "model": "claude-opus-4.6",
  "tools": [
    "read_file",
    "grep",
    "@AcpUI/*"
  ],
  "allowedTools": [
    "read_file",
    "grep",
    "@AcpUI/ux_invoke_shell"
  ],
  "hooks": {
    "post_tool": {
      "matcher": "read_file",
      "prompt": "Summarize what you learned from this file."
    }
  }
}
```

### 2. Using AcpUI's Enhanced Tools (Recommended)

Kiro has native system tools (`shell`, `subagent`) that provide basic functionality. However, AcpUI's versions of these tools offer a superior user experience:
- **`ux_invoke_shell`** — Live colored shell output with real-time streaming (vs. Kiro's basic `shell`)
- **`ux_invoke_subagents`** — Agent orchestration view showing parallel agent execution, not just raw output (vs. Kiro's basic `subagent`)

To use AcpUI's enhanced versions, exclude Kiro's native system tools from the agent's `tools` array and include AcpUI's tools instead:

```json
{
  "name": "my-agent",
  "model": "claude-opus-4.6",
  "tools": [
    "read_file",
    "write_file",
    "grep",
    "@AcpUI/*"
  ],
  "allowedTools": [
    "read_file",
    "@AcpUI/*"
  ]
}
```

In this configuration:
- Kiro's native `shell` is NOT listed, so it's not available
- Kiro's native `subagent` is NOT listed, so it's not available
- AcpUI's `@AcpUI/ux_invoke_shell` IS listed, giving you live colored output
- AcpUI's `@AcpUI/ux_invoke_subagents` provides the orchestration view

### 3. How Tool Permissions Work

Kiro uses a two-level permission system:

**`tools` array — What the agent can see**

The `tools` array defines which tools are discoverable and available to the agent. Tools not listed here are completely hidden — Kiro never presents them as options.

**`allowedTools` array — What's pre-trusted**

The `allowedTools` array specifies which tools execute without requiring confirmation. Tools in this list skip the permission prompt. Tools not in this list but present in the `tools` array will prompt for user confirmation before execution.

**Blocking tools (implicit)**

There is no explicit "disallow" field. Instead, tools are blocked by omitting them from the `tools` array. If a tool is not listed in `tools`, it's not discoverable and cannot be used.

### 4. Referencing AcpUI Tools

AcpUI injects an MCP server named `AcpUI` with three tools:
- `ux_invoke_shell` — Execute shell commands
- `ux_invoke_subagents` — Spawn parallel AI agents
- `ux_invoke_counsel` — Multi-perspective analysis

To use these in a Kiro agent, reference them with the `@AcpUI/` prefix:

**Discover all AcpUI tools:**

```json
{
  "tools": [
    "@AcpUI/*"
  ],
  "allowedTools": [
    "@AcpUI/*"
  ]
}
```

**Discover specific AcpUI tools:**

```json
{
  "tools": [
    "@AcpUI/ux_invoke_shell",
    "@AcpUI/ux_invoke_subagents",
    "read_file",
    "write_file"
  ],
  "allowedTools": [
    "@AcpUI/ux_invoke_shell",
    "read_file"
  ]
}
```

In this example:
- `ux_invoke_shell` is pre-trusted (no confirmation needed)
- `ux_invoke_subagents` and built-in tools (`read_file`, `write_file`) require confirmation
- `ux_invoke_counsel` is not discoverable

**Wildcard support:**

Both `tools` and `allowedTools` support wildcards:

- `@AcpUI/*` — All AcpUI tools
- `@AcpUI/ux_*` — All AcpUI UX tools (`ux_invoke_shell`, `ux_invoke_subagents`, `ux_invoke_counsel`)
- `read_*` — All built-in tools starting with `read_`

---

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

### Context Usage Persistence

Kiro context usage is cached in `{paths.home or ~/.kiro}\acp_session_context.json` whenever a metadata extension includes `contextUsagePercentage`. On backend restart or hot-session reuse, AcpUI calls `emitCachedContext(sessionId)` after the session ID is known so the footer and session settings show the last context percentage before another prompt is sent.

## Dynamic Models

Kiro advertises its full model catalog in the `models` object returned from `session/new` and `session/load`:

- `models.currentModelId` is the active real model ID.
- `models.availableModels[]` contains entries shaped as `{ modelId, name, description }`.

AcpUI normalizes those entries into the shared `{ id, name, description }` contract, persists them with the session, and shows the complete catalog in the session settings Config tab.

`user.json` can define any number of `models.quickAccess[]` entries for the chat footer. They must use the exact real model IDs Kiro reports. For current Kiro CLI samples, versioned Claude IDs use dots, not hyphens:

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

See the [Provider System feature doc](<../../documents/[Feature Doc] - Provider System.md>) for the full schema specification.
