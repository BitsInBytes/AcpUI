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

### 1. Block Codex's Built-In System Tools and Steer Tool Usage (Recommended for Better UX)

**Why:** Codex has native system tools (like `shell_tool` and `multi_agent`) that are available by default. By default, the LLM might prefer these over AcpUI's tools. Unlike other ACP providers, Codex requires explicit steering instructions to reliably use the AcpUI tools.

AcpUI's versions of these tools provide a superior user experience:
- **`ux_invoke_shell`** — Live colored shell output with real-time streaming, interactive terminal with user input
- **`ux_invoke_subagents`** — Agent orchestration view showing parallel agent execution with live progress
- **`ux_invoke_counsel`** — Multi-perspective evaluation with Advocate, Critic, Pragmatist, and domain experts

#### Step 1: Disable Codex's Built-In System Tools

**Configuration File Location:**
- macOS/Linux: `~/.codex/config.toml`
- Windows: `%USERPROFILE%\.codex\config.toml`

Add the following to disable the built-in shell and agent tools:

```toml
[features]
shell_tool = false
multi_agent = false
```

#### Step 2: Create AGENTS.md to Steer Tool Usage (Critical for Codex)

Codex's LLM benefits from explicit instructions on which tools to use and when. Create an `AGENTS.md` file in your Codex home directory to provide global agent steering:

**File Location:**
- macOS/Linux: `~/.codex/AGENTS.md`
- Windows: `%USERPROFILE%\.codex\AGENTS.md`

**Example AGENTS.md:**

```markdown
# Codex Agents Configuration

This file provides steering instructions for all Codex agents to properly use AcpUI tools.

## Global Tool Usage Instructions

### Always Use AcpUI Tools for System Interaction

You have access to three powerful AcpUI tools through the AcpUI MCP server. Use these tools for system interaction instead of built-in alternatives:

1. **ux_invoke_shell** — Execute shell commands with interactive terminal support
   - **When to use:** Any time you need to run shell commands, scripts, tests, builds, or terminal operations
   - **Why it's better:** Provides live colored output, real-time streaming, and interactive terminal with user input support
   - **Example:** Running `npm test`, `git status`, `python script.py`, system commands
   - **Prefer this over:** Any built-in shell tool alternatives

2. **ux_invoke_subagents** — Spawn parallel AI agents to work on independent tasks
   - **When to use:** Breaking down complex tasks into parallel independent work streams
   - **Why it's better:** Shows live progress for each agent, enables parallel execution, provides clear orchestration view
   - **Example:** Reviewing multiple files in parallel, running independent analyses, parallel testing
   - **Prefer this over:** Sequential processing or built-in agent alternatives

3. **ux_invoke_counsel** — Get multi-perspective evaluation on decisions
   - **When to use:** Before making architectural decisions, evaluating approaches, or assessing trade-offs
   - **Why it's better:** Provides Advocate (for), Critic (against), Pragmatist (practical), and optional domain experts
   - **Example:** Evaluating authentication approaches, assessing refactoring strategies, reviewing design decisions
   - **Always use for:** Major architectural decisions, technology selection, significant refactoring choices

## Important Notes

- **AcpUI tools are always available** — They are injected into every session via the AcpUI MCP server
- **Prefer AcpUI over built-in tools** — AcpUI tools provide better UX, streaming, and integration
- **Interactive shell support** — The `ux_invoke_shell` tool supports user input, terminal resize, and Ctrl+C handling
- **Non-blocking agent spawning** — Use `ux_invoke_subagents` when you need parallel execution
- **Always evaluate decisions** — Use `ux_invoke_counsel` before committing to major decisions

## Agent Defaults

Unless you create a custom agent configuration, all agents should:
1. Prefer AcpUI tools (ux_invoke_shell, ux_invoke_subagents, ux_invoke_counsel)
2. Use these tools for their intended purposes as described above
3. Avoid falling back to built-in alternatives even if they exist
```

**Why this matters for Codex:**

- **Explicit steering** — Codex's LLM tends to use whatever tools it sees first in the tool list. This markdown provides clear guidance on which tools to prioritize
- **Use case examples** — Showing concrete examples helps the LLM make better decisions about which tool to use
- **Decision rationale** — Explaining *why* AcpUI tools are better helps the LLM internalize the preference
- **Consistent behavior** — All agents benefit from the same steering without needing to configure each one individually

#### Step 3: Create Custom Agents with Tool Steering (Optional)

For even more precise control, you can create custom agent configurations that combine tool preferences with task-specific instructions. This is covered in Section 3 below.

**Tip:** The AGENTS.md file is read by Codex's internal system prompt mechanism, so changes take effect on the next session creation.

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
- Prunes cloned rollouts by user-turn boundaries, cutting at the next turn start so no orphan user prompt records remain.
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
