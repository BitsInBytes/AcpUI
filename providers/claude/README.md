# Claude Provider for AcpUI

This provider integrates AcpUI with [claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp), the Claude ACP daemon.

## Configuring Agents and Tool Permissions

### 1. Creating Custom Agents

Custom agents allow you to create "personas" with specific instructions and tool access. These should be stored in:
- `~/.claude/agents/` (for yourself)
- `<project>/.claude/agents/` (to share with the team)

Claude Code via the CLI has a built-in way to create these agent files that makes getting a basic agent up and running quick. Note: the `disallowedTools` in the YAML frontmatter does not actually disable the tools for the agent—they can still see the tools and invoke them. This is a known Claude Code bug.

```yaml
---
description: A concise description of what this agent does.
prompt: A detailed system prompt defining its persona and rules.
allowedTools: [Read, Glob, Grep, etc]
disallowedTools: [Bash, PowerShell]
---

# Agent Content

This is where your system prompt for this agent is and can be as detailed as you want.
```

### 2. Configuring Global Permissions (settings.json)

Global settings act as the "Security Guard." They define hard boundaries that apply to every session and every agent you run.

**Configuration File Location:**
- macOS/Linux: `~/.claude/settings.json`
- Windows: `%USERPROFILE%\.claude\settings.json`

**Setting Up Allow Rules:**

Permissions are managed within a `permissions` object using `allow` and `deny` arrays. Use the allow suggestion below if you want all UI features to work without being asked. Note that the Claude providers code denys the system Bash, Powershell and Agent tools because the AcpUI replaces these tools.

```json
{
  "permissions": {
    "allow": [
      "mcp__AcpUI__*" 
    ]
  }
}
```

**Setting Up Deny Rules (Blocking Tools):**

If you want to block specific tools from being used by Claude, add them to the `deny` array. Denied tools are removed from Claude's available tools — Claude never sees them. Denied rules always take precedence over allow rules.

**Block specific AcpUI tools:**

```json
{
  "permissions": {
    "deny": [
      "mcp__AcpUI__ux_invoke_shell"
    ]
  }
}
```

This prevents `ux_invoke_shell` from being available to Claude, while allowing `ux_invoke_subagents` and `ux_invoke_counsel` to work normally.

**Block all AcpUI tools with a wildcard:**

```json
{
  "permissions": {
    "deny": [
      "mcp__AcpUI__*"
    ]
  }
}
```

**Combining allow and deny:**

```json
{
  "permissions": {
    "allow": [
      "mcp__AcpUI__ux_invoke_shell",
      "mcp__AcpUI__ux_invoke_subagents",
      "mcp__AcpUI__ux_invoke_counsel"
    ],
    "deny": [
      "mcp__AcpUI__ux_invoke_counsel"
    ]
  }
}
```

In this case, `ux_invoke_shell` and `ux_invoke_subagents` are auto-approved, while `ux_invoke_counsel` is blocked from Claude's view (not available, no permission prompt needed). **Denied rules always win** — if a tool is in both `allow` and `deny`, it will be blocked.

## Requirements

Install `claude-agent-acp` from the [agentclientprotocol/claude-agent-acp](https://github.com/agentclientprotocol/claude-agent-acp) project:

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

Then register the provider in AcpUI's `configuration/providers.json`:

```json
{
  "providers": [
    { "id": "claude", "path": "providers/claude", "label": "Claude" }
  ]
}
```

Start AcpUI:

```powershell
.\scripts\run.ps1
```

## Runtime Flow

When the backend starts a Claude ACP process, it:

1. Loads `provider.json` and merges local settings from `user.json`.
2. Calls `prepareAcpEnvironment()` in this provider.
3. Starts the provider-owned Anthropic header proxy unless disabled.
4. Injects `ANTHROPIC_BASE_URL=http://127.0.0.1:{port}` into the Claude ACP child process.
5. Spawns `claude-agent-acp` and performs the ACP handshake.
6. Translates Claude ACP events into AcpUI's normalized timeline and provider status contracts.

## Provider Status and Quota Proxy

Claude quota data is exposed by Anthropic response headers on API calls made by Claude Code. Those calls happen inside the spawned `claude-agent-acp` process, not inside AcpUI. AcpUI cannot see the response headers by reading the ACP JSON-RPC stream alone.

To make the quota data visible without patching Claude ACP or the Anthropic SDK, this provider starts a local HTTP proxy and points the Claude ACP child process at it with `ANTHROPIC_BASE_URL`. The proxy forwards requests to Anthropic, captures `anthropic-ratelimit-*` response headers, and hands the parsed data back to the provider. The provider then emits `_anthropic/provider/status`, which the frontend renders as:

- A compact sidebar summary above the collapse button.
- A details modal containing all quota windows, reset times, capture metadata, and raw headers.

The proxy does not log request bodies or credentials. It only records response headers needed for provider status.

### Proxy Configuration

Disable the provider-owned proxy:

```env
CLAUDE_QUOTA_PROXY=false
```

Forward to a non-default Anthropic base URL:

```env
CLAUDE_QUOTA_PROXY_TARGET=https://api.anthropic.com
```

## Configuration Files

### `provider.json`

- `protocolPrefix`: `_anthropic/` for Claude-specific extension events.
- `mcpName`: `AcpUI`.
- `toolCategories`: maps Claude tool names to AcpUI tool categories.
- `clientInfo`: sent during ACP `initialize`.

### `user.json`

- `command` and `args`: the Claude ACP daemon command to spawn.
- `models`: default model ID, optional `quickAccess` footer entries, title generation model ID, and sub-agent model ID.
- `paths.sessions`: Claude project session files, usually `~/.claude/projects`.
- `paths.agents`: Claude agents, usually `~/.claude/agents`.

### `index.js`

Implements the provider contract:

- `prepareAcpEnvironment()` starts the local quota proxy and injects `ANTHROPIC_BASE_URL`.
- `performHandshake()` initializes the ACP daemon.
- `parseExtension()` maps Claude extension events, including provider status.
- `normalizeUpdate()` passes standard ACP updates through.
- `extractToolOutput()` extracts text from tool results.
- `extractFilePath()` identifies file paths in tool events.
- `normalizeTool()` and `categorizeToolCall()` normalize Claude tool metadata.
- `setConfigOption()` routes model, mode, and reasoning-effort changes to Claude ACP methods.
- `buildSessionParams(agent)` returns provider-specific params to attach to `session/new` and `session/load` ACP requests (see [Agent Support](#agent-support) below).
- `getSessionPaths()`, `cloneSession()`, and `parseSessionHistory()` handle Claude session persistence and history replay.

## Agent Support

Claude Code agents (defined under `~/.claude/agents/`) can be specified when creating or loading a session. The agent name is forwarded by AcpUI to the Claude ACP daemon at subprocess spawn time via the ACP `_meta` field — the only point where it can take effect, since agent context is applied when the Claude Code process starts.

### How it works

When the frontend passes an `agent` name on `create_session`, the backend calls `buildSessionParams(agent)` on this provider, which returns:

```js
{ _meta: { claudeCode: { options: { agent } } } }
```

This is spread into the `session/new` or `session/load` ACP request. The Claude ACP daemon reads `_meta.claudeCode.options.agent` inside `createSession` and passes it to the underlying `query()` call, which spawns Claude Code with the correct agent context.

`setInitialAgent` is intentionally a no-op for this provider — agent context cannot be changed after the subprocess has started.

### Persistence across restarts

The Claude ACP daemon does not persist `_meta` between process restarts. If the daemon restarts and `session/load` is called, the agent context is re-applied automatically because AcpUI re-passes `buildSessionParams(agent)` on every `session/load`. If the session is still alive in the daemon's memory, the running subprocess retains its agent context and the `_meta` is ignored.

## Session Files

Claude sessions are stored under `~/.claude/projects/{encoded-project-path}`.

- `{sessionId}.jsonl`: newline-delimited conversation history used for history replay and fork pruning.
- `{sessionId}.json`: session metadata such as model, permission mode, and usage metadata.
- `{sessionId}/`: per-session task and compaction state.

Claude Code's `.jsonl` history uses `type: "user"` for real user prompts and for internal entries such as tool executions, tool outputs, and local command caveats. Fork pruning must inspect message content and metadata instead of counting every `type: "user"` entry as a real user turn.

See [ACP_PROTOCOL_SAMPLES.md](./ACP_PROTOCOL_SAMPLES.md) for captured Claude ACP protocol details.

## Supported Behavior

| Feature | Notes |
|---------|-------|
| Compaction | Claude ACP supports `/compact`. |
| Named agents | Agent name is forwarded at session creation via `buildSessionParams` → `_meta.claudeCode.options.agent`. Re-applied automatically on every `session/load`. |
| Hooks | AcpUI reads Claude settings hooks and invokes supported session-start and post-tool hooks when an agent is set. |
| Context usage | Claude context usage is reported through extension events. |
| Provider status | Quota windows are captured from Anthropic response headers and rendered through AcpUI's generic provider status UI. |
| Tool metadata | AcpUI applies sticky metadata so delayed tool updates keep useful filenames and generated code. |

### Context Usage Persistence

Claude context usage is cached in `{paths.home or ~/.claude}\acp_session_context.json` when `usage_update` events arrive. On backend restart or hot-session reuse, AcpUI calls `emitCachedContext(sessionId)` after the session ID is known so the footer and session settings show the last context percentage before another prompt is sent.

## Operational Notes

Provider status appears after the first Claude request that returns Anthropic rate-limit headers. Loading AcpUI without starting or resuming a chat may not show quota data because no Anthropic response has passed through the proxy yet.

Claude ACP may buffer some `tool_call_update` messages during long-running operations. AcpUI handles the burst of delayed updates by preserving sticky filenames and useful generated output when the final status messages arrive.

## Troubleshooting

Check daemon availability:

```bash
claude-agent-acp --version
where.exe claude-agent-acp  # Windows
which claude-agent-acp      # Unix
```

Expected backend log lines:

```text
[PROVIDER] Loaded "Claude" from ./providers/claude
[CLAUDE QUOTA] Proxy listening at http://127.0.0.1:{port}, forwarding to https://api.anthropic.com
[CLAUDE QUOTA] Injecting ANTHROPIC_BASE_URL=http://127.0.0.1:{port} for Claude ACP
[ACP] Daemon ready (Claude)
```

If the daemon crashes on startup, verify Claude authentication:

```bash
claude auth login --console
```
