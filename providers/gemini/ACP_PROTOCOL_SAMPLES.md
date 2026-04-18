# Gemini ACP Protocol Reference

Real protocol samples captured from `gemini --acp` (v0.41.0-nightly.20260423) on 2026-04-18.
All session IDs, local paths, and API keys are sanitised.

---

## Table of Contents

1. [Handshake Timing](#1-handshake-timing)
2. [initialize](#2-initialize)
3. [authenticate](#3-authenticate)
4. [session/new](#4-sessionnew)
5. [session/load](#5-sessionload)
6. [session/set\_mode](#6-sessionset_mode)
7. [session/set\_model](#7-sessionset_model)
8. [session/prompt — Simple Text](#8-sessionprompt--simple-text)
9. [session/prompt — Tool Calls](#9-sessionprompt--tool-calls)
   - [9a. Read tool](#9a-read-tool-kind-read)
   - [9b. Think tool (internal)](#9b-think-tool-kind-think)
   - [9c. Edit/write tool with diff](#9c-editwrite-tool-kind-edit)
   - [9d. Execute tool](#9d-execute-tool-kind-execute)
10. [session/request\_permission](#10-sessionrequest_permission)
11. [session/cancel](#11-sessioncancel)
12. [available\_commands\_update](#12-available_commands_update)
13. [agent\_thought\_chunk](#13-agent_thought_chunk)
14. [FS Proxy (when `fs` capability is claimed)](#14-fs-proxy)

---

## 1. Handshake Timing

**Critical:** Gemini CLI holds the `initialize` response until after `authenticate` completes. Both requests must be sent before awaiting either response. Additionally, the `initialize` response can take 30–90 seconds to arrive if the CLI is loading extensions, memory, or project configuration.

```
Client → initialize (id: 1)          # send immediately
Client → authenticate (id: 2)         # send immediately, do NOT wait for initialize first
Server → authenticate result {}       # arrives quickly
Server → initialize result {...}      # arrives LATE — after auth, often during session/new setup
Client → session/new (id: 3)         # safe to send once authenticate result arrives
```

Do **not** claim `fs` capability in `clientCapabilities` unless the client implements the FS proxy (see §14). Claiming it without handling the requests causes file-write operations to stall indefinitely.

---

## 2. initialize

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": {
      "terminal": true
    },
    "clientInfo": { "name": "AcpUI", "version": "1.0.0" }
  }
}
```

**Received** *(arrives late — see §1)*:
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentInfo": {
      "name": "gemini-cli",
      "title": "Gemini CLI",
      "version": "0.41.0-nightly.20260423.gaa05b4583"
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
    },
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
        "_meta": {
          "api-key": { "provider": "google" }
        }
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
        "_meta": {
          "gateway": { "protocol": "google", "restartRequired": "false" }
        }
      }
    ]
  }
}
```

---

## 3. authenticate

The `_meta` field carrying the API key is placed **inside `params`**, not at the JSON-RPC envelope level. Gemini CLI reads it from the request params object (`req._meta`).

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {
    "methodId": "gemini-api-key",
    "_meta": {
      "api-key": "AIzaSy..."
    }
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {}
}
```

---

## 4. session/new

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
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
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
        { "modelId": "auto-gemini-3",                      "name": "Auto (Gemini 3)",   "description": "Let Gemini CLI decide the best model for the task: gemini-3.1-pro, gemini-3-flash" },
        { "modelId": "auto-gemini-2.5",                    "name": "Auto (Gemini 2.5)", "description": "Let Gemini CLI decide the best model for the task: gemini-2.5-pro, gemini-2.5-flash" },
        { "modelId": "gemini-3.1-pro-preview",             "name": "gemini-3.1-pro-preview" },
        { "modelId": "gemini-3-flash-preview",             "name": "gemini-3-flash-preview" },
        { "modelId": "gemini-3.1-flash-lite-preview",      "name": "gemini-3.1-flash-lite-preview" },
        { "modelId": "gemini-2.5-pro",                     "name": "gemini-2.5-pro" },
        { "modelId": "gemini-2.5-flash",                   "name": "gemini-2.5-flash" },
        { "modelId": "gemini-2.5-flash-lite",              "name": "gemini-2.5-flash-lite" }
      ],
      "currentModelId": "gemini-3.1-pro-preview"
    }
  }
}
```

**Note:** `currentModeId` and `currentModelId` reflect the user's saved settings, not hardcoded defaults. Mode IDs use **camelCase** (`autoEdit`, not `auto_edit`). Immediately after this result, an `available_commands_update` notification is sent (see §12).

---

## 5. session/load

Used to resume a previously created session in a new process. The response shape is the same as `session/new` **except there is no `sessionId` field** (the client already provided it in the request).

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/load",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "cwd": "C:\\Users\\user\\project",
    "mcpServers": []
  }
}
```

**History drain (arrives before AND after the result):**

The daemon replays the session history as `session/update` notifications. History events begin arriving before the JSON-RPC result and continue after it. The client must drain all of them.

User messages from history arrive as `user_message_chunk`:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "user_message_chunk",
      "content": { "type": "text", "text": "Create a new file named example.txt..." }
    }
  }
}
```

Completed tool calls from history arrive as a single `tool_call` with `status: "completed"` (including `content` inline — no separate `tool_call_update`):
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "lqrxjz67",
      "status": "completed",
      "title": "WriteFile",
      "content": [
        {
          "type": "diff",
          "path": "example.txt",
          "oldText": "",
          "newText": "capture test"
        }
      ],
      "kind": "edit"
    }
  }
}
```

**Received (result):**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
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
        { "modelId": "gemini-2.5-pro",   "name": "gemini-2.5-pro" },
        { "modelId": "gemini-2.5-flash", "name": "gemini-2.5-flash" }
      ],
      "currentModelId": "gemini-3.1-pro-preview"
    }
  }
}
```

After the result, remaining history notifications arrive (assistant messages, additional tool calls), followed by `available_commands_update` (see §12).

---

## 6. session/set\_mode

Mode IDs use **camelCase**. Sending a snake\_case ID (e.g. `auto_edit`) returns an error.

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session/set_mode",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "modeId": "autoEdit"
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

**Error (invalid mode ID — camelCase required):**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "error": {
    "code": -32603,
    "message": "Internal error",
    "data": { "details": "Invalid or unavailable mode: auto_edit" }
  }
}
```

**Available mode IDs:** `default` · `autoEdit` · `yolo` · `plan`

---

## 7. session/set\_model

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session/set_model",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "modelId": "gemini-2.5-pro"
  }
}
```

**Received:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {}
}
```

`modelId` must be one of the `modelId` values from `availableModels` in the `session/new` result.

---

## 8. session/prompt — Simple Text

**Sent:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session/prompt",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "prompt": [
      { "type": "text", "text": "Reply with exactly the words: Hello World" }
    ]
  }
}
```

**Received update** (`agent_message_chunk` — `content` is a **single object**, not an array):
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "agent_message_chunk",
      "content": { "type": "text", "text": "Hello World" }
    }
  }
}
```

**Result** (after all `session/update` notifications):
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "stopReason": "end_turn",
    "_meta": {
      "quota": {
        "token_count": {
          "input_tokens": 28214,
          "output_tokens": 2
        },
        "model_usage": [
          {
            "model": "gemini-3.1-pro-preview",
            "token_count": { "input_tokens": 28214, "output_tokens": 2 }
          }
        ]
      }
    }
  }
}
```

---

## 9. session/prompt — Tool Calls

### 9a. Read tool (`kind: "read"`)

`tool_call` — execution starts:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "032j8cxi",
      "status": "in_progress",
      "title": "package.json",
      "content": [],
      "locations": [{ "path": "C:\\Users\\user\\project\\package.json" }],
      "kind": "read"
    }
  }
}
```

`tool_call_update` — completed. **`content` is empty** — file content goes to the model, not the UI:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "032j8cxi",
      "status": "completed",
      "title": "package.json",
      "content": [],
      "locations": [{ "path": "C:\\Users\\user\\project\\package.json" }],
      "kind": "read"
    }
  }
}
```

`tool_call_update` — failed (file not found):
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "032j8cxi",
      "status": "failed",
      "content": [
        {
          "type": "content",
          "content": { "type": "text", "text": "File not found: C:\\Users\\user\\project\\package.json" }
        }
      ],
      "kind": "read"
    }
  }
}
```

---

### 9b. Think tool (`kind: "think"`)

Gemini CLI uses an internal "Update topic" tool to maintain conversation context. It appears as `kind: "think"` and includes a markdown summary in `content[]` on completion.

`tool_call`:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "ns5hnc15",
      "status": "in_progress",
      "title": "Update topic to: \"Create Capture Test File\"",
      "content": [],
      "locations": [],
      "kind": "think"
    }
  }
}
```

`tool_call_update` — completed with summary text in `content[]`:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "ns5hnc15",
      "status": "completed",
      "title": "Update topic to: \"Create Capture Test File\"",
      "content": [
        {
          "type": "content",
          "content": {
            "type": "text",
            "text": "## 📂 Topic: **Create Capture Test File**\n\n**Summary:**\nCreating `_acp_capture_test.txt` with requested content.\n\n> [!STRATEGY]\n> **Intent:** Create a new test text file."
          }
        }
      ],
      "locations": [],
      "kind": "think"
    }
  }
}
```

---

### 9c. Edit/write tool (`kind: "edit"`)

`tool_call` — execution starts:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "2o0g29ii",
      "status": "in_progress",
      "title": "Writing to example.txt",
      "content": [],
      "locations": [{ "path": "C:\\Users\\user\\project\\example.txt" }],
      "kind": "edit"
    }
  }
}
```

`tool_call_update` — completed. The `content[]` array contains a `diff` block. `_meta.kind` indicates the change type: `"add"` (new file), `"modify"` (existing file changed), `"delete"` (file removed):
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "2o0g29ii",
      "status": "completed",
      "title": "Writing to example.txt",
      "content": [
        {
          "type": "diff",
          "path": "C:\\Users\\user\\project\\example.txt",
          "oldText": "",
          "newText": "capture test",
          "_meta": { "kind": "add" }
        }
      ],
      "locations": [{ "path": "C:\\Users\\user\\project\\example.txt" }],
      "kind": "edit"
    }
  }
}
```

---

### 9d. Execute tool (`kind: "execute"`)

Shell commands. In `autoEdit` or `yolo` modes these run without a permission prompt. In `default` mode, permanently approved commands also skip the prompt (see §10 for the permission flow).

`tool_call`:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "run_shell_command-1777425578771-2",
      "status": "in_progress",
      "title": "echo hello_capture",
      "content": [],
      "locations": [],
      "kind": "execute"
    }
  }
}
```

`tool_call_update` — completed. **`content` is empty** — stdout/stderr go to the model, not the UI:
```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "tool_call_update",
      "toolCallId": "run_shell_command-1777425578771-2",
      "status": "completed",
      "title": "echo hello_capture",
      "content": [],
      "locations": [],
      "kind": "execute"
    }
  }
}
```

---

## 10. session/request\_permission

In `default` mode, tools that are not permanently approved send a `session/request_permission` **request** (with `id`) to the client before executing. The client must respond before the tool proceeds.

**Received from server** (JSON-RPC request — client must reply):
```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session/request_permission",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "options": [
      { "optionId": "proceed_once",   "name": "Allow once",   "kind": "allow_once" },
      { "optionId": "proceed_always", "name": "Allow always", "kind": "allow_always" },
      { "optionId": "cancel",         "name": "Deny",         "kind": "reject_once" }
    ],
    "toolCall": {
      "toolCallId": "run_shell_command-1777425578771-2",
      "status": "pending",
      "title": "echo hello_capture",
      "content": [],
      "locations": [],
      "kind": "execute"
    }
  }
}
```

**Client response — allow once:**
```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "outcome": "selected",
    "optionId": "proceed_once"
  }
}
```

**Client response — deny:**
```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "outcome": "cancelled"
  }
}
```

After the client responds with `allow`, the tool executes and the normal `tool_call` / `tool_call_update` sequence follows.

---

## 11. session/cancel

Sent as a **notification** (no `id`). The in-flight `session/prompt` returns immediately with `stopReason: "cancelled"`.

**Sent** (while a `session/prompt` request is in flight):
```json
{
  "jsonrpc": "2.0",
  "method": "session/cancel",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890"
  }
}
```

**Received** (the pending `session/prompt` result resolves immediately):
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "stopReason": "cancelled"
  }
}
```

---

## 12. available\_commands\_update

Emitted as a `session/update` notification shortly after `session/new` or `session/load` completes. For `session/load`, it arrives after the remaining history drain notifications.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "memory",               "description": "Manage memory." },
        { "name": "memory show",          "description": "Shows the current memory contents." },
        { "name": "memory refresh",       "description": "Refreshes the memory from the source." },
        { "name": "memory list",          "description": "Lists the paths of the GEMINI.md files in use." },
        { "name": "memory add",           "description": "Add content to the memory." },
        { "name": "memory inbox",         "description": "Lists skills extracted from past sessions that are pending review." },
        { "name": "extensions",           "description": "Manage extensions." },
        { "name": "extensions list",      "description": "Lists all installed extensions." },
        { "name": "extensions explore",   "description": "Explore available extensions." },
        { "name": "extensions enable",    "description": "Enable an extension." },
        { "name": "extensions disable",   "description": "Disable an extension." },
        { "name": "extensions install",   "description": "Install an extension from a git repo or local path." },
        { "name": "extensions link",      "description": "Link an extension from a local path." },
        { "name": "extensions uninstall", "description": "Uninstall an extension." },
        { "name": "extensions restart",   "description": "Restart an extension." },
        { "name": "extensions update",    "description": "Update an extension." },
        { "name": "init",                 "description": "Analyzes the project and creates a tailored GEMINI.md file" },
        { "name": "restore",              "description": "Restore to a previous checkpoint, or list available checkpoints to restore." },
        { "name": "restore list",         "description": "Lists all available checkpoints." },
        { "name": "about",                "description": "Show version and environment info" },
        { "name": "help",                 "description": "Show available commands" }
      ]
    }
  }
}
```

---

## 13. agent\_thought\_chunk

When the model produces inline thinking, it is streamed as `agent_thought_chunk` updates before the corresponding `agent_message_chunk` text. Same `content` shape as `agent_message_chunk`.

```json
{
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890",
    "update": {
      "sessionUpdate": "agent_thought_chunk",
      "content": {
        "type": "text",
        "text": "[current working directory C:\\Users\\user\\project] (Echoes 'hello_capture' to the console.)"
      }
    }
  }
}
```

---

## 14. FS Proxy

If the client advertises `clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }` in `initialize`, Gemini CLI routes all file I/O through JSON-RPC **requests to the client** instead of direct local filesystem access.

**Do not claim this capability unless you implement both handlers.** Claiming it without responding causes every file-write operation to stall indefinitely waiting for a client reply. Since AcpUI and Gemini CLI run on the same machine, omit `fs` and let the CLI use the local filesystem directly.

When claimed, the server sends these as JSON-RPC requests (with `id`) that the client must answer:

**`fs/read_text_file` — server asks client to read a file:**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "method": "fs/read_text_file",
  "params": {
    "path": "C:\\Users\\user\\project\\example.txt",
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890"
  }
}
```

**Client response:**
```json
{
  "jsonrpc": "2.0",
  "id": 0,
  "result": { "content": "existing file contents here" }
}
```

*(Return `{ "content": "" }` if the file does not exist yet.)*

**`fs/write_text_file` — server asks client to write a file:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "fs/write_text_file",
  "params": {
    "path": "C:\\Users\\user\\project\\example.txt",
    "content": "capture test",
    "sessionId": "a1b2c3d4-e5f6-7890-ab12-cd34ef567890"
  }
}
```

**Client response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {}
}
```
