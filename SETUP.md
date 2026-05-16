# AcpUI Setup

This guide contains the repo-level setup, configuration, run, validation, and troubleshooting instructions for AcpUI.

For the high-level project overview, see [README.md](README.md).

## 1. Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **ACP CLI** — the provider's CLI must be in PATH, for example `my-agent-cli`

```powershell
node --version              # verify 22+
my-agent-cli --version      # verify available
my-agent-cli login          # authenticate if needed
```

## 2. Install Dependencies

```powershell
cd backend; npm install
cd frontend; npm install
```

## 3. Configure Providers

The system requires at least one provider in `configuration/providers.json`. Copy the example file to get started:

```powershell
cp configuration/providers.json.example configuration/providers.json
```

Example `providers.json`:

```json
{
  "defaultProviderId": "provider-a",
  "providers": [
    { "id": "provider-a", "path": "providers/provider-a", "label": "Provider A" },
    { "id": "provider-b", "path": "providers/provider-b", "label": "Provider B", "enabled": false }
  ]
}
```

Each provider directory is responsible for its own `provider.json`, branding, user defaults, and provider README. See [documents/[Feature Doc] - Provider System.md](<documents/[Feature Doc] - Provider System.md>) for the full provider contract.

## 4. Configure Environment

The `.env` file at the project root controls global settings. Use `.env.example` as the template and source of available variables.

## 5. Configure MCP Tools

AcpUI exposes UI-specific tools to ACP agents through a per-session stdio MCP proxy. Tool availability is controlled by the JSON file referenced by `MCP_CONFIG`; when `MCP_CONFIG` is not set, the backend reads `configuration/mcp.json`.

Create the runtime config from the checked-in example:

```powershell
cp configuration/mcp.json.example configuration/mcp.json
```

The MCP config is fail-closed: if the selected file is missing or malformed, all config-controlled MCP tools are disabled. The backend caches the config during process startup, and each MCP proxy captures the advertised tool list when its ACP session starts. Restart the backend after editing `configuration/mcp.json`, then create or reload sessions so agents see the updated tool list.

The top-level `tools` block enables tool groups. Each flag can be either `true` / `false` or an object such as `{ "enabled": true }`.

| Config key | Exposed tools |
|---|---|
| `tools.invokeShell` | `ux_invoke_shell` |
| `tools.subagents` | `ux_invoke_subagents`, plus `ux_check_subagents` and `ux_abort_subagents` |
| `tools.counsel` | `ux_invoke_counsel`, plus `ux_check_subagents` and `ux_abort_subagents` |
| `tools.io` | `ux_read_file`, `ux_write_file`, `ux_replace`, `ux_list_directory`, `ux_glob`, `ux_grep_search`, `ux_web_fetch` |
| `tools.googleSearch` | `ux_google_web_search`, only when `googleSearch.apiKey` is also non-empty |

The other config blocks control tool behavior:

- `subagents.statusWaitTimeoutMs` and `subagents.statusPollIntervalMs` control how long `ux_check_subagents` waits for async agent results and how often it polls.
- `io.autoAllowWorkspaceCwd` allows file IO inside the active workspace automatically. `io.allowedRoots` adds extra allowed roots; `allowedRoots: ["*"]` allows any resolved path. The `maxReadBytes`, `maxWriteBytes`, `maxReplaceBytes`, and `maxOutputBytes` fields cap IO size.
- `webFetch.allowedProtocols`, `blockedHosts`, `blockedHostPatterns`, `blockedCidrs`, `maxResponseBytes`, `timeoutMs`, and `maxRedirects` define URL fetch guardrails for `ux_web_fetch`.
- `googleSearch.apiKey`, `timeoutMs`, and `maxOutputBytes` configure grounded Google search. Keep real API keys in local-only config or point `MCP_CONFIG` at a private file.

A provider must also define `mcpName` in its `provider.json`; otherwise AcpUI will not inject the MCP proxy for that provider even when tool flags are enabled.

Minimal example:

```json
{
  "tools": {
    "invokeShell": { "enabled": true },
    "subagents": { "enabled": true },
    "counsel": { "enabled": true },
    "io": { "enabled": true },
    "googleSearch": { "enabled": false }
  },
  "subagents": {
    "statusWaitTimeoutMs": 120000,
    "statusPollIntervalMs": 1000
  },
  "io": {
    "autoAllowWorkspaceCwd": true,
    "allowedRoots": [],
    "maxReadBytes": 1048576,
    "maxWriteBytes": 1048576,
    "maxReplaceBytes": 1048576,
    "maxOutputBytes": 262144
  },
  "webFetch": {
    "allowedProtocols": ["http:", "https:"],
    "blockedHosts": [],
    "blockedHostPatterns": [],
    "blockedCidrs": [],
    "maxResponseBytes": 1048576,
    "timeoutMs": 15000,
    "maxRedirects": 5
  },
  "googleSearch": {
    "apiKey": "",
    "timeoutMs": 15000,
    "maxOutputBytes": 262144
  }
}
```

## 6. Configure SSL

Modern browser features such as voice recording and pop-out windows require a secure `https` context. This app uses a self-signed certificate for local development.

```powershell
cd backend; node generate-ssl.js
```

This generates a self-signed cert for `localhost` and `127.0.0.1` with 10-year validity and auto-imports it into the Windows trusted root store.

When you run the app for the first time, you may still see a browser warning such as "Your connection is not private".

- **Automatic setup on Windows:** `scripts/run.ps1` attempts to trust the certificate automatically.
- **Manual setup:** if automatic trust fails, manually trust `backend/.ssl/cert.pem`:

```powershell
certutil -addstore -user -f "Root" ".\backend\.ssl\cert.pem"
```

Restart your browser fully after trusting the certificate.

MCP proxy backend calls now keep TLS verification enabled by default. The backend passes `backend/.ssl/cert.pem` to MCP proxy children through `NODE_EXTRA_CA_CERTS` when the file exists, so the documented local cert flow remains the supported path.

For local troubleshooting only, you can opt in to insecure MCP proxy TLS bypass by setting `ACP_UI_ALLOW_INSECURE_MCP_PROXY_TLS=1` before starting the backend. This disables certificate verification for MCP proxy backend calls and is intentionally disabled by default.

## 7. Configure Voice STT (Optional)

The application supports real-time voice-to-text input using Whisper.

1. In `.env`, set `VOICE_STT_ENABLED=true`.
2. Download a pre-built `whisper-server.exe`, or build it from [whisper.cpp](https://github.com/ggerganov/whisper.cpp).
3. Download a Whisper model such as `ggml-small.bin` from the [Hugging Face whisper.cpp repository](https://huggingface.co/ggerganov/whisper.cpp).
4. Put the `.exe`, required `.dll` files, and `.bin` model file in `backend/whisper/`.

The backend automatically spawns the whisper server on the configured `STT_PORT` when the app starts, and controlled backend shutdown stops the whisper-server child process.

## 8. Configure Workspaces

`configuration/workspaces.json` defines workspace buttons in the sidebar:

```json
{
  "workspaces": [
    { "label": "Project-A", "path": "C:\\repos\\project-a", "agent": "agent-dev", "pinned": true },
    { "label": "Project-B", "path": "C:\\repos\\project-b", "agent": "agent-dev", "pinned": true },
    { "label": "My-App", "path": "C:\\repos\\my-app", "agent": "agent-dev" }
  ]
}
```

Pinned workspaces show as permanent buttons; unpinned workspaces appear in a dropdown.

## 9. Configure Custom Commands (Optional)

`configuration/commands.json` defines custom slash commands:

```json
{
  "commands": [
    { "name": "/cp", "description": "Commit and push all changes", "prompt": "Commit and push all changes" }
  ]
}
```

## 10. Configure Counsel

`configuration/counsel.json` defines counsel prompts sent to the agents:

```json
{
  "agents": {
    "core": [
      {
        "id": "advocate",
        "name": "Advocate",
        "prompt": "You are the Advocate. Your role is to argue FOR the approach or idea presented. Find every reason this is a good idea. Identify benefits, opportunities, and how to make it work. Be thorough and persuasive. Present your strongest case."
      },
      {
        "id": "critic",
        "name": "Critic",
        "prompt": "You are the Critic. Your role is to argue AGAINST the approach or idea presented. Find every weakness, risk, and potential problem. Play devil's advocate. What could go wrong? What are the hidden costs? What assumptions are being made?"
      },
      {
        "id": "pragmatist",
        "name": "Pragmatist",
        "prompt": "You are the Pragmatist. Your role is to evaluate this practically and objectively. What's the effort vs reward? What are the realistic alternatives? What would you actually recommend to a team with limited time and resources? Be grounded and actionable."
      }
    ],
    "optional": {
      "architect": {
        "name": "Architect",
        "prompt": "You are a Software Architecture expert. Evaluate this from an architectural perspective. Consider scalability, maintainability, separation of concerns, system boundaries, and long-term technical debt. How does this decision affect the overall system design?"
      },
      "performance": {
        "name": "Performance Expert",
        "prompt": "You are a Software Performance expert. Evaluate this from a performance perspective. Consider latency, throughput, memory usage, computational complexity, caching opportunities, and bottlenecks. What are the performance implications of this decision?"
      },
      "security": {
        "name": "Security Expert",
        "prompt": "You are a Software Security expert. Evaluate this from a security perspective. Consider attack surfaces, authentication, authorization, data protection, injection risks, and compliance requirements. What are the security implications?"
      },
      "ux": {
        "name": "UX Expert",
        "prompt": "You are a Software UX expert. Evaluate this from a user experience perspective. Consider usability, accessibility, user workflows, error handling, feedback mechanisms, and cognitive load. How does this decision affect the end user?"
      }
    }
  }
}
```

## 11. Configure Global Settings / Custom Agents

For the best experience, configure custom agents without their built-in `Bash`, `PowerShell`, `Shell`, and sub-agent commands. Some providers allow this on a per-agent basis; others require their global settings file to be changed. Each provider README should document the expected setup or explain how it is done automatically.

Use the AcpUI-specific tools instead:

- **`ux_invoke_shell`** — Execute shell commands through AcpUI in a real terminal-backed tool step with live output, user stdin, resize, stop controls, input-wait detection, and separate terminals for concurrent shell calls.
- **`ux_invoke_subagents`** — Spawn parallel AI agents asynchronously with live streaming, sidebar nesting under parent chat, permission controls, status/result follow-up through `ux_check_subagents`, and parent-agent aborts through `ux_abort_subagents`.

The MCP server name that exposes these tools is defined in the provider's `provider.json` file and defaults to `AcpUI`. Provider READMEs should also cover how to allow these tools if you do not want to see permission requests when they are used.

This keeps shell commands, sub-agent spawning, and tool calls flowing through AcpUI's unified timeline, session context, permissions, canvas, terminal, and diff viewer.

## 12. Run

```powershell
.\scripts\run-no-hot-reload.ps1  # no hot reload: build frontend, start backend
.\scripts\run-hot-reload.ps1     # hot reload: backend watch mode + Vite HMR
```

These wrappers call the canonical launcher. Equivalent forms are `.\scripts\run.ps1 prod` and `.\scripts\run.ps1 dev`.

In no-hot-reload mode, access the app at `https://localhost:3005`. In hot-reload mode, use the Vite URL printed by the script, typically `https://localhost:5173`; the frontend connects to the backend on `BACKEND_PORT`.

Backend-only scripts are available from `backend/`:

```powershell
npm run start    # production backend process
npm run dev      # backend watch mode
```

Frontend-only Vite development is available from `frontend/`:

```powershell
npm run dev
```

For full-stack development with hot reload, prefer `.\scripts\run-hot-reload.ps1` so backend watch mode and Vite HMR start together.

## 13. Validate

Run backend validation from `backend/`:

```powershell
npm run lint
npx vitest run
```

Run frontend validation from `frontend/`:

```powershell
npm run lint
npx vitest run
npm run build
```

Run coverage when coverage percentages are needed:

```powershell
cd backend; npx vitest run --coverage
cd frontend; npx vitest run --coverage
```

Frontend test setup mocks `HTMLCanvasElement.getContext`, `window.alert`, and `window.open` to keep CI/local test output stable and warning-free.

## Troubleshooting

- **"Provider registry does not contain any enabled providers"** — verify `configuration/providers.json` exists and contains at least one enabled provider.
- **Can't access from browser** — verify `https://localhost:3005` is reachable and the SSL cert is trusted.
- **"Engine warming up..."** — verify the ACP CLI is in PATH and authenticated.
- **Socket disconnects** — check `pingTimeout` in `backend/server.js`.
- **Extensions not working** — verify `protocolPrefix` in `provider.json` matches ACP daemon output.
- **MCP tools missing from agents** — verify `configuration/mcp.json`, the provider `mcpName`, backend restart, and new/reloaded ACP sessions.
- **MCP proxy TLS/certificate errors** — run `cd backend; node generate-ssl.js`, trust `backend/.ssl/cert.pem`, then restart backend + agent session. Use `ACP_UI_ALLOW_INSECURE_MCP_PROXY_TLS=1` only as a local troubleshooting override.
- **Voice input unavailable** — verify `VOICE_STT_ENABLED=true`, whisper files exist under `backend/whisper/`, and `STT_PORT` is not already in use.
