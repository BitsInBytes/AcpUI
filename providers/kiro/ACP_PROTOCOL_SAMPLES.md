# Kiro ACP Protocol Reference

Real protocol samples captured from `kiro-cli acp` v2.1.0 on 2026-04-18.
Use this document to understand the exact JSON shapes Kiro sends/receives without needing a live daemon.

---

## Table of Contents

1. [initialize](#1-initialize)
2. [session/new](#2-sessionnew)
3. [session/prompt — Agent Switch](#3-sessionprompt--agent-switch)
4. [session/set_model](#4-sessionset_model)
5. [session/prompt — Simple Question](#5-sessionprompt--simple-question)
6. [session/load](#6-sessionload)
7. [Extension Notifications](#7-extension-notifications)
8. [Unsupported Methods](#8-unsupported-methods)

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
    "clientInfo": { "name": "AcpUI", "version": "1.0.0" }
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
      "loadSession": true,
      "promptCapabilities": { "image": true, "audio": false, "embeddedContext": false },
      "mcpCapabilities": { "http": true, "sse": false },
      "sessionCapabilities": {}
    },
    "authMethods": [],
    "agentInfo": {
      "name": "Kiro CLI Agent",
      "title": "Kiro CLI Agent",
      "version": "2.1.0"
    }
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

**Received (in order):**

### 2a. Extension: `_kiro.dev/metadata`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/metadata",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "contextUsagePercentage": 0.3465999960899353
  }
}
```

### 2b. Extension: `_kiro.dev/subagent/list_update`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/subagent/list_update",
  "params": {
    "subagents": [],
    "pendingStages": []
  }
}
```

### 2c. Response (id: 2)
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modes": {
      "currentModeId": "kiro_default",
      "availableModes": [
        {
          "id": "custom-agent",
          "name": "custom-agent",
          "description": "A custom development agent with context, skills and MCP tools."
        },
        {
          "id": "kiro_default",
          "name": "kiro_default",
          "description": "The default agent for Kiro CLI"
        },
        {
          "id": "kiro_planner",
          "name": "kiro_planner",
          "description": "Specialized planning agent that helps break down ideas into implementation plans",
          "_meta": {
            "welcomeMessage": "Transform any idea into fully working code. What do you want to build today?"
          }
        },
        {
          "id": "kiro_guide",
          "name": "kiro_guide",
          "description": "Guide agent that answers questions about Kiro CLI features using documentation",
          "_meta": {
            "welcomeMessage": "Welcome to Kiro CLI Guide!..."
          }
        }
      ]
    },
    "models": {
      "currentModelId": "claude-opus-4.6",
      "availableModels": [
        { "modelId": "auto", "name": "auto", "description": "Models chosen by task for optimal usage and consistent quality" },
        { "modelId": "claude-opus-4.6", "name": "claude-opus-4.6", "description": "The Claude Opus 4.6 model" },
        { "modelId": "claude-sonnet-4.6", "name": "claude-sonnet-4.6", "description": "The latest Claude Sonnet model with 1M context window" },
        { "modelId": "claude-opus-4.5", "name": "claude-opus-4.5", "description": "The Claude Opus 4.5 model" },
        { "modelId": "claude-sonnet-4.5", "name": "claude-sonnet-4.5", "description": "The Claude Sonnet 4.5 model" },
        { "modelId": "claude-sonnet-4", "name": "claude-sonnet-4", "description": "Hybrid reasoning and coding for regular use" },
        { "modelId": "claude-haiku-4.5", "name": "claude-haiku-4.5", "description": "The latest Claude Haiku model" },
        { "modelId": "deepseek-3.2", "name": "deepseek-3.2", "description": "Experimental preview of DeepSeek V3.2" },
        { "modelId": "minimax-m2.5", "name": "minimax-m2.5", "description": "The MiniMax M2.5 model" },
        { "modelId": "minimax-m2.1", "name": "minimax-m2.1", "description": "Experimental preview of MiniMax M2.1" },
        { "modelId": "glm-5", "name": "glm-5", "description": "The GLM-5 model" },
        { "modelId": "qwen3-coder-next", "name": "qwen3-coder-next", "description": "Experimental preview of Qwen3 Coder Next" }
      ]
    }
  }
}
```

### 2d. Extension: `_kiro.dev/commands/available`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/commands/available",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "commands": [
      {
        "name": "/agent",
        "description": "Select or list available agents",
        "meta": {
          "optionsMethod": "_kiro.dev/commands/agent/options",
          "inputType": "selection",
          "hint": "",
          "subcommands": ["create", "edit", "swap"],
          "subcommandHints": { "create": "<name>", "edit": "[name]", "swap": "<name>" }
        }
      },
      {
        "name": "/chat",
        "description": "Load a previous session or start a new one",
        "meta": {
          "inputType": "selection",
          "local": true,
          "hint": "save <path>, load <path>, new [prompt]",
          "subcommands": ["save", "load", "new"],
          "subcommandHints": { "save": "[--force] <path>", "load": "<path>", "new": "[prompt]" }
        }
      },
      { "name": "/clear", "description": "Clear conversation history" },
      {
        "name": "/code",
        "description": "Code intelligence workspace management",
        "meta": { "inputType": "panel", "subcommands": ["status", "init", "logs", "overview", "summary"] }
      },
      { "name": "/compact", "description": "Compact conversation history" },
      {
        "name": "/context",
        "description": "Manage context files or show token usage",
        "meta": {
          "inputType": "panel",
          "hint": "add <path>, remove <path>, clear",
          "subcommands": ["show", "add", "remove", "clear"],
          "subcommandHints": { "add": "[--force] <path>...", "remove": "<path>..." }
        }
      },
      {
        "name": "/feedback",
        "description": "Submit feedback, request features, or report issues",
        "meta": { "inputType": "selection", "searchable": false, "hint": "" }
      },
      { "name": "/guide", "description": "Get help with Kiro CLI features from the guide agent" },
      { "name": "/help", "description": "Show available commands", "meta": { "inputType": "panel" } },
      { "name": "/hooks", "description": "View configured hooks", "meta": { "inputType": "panel" } },
      {
        "name": "/knowledge",
        "description": "Manage knowledge base",
        "meta": {
          "inputType": "panel",
          "subcommands": ["show", "add", "remove", "update", "clear", "cancel"],
          "subcommandHints": { "add": "<name> <path>", "remove": "<name|path>", "update": "<path>" }
        }
      },
      {
        "name": "/mcp",
        "description": "Show configured MCP servers",
        "meta": {
          "inputType": "panel",
          "subcommands": ["list", "add", "remove"],
          "subcommandHints": { "add": "<server-name>", "remove": "<server-name>" }
        }
      },
      {
        "name": "/model",
        "description": "Select or list available models",
        "meta": { "optionsMethod": "_kiro.dev/commands/model/options", "inputType": "selection", "hint": "" }
      },
      { "name": "/paste", "description": "Paste image from clipboard" },
      { "name": "/plan", "description": "Switch to Plan agent for breaking down ideas into implementation plans" },
      {
        "name": "/prompts",
        "description": "Select or list available prompts",
        "meta": { "optionsMethod": "_kiro.dev/commands/prompts/options", "inputType": "selection", "hint": "" }
      },
      { "name": "/quit", "description": "Quit the application", "meta": { "local": true } },
      { "name": "/reply", "description": "Open editor pre-filled with the last assistant message to compose a reply" },
      {
        "name": "/tools",
        "description": "Show available tools",
        "meta": {
          "inputType": "panel",
          "hint": "trust-all, trust <name>, untrust <name>, reset",
          "subcommands": ["trust-all", "trust", "untrust", "reset"],
          "subcommandHints": { "trust": "<name>", "untrust": "<name>" }
        }
      },
      { "name": "/usage", "description": "Show billing and usage information", "meta": { "inputType": "panel" } }
    ],
    "prompts": [],
    "tools": [
      { "name": "code", "description": "Code intelligence with AST parsing...", "source": "built-in" },
      { "name": "glob", "description": "Find files by glob pattern...", "source": "built-in" },
      { "name": "grep", "description": "Fast text pattern search...", "source": "built-in" },
      { "name": "introspect", "description": "Look up Kiro CLI docs...", "source": "built-in" },
      { "name": "knowledge", "description": "Semantic search knowledge base...", "source": "built-in" },
      { "name": "read", "description": "Read files, directories, images...", "source": "built-in" },
      { "name": "shell", "description": "Execute shell commands...", "source": "built-in" },
      { "name": "subagent", "description": "Spawn multi-agent DAG pipelines...", "source": "built-in" },
      { "name": "todo_list", "description": "Task list tracking...", "source": "built-in" },
      { "name": "use_aws", "description": "AWS CLI API calls...", "source": "built-in" },
      { "name": "web_fetch", "description": "Fetch content from URLs...", "source": "built-in" },
      { "name": "web_search", "description": "Web search...", "source": "built-in" },
      { "name": "write", "description": "Create and edit text files...", "source": "built-in" }
    ],
    "mcpServers": []
  }
}
```

> **Note:** After agent switch, `commands/available` is re-emitted with MCP tools included in `tools[]` (e.g. `{ "name": "my_custom_tool", "source": "mcp:MyMcpServer" }`) and `mcpServers` populated (e.g. `[{ "name": "MyMcpServer", "status": "running", "toolCount": 5 }]`).

---

## 3. session/prompt — Agent Switch

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/prompt",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "prompt": [{ "type": "text", "text": "/agent custom-agent" }]
  }
}
```

**Received (in order):**

### 3a. Extension: `_kiro.dev/agent/switched`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/agent/switched",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "agentName": "custom-agent",
    "previousAgentName": "kiro_default",
    "welcomeMessage": null,
    "model": "claude-opus-4.6"
  }
}
```

### 3b. Extension: `_kiro.dev/commands/available`
Re-emitted with MCP tools now included in `tools[]` and `mcpServers` populated.

### 3c. Session update: `agent_message_chunk`
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Agent changed to custom-agent" }
    }
  }
}
```

### 3d. Response (id: 3)
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": { "stopReason": "end_turn" }
}
```

### 3e. Extension: `_kiro.dev/mcp/server_initialized`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/mcp/server_initialized",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "serverName": "MyMcpServer"
  }
}
```

### 3f. Extension: `_kiro.dev/commands/available`
Re-emitted again after MCP server initialization (same shape as 3b).

---

## 4. session/set_model

Kiro expects the real model ID from `models.availableModels[].modelId`. These IDs are versioned with dots (for example, `claude-sonnet-4.6`), not the older hyphen-only aliases.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/set_model",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "modelId": "claude-sonnet-4.6"
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

---

## 5. session/prompt — Simple Question

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/prompt",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "prompt": [{ "type": "text", "text": "Reply with exactly: Hello World" }]
  }
}
```

**Received (in order):**

### 5a. Session update: `agent_message_chunk` (streamed)
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Hello" }
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
      "content": { "type": "text", "text": " World" }
    }
  }
}
```

### 5b. Extension: `_kiro.dev/metadata`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/metadata",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "contextUsagePercentage": 3.7147998809814453,
    "turnDurationMs": 2398
  }
}
```

### 5c. Response (id: 5)
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": { "stopReason": "end_turn" }
}
```

---

## 6. session/load

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/load",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "cwd": "C:\\Users\\user\\project",
    "mcpServers": []
  }
}
```

**Received (in order):**

### 6a. History replay: `user_message_chunk`
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": { "type": "text", "text": "Reply with exactly: Hello World" }
    }
  }
}
```

### 6b. History replay: `agent_message_chunk`
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

### 6c. Extension: `_kiro.dev/mcp/server_initialized`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/mcp/server_initialized",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "serverName": "MyMcpServer"
  }
}
```

### 6d. Extension: `_kiro.dev/commands/available`
Same shape as section 2d, with MCP tools included.

### 6e. Extension: `_kiro.dev/metadata`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/metadata",
  "params": {
    "sessionId": "00000000-0000-0000-0000-000000000001",
    "contextUsagePercentage": 2.5625998973846436
  }
}
```

### 6f. Extension: `_kiro.dev/subagent/list_update`
```json
{
  "jsonrpc": "2.0",
  "method": "_kiro.dev/subagent/list_update",
  "params": {
    "subagents": [],
    "pendingStages": []
  }
}
```

### 6g. Response (id: 6)
**Key finding: `session/load` preserves the agent mode.**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "modes": {
      "currentModeId": "custom-agent",
      "availableModes": [
        { "id": "custom-agent", "name": "custom-agent", "description": "..." },
        { "id": "kiro_default", "name": "kiro_default", "description": "..." },
        { "id": "kiro_planner", "name": "kiro_planner", "description": "...", "_meta": { "welcomeMessage": "..." } },
        { "id": "kiro_guide", "name": "kiro_guide", "description": "...", "_meta": { "welcomeMessage": "..." } }
      ]
    },
    "models": {
      "currentModelId": "claude-sonnet-4.6",
      "availableModels": [
        { "modelId": "auto", "name": "auto", "description": "..." },
        { "modelId": "claude-opus-4.6", "name": "claude-opus-4.6", "description": "..." },
        { "modelId": "claude-sonnet-4.6", "name": "claude-sonnet-4.6", "description": "..." },
        { "modelId": "claude-opus-4.5", "name": "claude-opus-4.5", "description": "..." },
        { "modelId": "claude-sonnet-4.5", "name": "claude-sonnet-4.5", "description": "..." },
        { "modelId": "claude-sonnet-4", "name": "claude-sonnet-4", "description": "..." },
        { "modelId": "claude-haiku-4.5", "name": "claude-haiku-4.5", "description": "..." },
        { "modelId": "deepseek-3.2", "name": "deepseek-3.2", "description": "..." },
        { "modelId": "minimax-m2.5", "name": "minimax-m2.5", "description": "..." },
        { "modelId": "minimax-m2.1", "name": "minimax-m2.1", "description": "..." },
        { "modelId": "glm-5", "name": "glm-5", "description": "..." },
        { "modelId": "qwen3-coder-next", "name": "qwen3-coder-next", "description": "..." }
      ]
    }
  }
}
```

### 6h. Extension: `_kiro.dev/commands/available`
Re-emitted after load (same shape).

---

## 7. Extension Notifications

Summary of all `_kiro.dev/` extension methods observed:

| Method | When | Key Fields |
|--------|------|------------|
| `_kiro.dev/metadata` | After session/new, after each turn, after session/load | `sessionId`, `contextUsagePercentage`, `turnDurationMs` (optional) |
| `_kiro.dev/subagent/list_update` | After session/new, after session/load | `subagents[]`, `pendingStages[]` |
| `_kiro.dev/commands/available` | After session/new, after agent switch, after MCP init, after session/load | `sessionId`, `commands[]`, `prompts[]`, `tools[]`, `mcpServers[]` |
| `_kiro.dev/agent/switched` | After `/agent` prompt | `sessionId`, `agentName`, `previousAgentName`, `welcomeMessage`, `model` (normalized by the provider to `currentModelId`) |
| `_kiro.dev/mcp/server_initialized` | After MCP server connects | `sessionId`, `serverName` |
| `_kiro.dev/compaction/status` | During context compaction | `sessionId`, `status.type` ("started"/"completed"), `summary` |

---

## 8. Unsupported Methods

These methods crash or are silently ignored by kiro-cli 2.0.0/2.1.0:

| Method | Result | Notes |
|--------|--------|-------|
| `session/set_mode` | **Process crashes** (exit code 0) | Even with valid sessionId and modeId |
| `_kiro.dev/commands/agent/options` | **Process crashes** (exit code 0) | optionsMethod advertised but not implemented |
| `_kiro.dev/commands/execute` | **Process crashes** (exit code 0) | |
| `session/command` | Silently ignored | No response returned |
| `session/switch_mode` | Silently ignored | No response returned |
| `session/set_agent` | Silently ignored | No response returned |
| `session/configure` | Silently ignored | No response returned |
