# Claude ACP Protocol Reference

Real protocol samples captured from `@agentclientprotocol/claude-agent-acp` v0.30.0 on 2026-04-18.
The capture used the Sonnet model ID `default`, because this model advertises the full mode/model/effort option set.

All local paths, usernames, and session IDs are sanitized.

---

## Table of Contents

1. [initialize](#1-initialize)
2. [session/new](#2-sessionnew)
3. [available_commands_update](#3-available_commands_update)
4. [session/set_model](#4-sessionset_model)
5. [session/set_config_option](#5-sessionset_config_option)
6. [session/set_mode](#6-sessionset_mode)
7. [session/prompt - Simple Text](#7-sessionprompt---simple-text)
8. [session/prompt - Tool Calls](#8-sessionprompt---tool-calls)
9. [session/load](#9-sessionload)
10. [Provider Normalization Notes](#10-provider-normalization-notes)
11. [Unsupported or Plan-Limited Methods](#11-unsupported-or-plan-limited-methods)

---

## 1. initialize

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
    "clientInfo": { "name": "claude-code", "version": "2.1.114" }
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "_meta": {
        "claudeCode": {
          "promptQueueing": true
        }
      },
      "promptCapabilities": {
        "image": true,
        "embeddedContext": true
      },
      "mcpCapabilities": {
        "http": true,
        "sse": true
      },
      "loadSession": true,
      "sessionCapabilities": {
        "fork": {},
        "list": {},
        "resume": {},
        "close": {}
      }
    },
    "agentInfo": {
      "name": "@agentclientprotocol/claude-agent-acp",
      "title": "Claude Agent",
      "version": "0.30.0"
    },
    "authMethods": []
  }
}
```

---

## 2. session/new

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
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
  "id": 2,
  "result": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "models": {
      "currentModelId": "default",
      "availableModels": [
        {
          "modelId": "default",
          "name": "Default (recommended)",
          "description": "Sonnet 4.6 - Best for everyday tasks"
        },
        {
          "modelId": "sonnet[1m]",
          "name": "Sonnet (1M context)",
          "description": "Sonnet 4.6 with 1M context - Billed as extra usage - $3/$15 per Mtok"
        },
        {
          "modelId": "opus",
          "name": "Opus",
          "description": "Opus 4.7 - Most capable for complex work - ~2x usage vs Sonnet"
        },
        {
          "modelId": "opus[1m]",
          "name": "Opus (1M context)",
          "description": "Opus 4.7 with 1M context - ~2x usage vs Sonnet - Billed as extra usage - $5/$25 per Mtok"
        },
        {
          "modelId": "haiku",
          "name": "Haiku",
          "description": "Haiku 4.5 - Fastest for quick answers"
        }
      ]
    },
    "modes": {
      "currentModeId": "acceptEdits",
      "availableModes": [
        {
          "id": "auto",
          "name": "Auto",
          "description": "Use a model classifier to approve/deny permission prompts"
        },
        {
          "id": "default",
          "name": "Default",
          "description": "Standard behavior, prompts for dangerous operations"
        },
        {
          "id": "acceptEdits",
          "name": "Accept Edits",
          "description": "Auto-accept file edit operations"
        },
        {
          "id": "plan",
          "name": "Plan Mode",
          "description": "Planning mode, no actual tool execution"
        },
        {
          "id": "dontAsk",
          "name": "Don't Ask",
          "description": "Don't prompt for permissions, deny if not pre-approved"
        },
        {
          "id": "bypassPermissions",
          "name": "Bypass Permissions",
          "description": "Bypass all permission checks"
        }
      ]
    },
    "configOptions": [
      {
        "id": "mode",
        "name": "Mode",
        "description": "Session permission mode",
        "category": "mode",
        "type": "select",
        "currentValue": "acceptEdits",
        "options": [
          { "value": "auto", "name": "Auto" },
          { "value": "default", "name": "Default" },
          { "value": "acceptEdits", "name": "Accept Edits" },
          { "value": "plan", "name": "Plan Mode" },
          { "value": "dontAsk", "name": "Don't Ask" },
          { "value": "bypassPermissions", "name": "Bypass Permissions" }
        ]
      },
      {
        "id": "model",
        "name": "Model",
        "description": "AI model to use",
        "category": "model",
        "type": "select",
        "currentValue": "default",
        "options": [
          { "value": "default", "name": "Default (recommended)" },
          { "value": "sonnet[1m]", "name": "Sonnet (1M context)" },
          { "value": "opus", "name": "Opus" },
          { "value": "opus[1m]", "name": "Opus (1M context)" },
          { "value": "haiku", "name": "Haiku" }
        ]
      },
      {
        "id": "effort",
        "name": "Effort",
        "description": "Available effort levels for this model",
        "category": "effort",
        "type": "select",
        "currentValue": "high",
        "options": [
          { "value": "low", "name": "Low" },
          { "value": "medium", "name": "Medium" },
          { "value": "high", "name": "High" },
          { "value": "max", "name": "Max" }
        ]
      }
    ]
  }
}
```

Key findings:

- Claude's Sonnet model ID is `default`.
- The same model catalog is present in both `models.availableModels[]` and the `model` config option.
- The backend should treat `models.currentModelId` as the selected model source of truth and should not render the `model` config option as a generic setting.
- Sonnet exposes the `effort` option with `low`, `medium`, `high`, and `max`.

---

## 3. available_commands_update

Claude emits commands as a standard `session/update`, not as a provider-prefixed extension notification.

**Received after `session/new`:**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        {
          "name": "debug",
          "description": "Enable debug logging for this session and help diagnose issues",
          "input": { "hint": "[issue description]" }
        },
        {
          "name": "compact",
          "description": "Free up context by summarizing the conversation so far",
          "input": { "hint": "<optional custom summarization instructions>" }
        },
        {
          "name": "context",
          "description": "Show current context usage",
          "input": null
        }
      ]
    }
  }
}
```

Observed command names in this capture:

| Command | Input hint |
|---------|------------|
| `update-config` | none |
| `debug` | `[issue description]` |
| `simplify` | none |
| `batch` | `<instruction>` |
| `fewer-permission-prompts` | none |
| `loop` | `[interval] <prompt>` |
| `schedule` | none |
| `claude-api` | none |
| `compact` | `<optional custom summarization instructions>` |
| `context` | none |
| `heapdump` | none |
| `init` | none |
| `review` | none |
| `security-review` | none |
| `extra-usage` | none |
| `insights` | none |
| `team-onboarding` | none |

AcpUI provider behavior:

- `providers/claude/index.js` normalizes these to `_anthropic/commands/available`.
- Command names are prefixed with `/` for the frontend slash menu.
- `input.hint` is mapped to `meta.hint`.

---

## 4. session/set_model

Use the real model ID from `models.availableModels[].modelId`.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/set_model",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modelId": "default"
  }
}
```

**Received before the response:**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "config_option_update",
      "configOptions": [
        {
          "id": "mode",
          "currentValue": "acceptEdits",
          "options": [
            { "value": "auto" },
            { "value": "default" },
            { "value": "acceptEdits" },
            { "value": "plan" },
            { "value": "dontAsk" },
            { "value": "bypassPermissions" }
          ]
        },
        {
          "id": "model",
          "currentValue": "default",
          "options": [
            { "value": "default" },
            { "value": "sonnet[1m]" },
            { "value": "opus" },
            { "value": "opus[1m]" },
            { "value": "haiku" }
          ]
        },
        {
          "id": "effort",
          "currentValue": "high",
          "options": [
            { "value": "low" },
            { "value": "medium" },
            { "value": "high" },
            { "value": "max" }
          ]
        }
      ]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {}
}
```

Key findings:

- `session/set_model` is the supported model switching method.
- Setting the model re-emits the dynamic config option set.
- The model option is still emitted as a config option, but AcpUI captures it as model state before filtering it out of generic config rendering.

---

## 5. session/set_config_option

Use this for dynamic options such as `effort`.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/set_config_option",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "configId": "effort",
    "value": "max"
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "configOptions": [
      { "id": "mode", "currentValue": "acceptEdits" },
      { "id": "model", "currentValue": "default" },
      {
        "id": "effort",
        "name": "Effort",
        "category": "effort",
        "type": "select",
        "currentValue": "max",
        "options": [
          { "value": "low", "name": "Low" },
          { "value": "medium", "name": "Medium" },
          { "value": "high", "name": "High" },
          { "value": "max", "name": "Max" }
        ]
      }
    ]
  }
}
```

Setting `effort` back to `low` returns the same shape with `currentValue: "low"`.

Key findings:

- `session/set_config_option` returns the updated config option list in the response.
- In the observed capture, setting `effort` did not emit a separate `config_option_update`; the updated options were returned in the request result.
- The Claude provider should tag `effort` as `kind: "reasoning_effort"` when forwarding to AcpUI.

---

## 6. session/set_mode

Use this for the `mode` config option.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/set_mode",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modeId": "plan"
  }
}
```

**Received before the response:**
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "config_option_update",
      "configOptions": [
        { "id": "mode", "currentValue": "plan" },
        { "id": "model", "currentValue": "default" },
        { "id": "effort", "currentValue": "low" }
      ]
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {}
}
```

Returning to `acceptEdits` uses the same method:

```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "session/set_mode",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modeId": "acceptEdits"
  }
}
```

Key findings:

- `session/set_mode` is supported by Claude.
- Successful mode changes emit a `config_option_update` before the response.
- Some modes are advertised but can still fail depending on account/plan state. See `auto` in [Unsupported or Plan-Limited Methods](#11-unsupported-or-plan-limited-methods).

---

## 7. session/prompt - Simple Text

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "method": "session/prompt",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "prompt": [
      { "type": "text", "text": "Reply with exactly: Hello World" }
    ]
  }
}
```

**Received in order:**

### 7a. Usage update
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "usage_update",
      "used": 20198,
      "size": 200000
    }
  }
}
```

### 7b. Agent message chunks
Claude may emit an empty first chunk.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "" }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Hello World" }
    }
  }
}
```

### 7c. Final usage update with cost
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "usage_update",
      "used": 20200,
      "size": 200000,
      "cost": {
        "amount": 0.07619800000000002,
        "currency": "USD"
      }
    }
  }
}
```

### 7d. Response
```json
{
  "jsonrpc": "2.0",
  "id": 8,
  "result": {
    "stopReason": "end_turn",
    "usage": {
      "inputTokens": 3,
      "outputTokens": 5,
      "cachedReadTokens": 0,
      "cachedWriteTokens": 20192,
      "totalTokens": 20200
    }
  }
}
```

---

## 8. session/prompt - Tool Calls

Prompt used:

```json
{
  "type": "text",
  "text": "Use the Read tool to read package.json, then reply with exactly the top-level name value."
}
```

Claude tool events are incremental. The first `tool_call` often has an empty `rawInput`, then a later `tool_call_update` supplies arguments, title, and locations.

### 8a. Tool start
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "_meta": {
        "claudeCode": {
          "toolName": "Read"
        }
      },
      "toolCallId": "toolu_000000000000000000000000",
      "sessionUpdate": "tool_call",
      "rawInput": {},
      "status": "pending",
      "title": "Read File",
      "kind": "read",
      "locations": [],
      "content": []
    }
  }
}
```

### 8b. Tool arguments and sticky metadata
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "_meta": {
        "claudeCode": {
          "toolName": "Read"
        }
      },
      "toolCallId": "toolu_000000000000000000000000",
      "sessionUpdate": "tool_call_update",
      "rawInput": {
        "file_path": "C:\\Users\\user\\project\\backend\\package.json"
      },
      "title": "Read backend\\package.json",
      "kind": "read",
      "locations": [
        {
          "path": "C:\\Users\\user\\project\\backend\\package.json",
          "line": 1
        }
      ],
      "content": []
    }
  }
}
```

### 8c. Tool response payload
Claude can send tool output in `_meta.claudeCode.toolResponse` before the final `completed` update.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "_meta": {
        "claudeCode": {
          "toolResponse": {
            "type": "text",
            "file": {
              "filePath": "C:\\Users\\user\\project\\backend\\package.json",
              "content": "{ \"name\": \"backend\", ... }",
              "numLines": 40,
              "startLine": 1,
              "totalLines": 40
            }
          },
          "toolName": "Read"
        }
      },
      "toolCallId": "toolu_000000000000000000000000",
      "sessionUpdate": "tool_call_update"
    }
  }
}
```

### 8d. Tool complete
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "_meta": {
        "claudeCode": {
          "toolName": "Read"
        }
      },
      "toolCallId": "toolu_000000000000000000000000",
      "sessionUpdate": "tool_call_update",
      "status": "completed",
      "rawOutput": "1\\t{\\n2\\t  \"name\": \"backend\",\\n...\\n40\\t",
      "content": [
        {
          "type": "content",
          "content": {
            "type": "text",
            "text": "```\\n1\\t{\\n2\\t  \"name\": \"backend\",\\n...\\n```"
          }
        }
      ]
    }
  }
}
```

Key findings:

- `extractFilePath` should inspect `locations[]`, `content[]`, and `rawInput.file_path`.
- `extractToolOutput` should inspect `rawOutput`, `content[]`, and `_meta.claudeCode.toolResponse`.
- Tool metadata can arrive before final output, so AcpUI's sticky metadata is required for stable file titles.
- Read/search tools may emit failed updates and then recover with other tools if the initial path is wrong.

---

## 9. session/load

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "method": "session/load",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "cwd": "C:\\Users\\user\\project",
    "mcpServers": []
  }
}
```

**Received before the response:**

`session/load` replays conversation history as live `session/update` chunks. AcpUI must drain these updates so old messages do not render again.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": {
        "type": "text",
        "text": "<command-name>/model</command-name>\\n<command-message>model</command-message>\\n<command-args>default</command-args>"
      }
    }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": {
        "type": "text",
        "text": "<local-command-stdout>Set model to claude-sonnet-4-6</local-command-stdout>"
      }
    }
  }
}
```

The replay also includes real user and assistant chunks:

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": {
        "type": "text",
        "text": "Reply with exactly: Hello World"
      }
    }
  }
}
```

**Response:**
```json
{
  "jsonrpc": "2.0",
  "id": 10,
  "result": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modes": {
      "currentModeId": "acceptEdits",
      "availableModes": [
        { "id": "auto", "name": "Auto" },
        { "id": "default", "name": "Default" },
        { "id": "acceptEdits", "name": "Accept Edits" },
        { "id": "plan", "name": "Plan Mode" },
        { "id": "dontAsk", "name": "Don't Ask" },
        { "id": "bypassPermissions", "name": "Bypass Permissions" }
      ]
    },
    "models": {
      "currentModelId": "default",
      "availableModels": [
        { "modelId": "default", "name": "Default (recommended)" },
        { "modelId": "sonnet[1m]", "name": "Sonnet (1M context)" },
        { "modelId": "opus", "name": "Opus" },
        { "modelId": "opus[1m]", "name": "Opus (1M context)" },
        { "modelId": "haiku", "name": "Haiku" }
      ]
    },
    "configOptions": [
      { "id": "mode", "currentValue": "acceptEdits" },
      { "id": "model", "currentValue": "default" },
      { "id": "effort", "currentValue": "low" }
    ]
  }
}
```

Key findings:

- `session/load` returns fresh `models` and `configOptions`.
- It also replays hidden local command messages for model changes.
- The internal stdout says `claude-sonnet-4-6`, but ACP model switching still uses `modelId: "default"`.

---

## 10. Provider Normalization Notes

Claude's daemon mostly uses standard ACP `session/update` notifications. The AcpUI Claude provider adds these provider-specific normalizations:

| Raw Claude event | AcpUI provider behavior |
|------------------|-------------------------|
| `available_commands_update` | Emits `_anthropic/commands/available`, prefixes command names with `/`, maps `input.hint` to `meta.hint` |
| `config_option_update` | Emits `_anthropic/config_options` for generic config rendering |
| `config_option_update` option `id: "model"` | Backend captures as model state before provider filtering; provider removes it from generic config UI |
| `config_option_update` option `id: "effort"` | Provider adds `kind: "reasoning_effort"` so the UI can render the reasoning footer |
| Tool output in `_meta.claudeCode.toolResponse` | Provider extracts it for timeline tool output |

The dynamic model contract should be populated from:

```json
{
  "currentModelId": "default",
  "modelOptions": [
    { "id": "default", "name": "Default (recommended)" },
    { "id": "sonnet[1m]", "name": "Sonnet (1M context)" },
    { "id": "opus", "name": "Opus" },
    { "id": "opus[1m]", "name": "Opus (1M context)" },
    { "id": "haiku", "name": "Haiku" }
  ]
}
```

---

## 11. Unsupported or Plan-Limited Methods

These were tested against the same daemon capture.

| Method | Result | Notes |
|--------|--------|-------|
| `session/configure` | `-32601 Method not found` | Do not use the generic fallback for Claude config options |
| `unstable_session/set_model` | `-32601 Method not found` | Use `session/set_model` |
| `session/set_mode` with `modeId: "auto"` | `-32603 Internal error` | Advertised by the daemon, but can fail with `auto mode is unavailable for your plan` |
| `session/set_config_option` with `configId: "effort"` | Works | Returns updated `configOptions` in the result |
| `session/set_config_option` with `configId: "model"` | Works in this capture | Still prefer `session/set_model` for AcpUI's first-class model contract |

Example unsupported response:

```json
{
  "jsonrpc": "2.0",
  "id": 11,
  "error": {
    "code": -32601,
    "message": "\"Method not found\": session/configure",
    "data": {
      "method": "session/configure"
    }
  }
}
```

Example plan-limited response:

```json
{
  "jsonrpc": "2.0",
  "id": 12,
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": {
      "details": "Cannot set permission mode to auto: auto mode is unavailable for your plan"
    }
  }
}
```
