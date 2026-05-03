# Codex ACP Provider for AcpUI

This provider integrates AcpUI with the `codex-acp` executable. It targets the upstream Codex ACP implementation and follows the standard AcpUI provider contract.

## Quick Start

1. Install `codex-acp` so `codex-acp` is available on `PATH`.
2. Ensure `providers/codex/user.json` points at your Codex home directory.
3. Add the provider to `configuration/providers.json`.
4. Start AcpUI. The provider sends ACP `initialize` at daemon startup and starts sessions with `session/new` or `session/load`.

Default local command:

```json
{
  "command": "codex-acp",
  "args": []
}
```

## Authentication

Codex ACP supports three auth methods:

- `chatgpt`
- `codex-api-key`
- `openai-api-key`

The provider defaults to `"authMethod": "auto"`:

- If `CODEX_API_KEY`, `codexApiKey`, or `apiKey` is present, it sends `authenticate` with `codex-api-key`.
- If `OPENAI_API_KEY`, `openaiApiKey`, or `"apiKeyEnv": "OPENAI_API_KEY"` is present, it sends `authenticate` with `openai-api-key`.
- If no key is present, it does not send `authenticate`; Codex uses any saved login in `.codex/auth.json`.

Set `"authMethod": "chatgpt"` only when you want Codex ACP to initiate its browser/device login flow during startup.    

## Quota Status

AcpUI can show Codex usage windows in the provider status panel by reading Codex's saved ChatGPT OAuth credentials and calling the same usage endpoint used by Codex status refreshes.

Enable it in `providers/codex/user.json`:

```json
{
  "fetchQuotaStatus": true,
  "refreshQuotaOAuth": true,
  "quotaStatusIntervalMs": 30000
}
```

When enabled, AcpUI fetches quota status on startup (immediately displaying it in the provider status panel), after completed turns, and on a 30 second poll while a session is active. The primary window is the 5 hour limit, the secondary window is the weekly limit, and credit information is shown in provider status details.

This feature requires a saved ChatGPT login in `%USERPROFILE%\.codex\auth.json`. API key auth does not expose the ChatGPT quota endpoint. If the access token expires, `refreshQuotaOAuth` allows AcpUI to refresh the OAuth tokens and write the updated tokens back to `auth.json`.

## Context Usage Persistence

Codex context usage is cached in `{paths.home}\acp_session_context.json` when `usage_update` events arrive. On backend restart or hot-session reuse, AcpUI calls the provider's `emitCachedContext(sessionId)` hook after the session ID is known so the footer and session settings can show the last context percentage before another prompt is sent.

### OAuth Token Refresh

When token refresh is needed, AcpUI automatically derives the OAuth client ID from the `client_id` field in the access token JWT payload. This means **no configuration is required** — credentials are derived entirely from the saved Codex authentication in `auth.json`.

## Configuring Agents and Tool Permissions

AcpUI injects MCP tools (`ux_invoke_shell`, `ux_invoke_subagents`, `ux_invoke_counsel`) into your Codex sessions. Codex also has native built-in tools with overlapping functionality. For the best experience, you can configure AcpUI's enhanced versions as the preferred tools and manage their permissions.

### 1. Block Codex's Built-In System Tools (Recommended for Better UX)

**Why:** Codex has native system tools (like `shell_tool` and `multi_agent`) that are available by default. By default, the LLM might prefer these over AcpUI's tools.

AcpUI's versions of these tools provide a superior user experience:
- **`ux_invoke_shell`** — Live colored shell output with real-time streaming
- **`ux_invoke_subagents`** — Agent orchestration view showing parallel agent execution, not just raw output

To get the best experience, you can disable Codex's built-in tools in your global config.

**Configuration File Location:**
- macOS/Linux: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

Add the following to disable the built-in shell and agent tools:

```toml
[features]
shell_tool = false
multi_agent = false
```

*Note: On some versions of Codex, setting `shell_tool = false` may aggressively disable any tool with "shell" in the name, including AcpUI's `ux_invoke_shell`. If you find that `ux_invoke_shell` is missing after adding this setting, you must remove `shell_tool = false` (or set it to `true`) to restore it.*

### 2. Blocking Additional Tools (Optional)

You can explicitly control which AcpUI tools are visible to the model.

**Expose only specific tools:**

```toml
[mcp_servers.AcpUI]
enabled_tools = ["ux_invoke_shell", "ux_invoke_subagents"]
# Disabled tools acts as a denylist applied after enabled tools
disabled_tools = ["ux_invoke_counsel"]
```

**Block the entire AcpUI MCP server:**

```toml
[mcp_servers.AcpUI]
enabled = false
```

### 3. Creating Custom Agents

Codex supports custom agents via TOML files. These allow you to create task-specific configurations with custom instructions, models, and tool access.

Store custom agent files in:
- `~/.codex/agents/` (Global)
- `.codex/agents/` (Per-project)

**Example custom agent (`reviewer.toml`):**

```toml
name = "reviewer"
description = "Reviews code for correctness and security."
developer_instructions = """
Review code like an owner. Prioritize bugs, regressions, and missing tests.
"""
model = "gpt-4o"
model_reasoning_effort = "high"

# You can override tool visibility for this specific agent
[features]
shell_tool = false
multi_agent = false

[mcp_servers.AcpUI]
enabled_tools = ["ux_invoke_shell"]
```

You can activate a custom agent by selecting its name in AcpUI when creating a new session, or using the `/agent` slash command.

### 4. Persistent YOLO-Like Mode (Advanced)

If you want to remove the normal approval and sandbox guardrails to approximate a persistent `--yolo` setup, you can configure the approval policy and sandbox mode in your global `config.toml`.

```toml
approval_policy = "never"
sandbox_mode = "danger-full-access"
```

*Warning: Use this only in trusted, disposable, or isolated environments, as it gives Codex unrestricted access to execute commands and write files without asking.*

## Dynamic Models And Config Options

Codex ACP returns dynamic models and config options from `session/new`, `session/load`, `session/set_model`, and `session/set_config_option`.

AcpUI handles them this way:

- `models.availableModels` drives the app's model selector.
- The Codex `model` config option is filtered out to avoid duplicating that selector.
- `reasoning_effort` is marked with `kind: "reasoning_effort"` so it appears in the chat footer and settings.
- `mode` remains a normal provider setting and is routed through `session/set_mode`.

## MCP Tools

AcpUI injects its MCP server into Codex sessions as a stdio server named `AcpUI`. Codex titles MCP tool calls as:

```text
Tool: AcpUI/ux_invoke_shell
```

The provider normalizes those into stable tool names:

- `ux_invoke_shell`
- `ux_invoke_subagents`
- `ux_invoke_counsel`

These names are categorized through `provider.json` so the existing UI rendering works for shell output and agent orchestration events.

## Session Files

Codex rollouts are recursive JSONL files under:

```text
%USERPROFILE%\.codex\sessions\YYYY\MM\DD\rollout-...-<session-uuid>.jsonl
```

The provider:

- Finds sessions recursively by UUID in filename first, then by file content.
- Clones sessions by copying the rollout and replacing the old UUID with the new fork UUID.
- Prunes cloned rollouts by user-turn boundaries.
- Archives/restores rollouts while preserving the original dated directory.
- Parses `event_msg` and `response_item` records for rehydration.

## Tests

Run the provider tests from the repository root:

```powershell
npm --prefix backend test -- ../providers/codex/test/index.test.js
```

The socket session capture path is covered by:

```powershell
npm --prefix backend test -- test/sessionHandlers.test.js
```
