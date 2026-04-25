# Gemini CLI ACP Protocol Reference

Real protocol samples captured from `gemini-cli` v0.39.1 on 2026-04-24.
All session IDs and local paths are sanitized.

**Key capture finding:** The Gemini daemon does not respond to `initialize` until after `authenticate` is sent. Both must be sent before either response arrives.

---

## Table of Contents

1. [initialize](#1-initialize)
2. [authenticate](#2-authenticate)
3. [session/new](#3-sessionnew)
4. [available_commands_update](#4-available_commands_update)
5. [session/set_model](#5-sessionset_model)
6. [session/prompt — Simple Text](#6-sessionprompt--simple-text)
7. [session/prompt — Tool Calls](#7-sessionprompt--tool-calls)
8. [session/set_mode](#8-sessionset_mode)
9. [session/load](#9-sessionload)
10. [Provider Normalization Notes](#10-provider-normalization-notes)
11. [Unsupported Methods](#11-unsupported-methods)

---

## 1. initialize

**Critical:** Send this immediately followed by `authenticate` without waiting for a response. The daemon holds the `initialize` result until after authentication completes.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "fs": { "readTextFile": true, "writeTextFile": true },
      "terminal": true
    },
    "clientInfo": { "name": "AcpUI", "version": "1.0.0" }
  }
}
```

**Received (arrives after `authenticate` response):**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "authMethods": [
      {
        "id": "oauth-personal",
        "name": "Log in with Google",
        "description": "Log in with your Google account"
      },
      {
        "id": "gemini-api-key",
        "name": "Gemini API key",
        "description": "Use an API key with Gemini Developer API",
        "_meta": { "api-key": { "provider": "google" } }
      },
      {
        "id": "vertex-ai",
        "name": "Vertex AI",
        "description": "Use an API key with Vertex AI GenAI API"
      },
      {
        "id": "gateway",
        "name": "AI API Gateway",
        "description": "Use a custom AI API Gateway",
        "_meta": { "gateway": { "protocol": "google", "restartRequired": "false" } }
      }
    ],
    "agentInfo": {
      "name": "gemini-cli",
      "title": "Gemini CLI",
      "version": "0.39.1"
    },
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {
        "image": true,
        "audio": true,
        "embeddedContext": true
      },
      "mcpCapabilities": {
        "http": true,
        "sse": true
      }
    }
  }
}
```

Key findings:

- Four auth methods are advertised: `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`.
- The `initialize` response arrives **after** the `authenticate` response — both must be sent before waiting.

---

## 2. authenticate

Must be sent immediately after `initialize`, without waiting for the `initialize` response.

**Sent (OAuth path — default when no API key env var is set):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {
    "methodId": "oauth-personal"
  }
}
```

**Sent (API key path — when `GEMINI_CLI_SERVICES_API_KEY` is set):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {
    "methodId": "gemini-api-key",
    "_meta": { "api-key": "AIza..." }
  }
}
```

**Received (arrives first, before the `initialize` response):**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

Key findings:

- `authenticate` responds before `initialize`. The AcpUI handshake must use `Promise.all([initPromise, authPromise])` rather than sequential awaits.
- A cached OAuth token is used automatically — no browser flow for returning users.

---

## 3. session/new

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/new",
  "params": {
    "cwd": "C:\\Users\\user\\project",
    "mcpServers": []
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "modes": {
      "availableModes": [
        { "id": "default",  "name": "Default",   "description": "Prompts for approval" },
        { "id": "autoEdit", "name": "Auto Edit",  "description": "Auto-approves edit tools" },
        { "id": "yolo",     "name": "YOLO",       "description": "Auto-approves all tools" },
        { "id": "plan",     "name": "Plan",       "description": "Read-only mode" }
      ],
      "currentModeId": "autoEdit"
    },
    "models": {
      "availableModels": [
        { "modelId": "auto-gemini-3",            "name": "Auto (Gemini 3)",   "description": "Let Gemini CLI decide the best model for the task: gemini-3.1-pro, gemini-3-flash" },
        { "modelId": "auto-gemini-2.5",          "name": "Auto (Gemini 2.5)", "description": "Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash" },
        { "modelId": "gemini-3.1-pro-preview",   "name": "gemini-3.1-pro-preview" },
        { "modelId": "gemini-3-flash-preview",   "name": "gemini-3-flash-preview" },
        { "modelId": "gemini-3.1-flash-lite-preview", "name": "gemini-3.1-flash-lite-preview" },
        { "modelId": "gemini-2.5-pro",           "name": "gemini-2.5-pro" },
        { "modelId": "gemini-2.5-flash",         "name": "gemini-2.5-flash" },
        { "modelId": "gemini-2.5-flash-lite",    "name": "gemini-2.5-flash-lite" }
      ],
      "currentModelId": "gemini-3.1-pro-preview"
    }
  }
}
```

Key findings:

- Both `modes` and `models` are returned in `session/new`.
- `modes` are Gemini's permission modes — `default`, `autoEdit`, `yolo`, `plan`.
- The session `sessionId` is a full UUID.
- `currentModelId` reflects the model the daemon was started with (or its default). The `--model` CLI flag sets this.

---

## 4. available_commands_update

Emitted as a `session/update` notification immediately after `session/new` completes.

**Received:**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "memory",           "description": "Manage memory." },
        { "name": "memory show",      "description": "Shows the current memory contents." },
        { "name": "memory refresh",   "description": "Refreshes the memory from the source." },
        { "name": "memory list",      "description": "Lists the paths of the GEMINI.md files in use." },
        { "name": "memory add",       "description": "Add content to the memory." },
        { "name": "memory inbox",     "description": "Lists skills extracted from past sessions that are pending review." },
        { "name": "extensions",       "description": "Manage extensions." },
        { "name": "extensions list",  "description": "Lists all installed extensions." },
        { "name": "extensions explore",  "description": "Explore available extensions." },
        { "name": "extensions enable",   "description": "Enable an extension." },
        { "name": "extensions disable",  "description": "Disable an extension." },
        { "name": "extensions install",  "description": "Install an extension from a git repo or local path." },
        { "name": "extensions link",     "description": "Link an extension from a local path." },
        { "name": "extensions uninstall","description": "Uninstall an extension." },
        { "name": "extensions restart",  "description": "Restart an extension." },
        { "name": "extensions update",   "description": "Update an extension." },
        { "name": "init",     "description": "Analyzes the project and creates a tailored GEMINI.md file" },
        { "name": "restore",  "description": "Restore to a previous checkpoint, or list available checkpoints to restore." },
        { "name": "restore list", "description": "Lists all available checkpoints." },
        { "name": "about",    "description": "Show version and environment info" },
        { "name": "help",     "description": "Show available commands" }
      ]
    }
  }
}
```

Key findings:

- Commands have only `name` and `description` fields — no `input` hint.
- This notification is also re-emitted after `session/load`.

---

## 5. session/set_model

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/set_model",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "modelId": "auto-gemini-3"
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {}
}
```

Key findings:

- Returns an empty result — no updated model catalog or config options in the response.
- No `session/update` notification is emitted before or after.
- Use real `modelId` values from `session/new` result — not display names.

---

## 6. session/prompt — Simple Text

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/prompt",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "prompt": [{ "type": "text", "text": "Reply with exactly the words: Hello World" }]
  }
}
```

**Received in order:**

### 6a. Thought chunks (streamed)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "**Analyzing User Request Details**\n\nI'm currently focused on the prompt..." }
    }
  }
}
```

Multiple `agent_thought_chunk` updates arrive before the message.

### 6b. Agent message chunk
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Hello World" }
    }
  }
}
```

### 6c. Response
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "stopReason": "end_turn",
    "_meta": {
      "quota": {
        "token_count": {
          "input_tokens": 21414,
          "output_tokens": 2
        },
        "model_usage": [
          {
            "model": "gemini-3-flash-preview",
            "token_count": { "input_tokens": 21414, "output_tokens": 2 }
          }
        ]
      }
    }
  }
}
```

Key findings:

- Gemini emits `agent_thought_chunk` (thinking/reasoning) updates before `agent_message_chunk`.
- Token counts are in `result._meta.quota`, not in a separate `usage_update` notification.
- `model_usage[].model` shows the actual model used (may differ from `currentModelId` when using `auto-*` model IDs).
- No `usage_update` notifications — token data only arrives in the final response.

---

## 7. session/prompt — Tool Calls

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/prompt",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "prompt": [{ "type": "text", "text": "Use your file reading tool to read package.json in the current directory and tell me the \"name\" field value." }]
  }
}
```

**Received in order:**

### 7a. Thought chunks (multiple, before any tool use)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": { "type": "text", "text": "**Examining Package.json**\n\nI've successfully identified the target..." }
    }
  }
}
```

### 7b. Agent narration chunk (before tool call)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "I will check the current directory to see if there is a `package.json` file." }
    }
  }
}
```

### 7c. Tool start (`tool_call`)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "list_directory-1777080205816-1",
      "status": "in_progress",
      "title": ".",
      "content": [],
      "locations": [],
      "kind": "search"
    }
  }
}
```

### 7d. Tool complete (`tool_call_update`)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "list_directory-1777080205816-1",
      "status": "completed",
      "title": ".",
      "content": [],
      "locations": [],
      "kind": "search"
    }
  }
}
```

### 7e. Tool with output in `content[]` (glob result)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "glob-1777080210275-2",
      "status": "completed",
      "title": "'**/package.json'",
      "content": [
        {
          "type": "content",
          "content": { "type": "text", "text": "Found 47 matching file(s)" }
        }
      ],
      "locations": [],
      "kind": "search"
    }
  }
}
```

### 7f. Read file — tool start with `locations[]`
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "read_file-1777080215898-3",
      "status": "in_progress",
      "title": "backend\\package.json",
      "content": [],
      "locations": [{ "path": "D:\\Git\\AcpUI\\backend\\package.json" }],
      "kind": "read"
    }
  }
}
```

### 7g. Read file — complete (no content in update)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "read_file-1777080215898-3",
      "status": "completed",
      "title": "backend\\package.json",
      "content": [],
      "locations": [{ "path": "D:\\Git\\AcpUI\\backend\\package.json" }],
      "kind": "read"
    }
  }
}
```

### 7h. Response
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "stopReason": "end_turn",
    "_meta": {
      "quota": {
        "token_count": { "input_tokens": 88742, "output_tokens": 133 },
        "model_usage": [
          { "model": "gemini-3-flash-preview", "token_count": { "input_tokens": 88742, "output_tokens": 133 } }
        ]
      }
    }
  }
}
```

Key findings:

- `toolCallId` format is `{toolName}-{timestamp}-{index}` (e.g. `read_file-1777080215898-3`), not a UUID.
- Tool output is in `content[].content.text` when present. For read operations, `content[]` is empty — tool output is not surfaced over ACP.
- `locations[]` carries the file path on both `tool_call` and `tool_call_update`.
- `kind` values observed: `"search"`, `"read"`.
- Gemini emits `agent_message_chunk` narration **between** tool calls (not only at the end).
- `agent_thought_chunk` appears before tool calls and between them.

---

## 8. session/set_mode

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "session/set_mode",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "modeId": "default"
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {}
}
```

Key findings:

- Returns empty result — no notification emitted.
- Valid `modeId` values from `session/new`: `default`, `autoEdit`, `yolo`, `plan`.

---

## 9. session/load

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "method": "session/load",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "cwd": "C:\\Users\\user\\project",
    "mcpServers": []
  }
}
```

**Received in order:**

### 9a. History replay — `user_message_chunk`
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-9156-4357-a73b-a305de01eacc",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": { "type": "text", "text": "Reply with exactly the words: Hello World" }
    }
  }
}
```

History replay includes all prior turns: `user_message_chunk`, `agent_thought_chunk`, `agent_message_chunk`, and tool call updates (with updated titles — see normalization notes).

### 9b. Response (arrives before replay finishes)
```json
{
  "jsonrpc": "2.0",
  "id": 9,
  "result": {
    "modes": {
      "availableModes": [
        { "id": "default",  "name": "Default",  "description": "Prompts for approval" },
        { "id": "autoEdit", "name": "Auto Edit", "description": "Auto-approves edit tools" },
        { "id": "yolo",     "name": "YOLO",      "description": "Auto-approves all tools" },
        { "id": "plan",     "name": "Plan",      "description": "Read-only mode" }
      ],
      "currentModeId": "autoEdit"
    },
    "models": {
      "availableModels": [
        { "modelId": "auto-gemini-3",            "name": "Auto (Gemini 3)",   "description": "Let Gemini CLI decide the best model for the task: gemini-3.1-pro, gemini-3-flash" },
        { "modelId": "auto-gemini-2.5",          "name": "Auto (Gemini 2.5)", "description": "Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash" },
        { "modelId": "gemini-3.1-pro-preview",   "name": "gemini-3.1-pro-preview" },
        { "modelId": "gemini-3-flash-preview",   "name": "gemini-3-flash-preview" },
        { "modelId": "gemini-3.1-flash-lite-preview", "name": "gemini-3.1-flash-lite-preview" },
        { "modelId": "gemini-2.5-pro",           "name": "gemini-2.5-pro" },
        { "modelId": "gemini-2.5-flash",         "name": "gemini-2.5-flash" },
        { "modelId": "gemini-2.5-flash-lite",    "name": "gemini-2.5-flash-lite" }
      ],
      "currentModelId": "gemini-3.1-pro-preview"
    }
  }
}
```

### 9c. Replay continues after response, then `available_commands_update`

After the response, replay of tool call updates continues, followed by a final `available_commands_update` notification (same shape as §4).

Key findings:

- `session/load` response arrives **mid-stream**, before the history replay finishes. AcpUI must drain all updates until a sentinel (the response itself arriving) and then continue draining post-response notifications.
- `currentModeId` in the load response reflects the mode at the time of the original session, **not** the mode set during this connection — the `session/set_mode` call earlier was not reflected.
- Tool call titles during replay differ from live: `list_directory` → `"ReadFolder"`, `glob` → `"FindFiles"`, `read_file` → `"ReadFile"`. The provider normalization layer must handle both forms.

---

## 10. Provider Normalization Notes

| Raw Gemini event | AcpUI provider behavior needed |
|------------------|-------------------------------|
| `initialize` + `authenticate` sent together | `performHandshake` must send both in parallel and await both responses |
| `agent_thought_chunk` | Map to `sessionUpdate: "agent_thought_chunk"` — already a standard-looking field; render as thinking block |
| `available_commands_update` on `session/new` and `session/load` | Forward as-is; command `name` values do not have a `/` prefix |
| `result._meta.quota.token_count` | Token counts are in the response `_meta`, not in a `usage_update` notification |
| `result._meta.quota.model_usage[].model` | Actual model used — important when `auto-*` model IDs are selected |
| `tool_call` / `tool_call_update` `locations[].path` | Primary source for `extractFilePath` |
| `tool_call_update` `content[].content.text` | Present for search/glob tools; empty for read tools |
| Tool titles during replay (`ReadFolder`, `FindFiles`, `ReadFile`) | Differ from live titles — `normalizeTool` must handle both |
| `toolCallId` format `{name}-{timestamp}-{index}` | Not a UUID; stable within a session, use as-is |
| `session/set_mode` | Supported — use `session/set_mode` with `modeId` from `modes.availableModes` |

---

## 11. Unsupported Methods

| Method | Result | Notes |
|--------|--------|-------|
| `session/set_config_option` | `-32601 Method not found` | Do not use for Gemini; use `session/set_model` and `session/set_mode` instead |

**Error response shape:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "error": {
    "code": -32601,
    "message": "\"Method not found\": session/set_config_option",
    "data": { "method": "session/set_config_option" }
  }
}
```
