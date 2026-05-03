# Codex ACP Protocol Reference

Protocol shapes below are derived from the Codex ACP source (`codex-acp` 0.12.0, `agent-client-protocol` 0.11.1). They are not network captures; keep this file in sync with upstream source changes.

## initialize

Sent by AcpUI:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientCapabilities": { "terminal": true },
    "clientInfo": { "name": "AcpUI", "version": "1.0.0" }
  }
}
```

Codex ACP responds with `agentInfo.name = "codex-acp"` and capabilities for image prompts, embedded context, MCP stdio/http, session load/list/close, and auth/logout.

## authenticate

The provider sends this only when configured or when API-key environment variables exist:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "authenticate",
  "params": {
    "methodId": "codex-api-key"
  }
}
```

Supported method IDs:

- `chatgpt`
- `codex-api-key`
- `openai-api-key`

`codex-api-key` reads `CODEX_API_KEY` from the child process environment. `openai-api-key` reads `OPENAI_API_KEY`.

## session/new

Sent by AcpUI:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session/new",
  "params": {
    "cwd": "/path/to/workspace",
    "mcpServers": [
      {
        "name": "AcpUI",
        "command": "node",
        "args": ["/path/to/acpui/backend/mcp/stdio-proxy.js"],
        "env": [
          { "name": "ACP_SESSION_PROVIDER_ID", "value": "Codex" },
          { "name": "BACKEND_PORT", "value": "3005" }
        ]
      }
    ]
  }
}
```

Codex returns:

```json
{
  "sessionId": "11111111-1111-1111-1111-111111111111",
  "modes": [{ "id": "default", "name": "Default" }],
  "models": {
    "currentModelId": "model-preset/medium",
    "availableModels": [
      { "id": "model-preset/medium", "name": "Model Preset (medium)" }
    ]
  },
  "configOptions": [
    {
      "id": "mode",
      "name": "Approval Preset",
      "type": "select",
      "currentValue": "default",
      "options": [{ "value": "default", "name": "Default" }]
    },
    {
      "id": "model",
      "name": "Model",
      "type": "select",
      "currentValue": "model-preset",
      "options": [{ "value": "model-preset", "name": "Model Preset" }]
    },
    {
      "id": "reasoning_effort",
      "name": "Reasoning Effort",
      "type": "select",
      "currentValue": "medium",
      "options": [{ "value": "high", "name": "High" }]
    }
  ]
}
```

AcpUI captures `models` for the model selector, filters the `model` config option, and keeps `reasoning_effort`.

## available_commands_update

Codex emits command names without a leading slash:

```json
{
  "method": "session/update",
  "params": {
    "sessionId": "11111111-1111-1111-1111-111111111111",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        { "name": "review", "description": "Review changes" },
        { "name": "compact", "description": "Compact conversation" }
      ]
    }
  }
}
```

The provider converts this to `_codex/commands/available` with `/review` and `/compact`.

## set_model, set_mode, set_config_option

Model changes use the dedicated ACP method:

```json
{
  "method": "session/set_model",
  "params": {
    "sessionId": "11111111-1111-1111-1111-111111111111",
    "modelId": "model-preset/high"
  }
}
```

Mode changes use:

```json
{
  "method": "session/set_mode",
  "params": {
    "sessionId": "11111111-1111-1111-1111-111111111111",
    "modeId": "read-only"
  }
}
```

Reasoning effort uses raw ACP `SessionConfigOptionValue::ValueId` serialization:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "11111111-1111-1111-1111-111111111111",
    "configId": "reasoning_effort",
    "value": "high"
  }
}
```

Do not wrap the value as `{ "type": "value_id" }`; Codex ACP expects the raw string value.

## Tool Calls

Standard Codex tool call shape:

```json
{
  "sessionUpdate": "tool_call",
  "toolCallId": "call-1",
  "title": "Tool: AcpUI/ux_invoke_shell",
  "kind": "execute",
  "rawInput": {
    "invocation": {
      "server": "AcpUI",
      "tool": "ux_invoke_shell",
      "arguments": { "command": "npm test" }
    }
  }
}
```

Output can arrive as ACP content blocks:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-1",
  "status": "completed",
  "content": [
    { "type": "content", "content": { "type": "text", "text": "done" } }
  ]
}
```

or as Codex raw command output:

```json
{
  "sessionUpdate": "tool_call_update",
  "toolCallId": "call-1",
  "status": "completed",
  "rawOutput": {
    "stdout": "done",
    "stderr": "",
    "exit_code": 0
  }
}
```
