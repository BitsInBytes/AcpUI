# Claude ACP Session Meta Capabilities

When creating a new session using the Claude Agent Control Protocol (ACP), you can pass additional configuration via the `_meta` field in the `NewSessionRequest`. This allows for deep customization of the agent's behavior, environment, and instructions.

## Available Meta Properties

### 1. System Prompt Customization (`systemPrompt`)
You can override or augment the default system prompt used by the agent.

| Format | Description | Example |
| :--- | :--- | :--- |
| **String** | Replaces the entire system prompt with your provided text. | `_meta: { systemPrompt: "You are a senior devops engineer." }` |
| **Object** | Appends your text to the existing default system prompt. | `_meta: { systemPrompt: { append: "Always use TypeScript for examples." } }` |

### 2. Context Expansion (`additionalRoots`)
Provides additional directory paths that the agent should include in its workspace context.

*   **Type**: `string[]`
*   **Example**: 
    ```json
    {
      "_meta": {
        "additionalRoots": ["C:/Projects/shared-library", "D:/Docs/api-specs"]
      }
    }
    ```

### 3. Claude Code Options (`claudeCode.options`)
Directly influences the underlying Claude Code instance. Note that some parameters are managed by the ACP layer (like `cwd` and `permissionMode`), but others are passed through.

| Property | Description |
| :--- | :--- |
| **`tools`** | An explicit list of tools to enable for the session. |
| **`hooks`** | Custom lifecycle hooks (merged with ACP's internal hooks). |
| **`mcpServers`** | Additional MCP servers to connect to (merged with request body). |
| **`disallowedTools`** | A list of tools that the agent is explicitly forbidden from using. |

### 4. Raw Message Debugging (`claudeCode.emitRawSDKMessages`)
Enables the client to receive raw SDK messages as notifications for advanced monitoring or debugging.

*   **`true`**: Emit all incoming SDK messages.
*   **`false` / `undefined`**: Do not emit any raw messages (default).
*   **`Array<SDKMessageFilter>`**: Emit only messages that match specific type/subtype filters.

### 5. Gateway Authentication (`gateway`)
Used for routing requests through a custom proxy or model gateway.

*   **`baseUrl`**: The endpoint for all API calls.
*   **`headers`**: A dictionary of custom HTTP headers to include in every request (e.g., for custom auth tokens).

---

## Summary JSON Example

```json
{
  "cwd": "C:/Users/Dev/MyProject",
  "mcpServers": [...],
  "_meta": {
    "systemPrompt": {
      "append": "Focus on performance and memory efficiency."
    },
    "additionalRoots": ["C:/Shared/Assets"],
    "claudeCode": {
      "options": {
        "tools": ["read_file", "write_file", "ls"],
        "disallowedTools": ["terminal"]
      },
      "emitRawSDKMessages": [
        { "type": "stream_event", "subtype": "message_delta" }
      ]
    }
  }
}
```
