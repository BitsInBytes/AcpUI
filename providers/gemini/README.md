# Gemini ACP Provider for AcpUI

This provider integrates AcpUI with the Gemini CLI operating in ACP (Agent Client Protocol) mode.

## Configuring Tool Permissions

AcpUI injects core MCP tools (`ux_invoke_shell`, `ux_invoke_subagents`, `ux_invoke_counsel`) into your Gemini sessions. When enabled in `configuration/mcp.json`, AcpUI can also advertise optional IO tools (`ux_read_file`, `ux_write_file`, `ux_replace`, `ux_list_directory`, `ux_glob`, `ux_grep_search`, `ux_web_fetch`) and `ux_google_web_search`. Gemini also has native system tools with overlapping functionality. For the best experience, you should configure AcpUI's enhanced versions as the preferred tools.

### 1. Block Gemini's System Tools (Recommended for Better UX)

**Why:** Gemini has native system tools (`run_shell_command` and `invoke_agent`) that are always discoverable. By default, the LLM will prefer these over AcpUI's tools because they appear first in Gemini's tool list.

However, AcpUI's versions of these tools provide a superior user experience:
- **`ux_invoke_shell`** — Live colored shell output with real-time streaming
- **`ux_invoke_subagents`** — Agent orchestration view showing parallel agent execution, not just raw output
- **Optional IO/Search MCP tools** — Available only when enabled in `configuration/mcp.json` before creating the session

To get the best experience, exclude Gemini's native system tools so the LLM uses AcpUI's enhanced versions:

```json
{
  "tools": {
    "exclude": [
      "run_shell_command",
      "invoke_agent"
    ]
  }
}
```

This way, the LLM will use AcpUI's tools which integrate seamlessly with the UI for better visibility and control.

### 2. Trusting AcpUI Tools (Recommended)

Global settings act as a "Security Guard" — they define hard boundaries that apply to every session you run.

**Configuration File Location:**
- Windows: `%USERPROFILE%\.gemini\settings.json`
- macOS/Linux: `~/.gemini/settings.json`

Add this to your settings file to auto-approve all AcpUI tools:

```json
{
  "tools": {
    "allowed": [
      "mcp_AcpUI_*"
    ]
  }
}
```

If the file doesn't exist, create it. If it already has content, merge the `tools` section carefully (preserve existing config).

**What this does:** Tools matching the pattern `mcp_AcpUI_*` will execute without permission prompts. This includes:
- `mcp_AcpUI_ux_invoke_shell` — Execute shell commands (ls, npm, git, etc.)
- `mcp_AcpUI_ux_invoke_subagents` — Spawn parallel AI agent threads
- `mcp_AcpUI_ux_invoke_counsel` — Launch multi-agent review (Advocate, Critic, Pragmatist)

**Alternative: Explicit tool list (more restrictive)**

If you prefer to approve each tool individually:

```json
{
  "tools": {
    "allowed": [
      "mcp_AcpUI_ux_invoke_shell",
      "mcp_AcpUI_ux_invoke_subagents",
      "mcp_AcpUI_ux_invoke_counsel"
    ]
  }
}
```

### 3. Blocking Additional Tools (Optional)

Beyond blocking Gemini's system tools, you can also prevent specific AcpUI tools from being discovered or used. **Excluded tools are removed from the model's available tools list — the model never sees them.**

**Block specific AcpUI tools:**

```json
{
  "tools": {
    "exclude": [
      "mcp_AcpUI_ux_invoke_shell"
    ]
  }
}
```

This prevents `ux_invoke_shell` from being available to the model, while allowing `ux_invoke_subagents` and `ux_invoke_counsel` to work normally. No permission prompts are shown — the tool is simply hidden from the model.

**Block all AcpUI tools with a wildcard:**

```json
{
  "tools": {
    "exclude": [
      "mcp_AcpUI_*"
    ]
  }
}
```

**Block the entire AcpUI MCP server:**

```json
{
  "mcp": {
    "excluded": [
      "AcpUI"
    ]
  }
}
```

This prevents all AcpUI tools from being discovered by the model, even if they're in the `allowed` list.

**How precedence works:**

1. **Exclusions always win** — If a tool is in `tools.exclude` or `mcp.excluded`, it is removed from the available tools list even if it's in `tools.allowed`
2. **MCP exclusions are strongest** — `mcp.excluded` removes all tools from that server regardless of `tools.allowed` or `tools.exclude`
3. **No permission prompts** — Excluded tools don't require user approval because the model never sees them

**Combining allow and exclude:**

```json
{
  "tools": {
    "allowed": [
      "mcp_AcpUI_ux_invoke_shell",
      "mcp_AcpUI_ux_invoke_subagents",
      "mcp_AcpUI_ux_invoke_counsel"
    ],
    "exclude": [
      "mcp_AcpUI_ux_invoke_counsel"
    ]
  }
}
```

In this case, `ux_invoke_shell` and `ux_invoke_subagents` are auto-approved, while `ux_invoke_counsel` is hidden from the model (not available, no permission prompt needed).

---

## Requirements

Install the Gemini CLI globally or ensure it is accessible in your PATH:

```bash
npm install -g @google/gemini-cli
```

Register the provider in AcpUI's `configuration/providers.json`:

```json
{
  "providers": [
    { "id": "gemini", "path": "providers/gemini", "label": "Gemini" }
  ]
}
```

## Runtime Flow

1. AcpUI loads `provider.json` and `user.json`.
2. AcpUI calls `prepareAcpEnvironment()`:
   - Does **not** inject `GEMINI_API_KEY` (this would destroy OAuth tokens)
   - If OAuth is enabled (`fetchQuotaStatus: true`), starts background quota fetching immediately
3. AcpUI spawns `node <path_to_gemini_cli_dist> --acp` (or `gemini --acp`).
4. The provider sends `initialize` and `authenticate` in parallel to the daemon.
5. The provider extracts standardised timelines and parses the `.jsonl` files stored in `~/.gemini/tmp`.
6. Quota status appears in the Provider Status panel **immediately** (if enabled), even before the first prompt.

## Session Files

Gemini CLI isolates session files under hashed project directories:

```
~/.gemini/tmp/<project-hash>/chats/session-<timestamp>-<shortId>.jsonl
```

The `<shortId>` is the **first 8 characters** of the session UUID (e.g. `a1b2c3d4` from `a1b2c3d4-e5f6-7890-...`). The provider scans `~/.gemini/tmp` for files whose name contains this prefix to locate the correct file.

> **Common mistake:** Using the last UUID segment (`.split('-').pop()`) gives you the 12-character tail and will never match any file. Use `.split('-')[0]` instead.

## Authentication & Quota Status

Gemini ACP requires explicit authentication. You have two options, which affect what features are available:

### Option 1: API Key (Standard)
Set the `apiKey` field in `user.json`:
```json
{
  "apiKey": "YOUR_GEMINI_API_KEY"
}
```
The key is passed exclusively via the `authenticate` ACP request (`_meta.api-key`). It is **not** injected as a `GEMINI_API_KEY` environment variable into the Gemini CLI process — doing so would cause the CLI to persist the key to `~/.gemini/settings.json` at startup, permanently overwriting any previously configured OAuth method.

**Note:** If you use an API key, the Quota Status feature (showing remaining API limits in the UI) is **not available**, as it requires an OAuth token to query Google's Cloud Code APIs.

### Option 2: OAuth (Advanced — Enables Quota Status)
If you omit the `apiKey` field, the Gemini CLI falls back to credentials it saved from a previous interactive `gemini login` session (`~/.gemini/oauth_creds.json`). 

If you use this method, you can opt-in to seeing your live API quota directly in the AcpUI Provider Status panel by setting `fetchQuotaStatus` to `true`:
```json
{
  "fetchQuotaStatus": true
}
```

When enabled, the provider:

1. **Derives the OAuth client ID** at runtime from the `azp` field of the JWT `id_token` in `~/.gemini/oauth_creds.json`. This ensures AcpUI automatically adapts if the Gemini CLI updates its OAuth credentials, with no code changes required.

2. **Discovers your internal Google Cloud project ID** via the `cloudcode-pa.googleapis.com/v1internal:loadCodeAssist` endpoint. Free-tier users without a Cloud project will see quota checks skipped gracefully.

3. **Manages token refresh reactively** (on 401 responses). The provider reads the current token, attempts the quota request, and only refreshes the token if it receives a 401 Unauthorized response. It then re-reads from disk (another process may have refreshed it), retries, and if still 401, calls the Google OAuth token endpoint to refresh and save new credentials.

4. **Polls the quota API** every 30 seconds and immediately after each prompt completes (`end_turn`).

5. **Shows quota status immediately** — the Provider Status panel displays usage data as soon as AcpUI starts, even before the first chat message. Status updates with each refresh cycle.

The Gemini quota system tracks usage based on the **model type** used (e.g., Flash, Pro, Light) over a **24-hour rolling period**. The UI displays the usage percentage and exact reset time for each model tier.

## Context Usage Percentage

AcpUI accurately displays the percentage of the context window you have used in the footer next to the model selector.

Because the Gemini CLI natively emits erratic `usage_update` events during streaming (which can cause the UI to temporarily display wildly inflated numbers like 1300%), the AcpUI provider actively swallows those intermediate chunks. Instead, it precisely calculates the true context usage at the end of the turn using the final `input_tokens` count against the model's hardcoded 1M token context window.

### Context Usage Persistence

Gemini context usage is cached in `~/.gemini/acp_session_tokens.json` when turns complete. On backend restart or hot-session reuse, AcpUI calls the provider's `emitCachedContext(sessionId)` hook after the session ID is known so the footer and session settings can show the last context percentage before another prompt is sent.

## Implementation Notes

These are non-obvious behaviours discovered by capturing live protocol traffic. Violating any of them causes silent failures.

### Handshake ordering

Gemini CLI **holds the `initialize` response** until `authenticate` completes. Both requests must therefore be sent before awaiting either response:

```js
// Correct — both in flight simultaneously
const initPromise  = transport.sendRequest('initialize', { ... });
const authPromise  = transport.sendRequest('authenticate', { ... });
await Promise.all([initPromise, authPromise]);
```

Sending `authenticate` only after `initialize` returns will time out, because `initialize` never returns until `authenticate` arrives. Additionally, the `initialize` response can take 30–90 seconds if the CLI is loading extensions, memory, or project configuration — this is normal.

### Do not claim `fs` capability

The `initialize` request must **not** include `fs` in `clientCapabilities`:

```js
// Correct
clientCapabilities: { terminal: true }

// Wrong — causes write tools to stall indefinitely
clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true }
```

When `fs` is claimed, Gemini CLI routes every file read/write through JSON-RPC requests back to the client (`fs/read_text_file`, `fs/write_text_file`). If the client doesn't respond to these, file operations hang silently forever. Since AcpUI and Gemini CLI run on the same machine, the CLI can access the filesystem directly — no proxy is needed. See `ACP_PROTOCOL_SAMPLES.md` §14 for the full FS proxy wire format if you ever need to implement it.

### Mode IDs are camelCase

`session/set_mode` uses camelCase mode IDs, matching what the daemon advertises in `session/new`:

| Correct | Wrong |
|---|---|
| `autoEdit` | `auto_edit` |
| `default` | `default` ✓ (no change) |
| `yolo` | `yolo` ✓ (no change) |
| `plan` | `plan` ✓ (no change) |

Sending `auto_edit` returns a `-32603` error: `"Invalid or unavailable mode: auto_edit"`.

### `session/load` history drain

When loading a session, Gemini CLI streams the conversation history as `session/update` notifications both **before and after** the `session/load` JSON-RPC result arrives. The client must drain all of them. The sequence is:

```
→ session/load request
← user_message_chunk   (history, before result)
← session/load result  (modes + models, no sessionId field)
← tool_call (status: "completed")  (history, after result)
← agent_message_chunk  (history, after result)
← available_commands_update
```

History tool calls are replayed as a single `tool_call` with `status: "completed"` — not as the live `in_progress` → `tool_call_update` sequence.

## Troubleshooting

Ensure the `command` and `args` in `user.json` point to a valid executable path. If you build from source, point to `dist/index.js` explicitly.

```json
{
  "command": "node",
  "args": ["C:\\Location-Of\\gemini-cli-main\\packages\\cli\\dist\\index.js", "--acp"]
}
```
