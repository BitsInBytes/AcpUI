# Gemini ACP Session Meta Capabilities

The Gemini CLI ACP accepts an optional `_meta` object when establishing the connection or authenticating.

## Available Meta Properties

### 1. API Key Authentication (`_meta.api-key`)
When authenticating via the `gemini-api-key` method, the actual key string must be provided in `_meta`.

```json
{
  "jsonrpc": "2.0",
  "method": "authenticate",
  "params": {
    "methodId": "gemini-api-key"
  },
  "_meta": {
    "api-key": "AIzaSy..."
  }
}
```

### 2. Session Context (`_meta.agent`)
While the native Gemini CLI manages its own contexts, future updates to the SDK may allow injecting specific system personas or subagents via `session/new` `_meta` configurations.

```json
{
  "jsonrpc": "2.0",
  "method": "session/new",
  "params": {
    "cwd": "C:/Projects/App",
    "mcpServers": []
  },
  "_meta": {
    "agent": "code-reviewer"
  }
}
```
