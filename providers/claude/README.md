# Claude Provider for AcpUI

This provider integrates **claude-agent-acp** (the official Claude ACP daemon) into AcpUI.

## Status

- ✅ **MVP Complete** — Provider wiring, configuration, and basic integration
- ⏳ **Future: SDK Header Patching** — See [SDK_PATCHING_PLAN.md](./SDK_PATCHING_PLAN.md) for real-time quota headers

## Quick Start

### 1. Install claude-agent-acp

```bash
npm install -g @agentclientprotocol/claude-agent-acp
```

### 2. Switch Provider in AcpUI

In `.env`:
```env
ACP_PROVIDER=./providers/claude
```

### 3. Start AcpUI

```powershell
.\scripts\run.ps1
```

The backend will:
1. Load `provider.json`
2. Spawn `claude-agent-acp` as the ACP daemon
3. Perform the handshake
4. Frontend receives branding and is ready

## Configuration Files

### `provider.json`

Core configuration:
- **Models:** Opus 4.7 (flagship), Sonnet 4.6 (balanced)
- **Paths:** Session files at `~/.claude/projects`, agents at `~/.claude/agents`

- **Extension prefix:** `_anthropic/` for provider-specific events

### `index.js`

Implements the provider interface:
- `normalizeUpdate()` — Claude uses standard ACP protocol (no normalization needed)
- `extractToolOutput()` — Extract text from tool results
- `extractFilePath()` — Find file paths in tool events
- `getSessionPaths()` — Resolve session file locations
- `cloneSession()` — Fork session with history pruning
- Path helpers: `getSessionDir()`, `getAttachmentsDir()`, `getAgentsDir()`

## Architecture

```
┌──────────────────────────────────────────┐
│ AcpUI Frontend (React)                   │
│ - Displays branding, models, context     │
└────────────────┬─────────────────────────┘
                 │ Socket.IO
┌────────────────▼─────────────────────────┐
│ AcpUI Backend (Node.js)                  │
│ - Reads provider.json                    │
│ - Spawns claude-agent-acp daemon         │
│ - Multiplexes sessions via JSON-RPC 2.0  │
│ - Calls provider hooks (index.js)        │
└────────────────┬─────────────────────────┘
                 │ stdin/stdout (ND-JSON)
┌────────────────▼─────────────────────────┐
│ claude-agent-acp (ACP Daemon)            │
│ - Uses @anthropic-ai/claude-agent-sdk    │
│ - Spawns one persistent Query per session│
│ - Streams responses via JSON-RPC 2.0     │
└──────────────────────────────────────────┘
```

## Session File Structure

Sessions are stored at `~/.claude/projects/{sessionId}`:

- **`{sessionId}.jsonl`** — Newline-delimited JSON log of conversation events
  - Contains all user prompts, assistant messages, tool calls
  - Used for session history and recovery
  - **Quirk: Internal Meta & Tool Messages as "User" Turns.** Claude Code's `.jsonl` format is highly unusual. It treats almost *everything* as a `type: "user"` message. This includes:
    1. The initial hidden context caveat (`<local-command-caveat>`)
    2. Tool executions (`<command-name>`)
    3. Tool outputs (`<local-command-stdout>`)
  - **Pruning Requirement:** When cloning or pruning sessions (e.g., during a fork), you cannot simply count `entry.type === 'user'`. You must inspect the message content or `isMeta` flag to distinguish genuine user prompts from internal commands and caveats. Otherwise, the pruned file will be prematurely truncated, resulting in zero conversation history when loaded.

- **`{sessionId}.json`** — Session metadata
  - Model, permission mode, tool settings
  - Context window size, token usage

- **`{sessionId}/`** — Directory for tasks, compaction state, etc.

See [INTEGRATION_GUIDE.md](./INTEGRATION_GUIDE.md) for JSON-RPC protocol details.

## Features Enabled

| Feature | Support | Notes |
|---------|---------|-------|
| **Compaction** | ✅ | Claude ACP supports `/compact` |
| **Hooks** | ⏳ | Agent hook system supported but not implemeneted |
| **Context Usage** | ✅ | Percentage reported via extension events |
| **Quota Info** | ⏳ | Requires SDK header patching (Part 2) |

## Known Limitations

1. **No Real-Time Quota Headers** — Currently requires polling the OAuth API
2. **Atomic Tool Updates (Buffering)** — Claude's ACP daemon buffers `tool_call_update` messages during long-running operations (like large file writes). 
   - **Behavior**: You will not receive character-by-character updates while a tool is executing. Instead, all updates (including the file path and generated code) arrive in a single "burst" only after the tool has completed.
   - **Impact**: The UI will show "Writing..." or "Reading..." without a filename for the duration of the tool's execution.
   - **Mitigation**: AcpUI includes "Sticky Metadata" logic in the backend and "Priority Event Flushing" in the frontend to ensure that once the burst arrives, the UI instantly snaps to the correct filename and preserves the generated code, preventing it from being overwritten by final "Success" status messages.

## Implementation Notes

## Testing the Provider

### Check daemon availability:
```bash
which claude-agent-acp
claude-agent-acp --version
```

### Start with verbose logging:
```bash
# In .env
DEBUG=*

.\scripts\run.ps1
```

### Logs to watch for:
```
[PROVIDER] Loaded "Claude" from ./providers/claude
[ACP] Daemon ready (Claude)
[ACP] New session {sessionId}
```

### Test a conversation:
1. Open http://localhost:5173
2. Type a message
3. Verify Claude responds
4. Check session file was created: `ls ~/.claude/projects/`

## Troubleshooting

### "claude-agent-acp not found"

Ensure it's installed globally:
```bash
npm install -g @agentclientprotocol/claude-agent-acp
where.exe claude-agent-acp  # Windows
which claude-agent-acp      # Unix
```

Or use local path in `provider.json`:
```json
{
  "command": "node",
  "args": ["./node_modules/.bin/claude-agent-acp"]
}
```

### Daemon crashes on startup

Check authentication:
```bash
claude auth login --console
```

Verify `ANTHROPIC_API_KEY` is set (should be via OAuth).

### Sessions not persisting

Verify `~/.claude/projects` exists:
```bash
mkdir -p ~/.claude/projects
ls -la ~/.claude/projects
```