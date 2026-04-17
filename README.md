# AcpUI

A lightweight, high-performance web UI for ACP-based AI agents. Strictly provider-agnostic — swap the entire backend identity by changing a single config directory.

Spawns an ACP daemon natively on the host OS, parses the JSON-RPC stream into a **Unified Timeline**, and presents a high-fidelity chat interface with an integrated canvas, terminal, and diff viewer.

## Architecture

```
┌─────────────────────────────────────────────┐
│  Frontend (React + Vite + Zustand)          │
│  - Zero hardcoded provider references       │
│  - All branding/models from backend socket  │
├─────────────────────────────────────────────┤
│  Backend (Node.js + Express + Socket.IO)    │
│  - Generic ACP client, session management   │
│  - SQLite persistence, archive, hooks       │
│  - Stdio MCP proxy for tool execution       │
├─────────────────────────────────────────────┤
│  Provider (e.g., providers/my-provider/)    │
│  - provider.json: Protocol identity         │
│  - branding.json: UI labels and text        │
│  - user.json: REQUIRED deployment contract  │
│  - index.js: REQUIRED logic module          │
└─────────────────────────────────────────────┘
```

The backend loads a provider at startup from the `ACP_PROVIDER` env var. The provider defines the ACP command, models, branding, extension protocol, and file paths. See [PROVIDERS.md](PROVIDERS.md) for full documentation.

## Setup

### 1. Prerequisites

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **ACP CLI** — the provider's CLI must be in PATH (e.g., `my-agent-cli`)

```powershell
node --version      # verify 22+
my-agent-cli --version    # verify available
my-agent-cli login        # authenticate if needed
```

### 2. Install Dependencies

```powershell
cd backend; npm install
cd frontend; npm install
```

### 3. Configure Environment

The `.env` file at the project root controls global settings. See `.env.example` for a template and full list of available variables.

> [!CAUTION]
> **Security Warning: Remote Code Execution (RCE)**
> This application is designed to execute shell commands on your local machine via ACP-compatible agents. It provides a web interface to a tool that can perform arbitrary file system and process operations. 
> 
> **Never run the backend on a public-facing server.** It should only be run on a trusted local machine. Anyone with access to the backend port can execute arbitrary code on the host system.

### 5. Configure SSL

Modern browser features (voice recording, pop-out windows) require a secure `https` context. This app uses a self-signed certificate for local development.

```powershell
cd backend; node generate-ssl.js
```

Generates a self-signed cert for `localhost` and `127.0.0.1` (10-year validity) and auto-imports into the Windows trusted root store. 

When you run the app for the first time, you may still see a browser warning ("Your connection is not private").
- **Automatic Setup (Windows):** The `run.ps1` script attempts to trust the certificate automatically.
- **Manual Setup:** If automatic trust fails, you can manually trust the certificate at `backend/.ssl/cert.pem` using:
  ```powershell
  certutil -addstore -user -f "Root" ".\backend\.ssl\cert.pem"
  ```
Restart your browser fully after trusting the certificate.

### 6. Configure Voice STT (Optional)

The application supports real-time voice-to-text input using **Whisper**. To enable this feature:

1.  **Set Environment Variable:** In your `.env`, set `VOICE_STT_ENABLED=true`.
2.  **Download Whisper Server:** Download a pre-built `whisper-server.exe` (or build it from [whisper.cpp](https://github.com/ggerganov/whisper.cpp)).
3.  **Download Model:** Download a Whisper model (e.g., `ggml-small.bin`) from the [Hugging Face repository](https://huggingface.co/ggerganov/whisper.cpp).
4.  **Place Binaries:** Put the `.exe`, required `.dll` files, and the `.bin` model file into the `backend/whisper/` directory.

The backend will automatically spawn the whisper server on the configured `STT_PORT` when the app starts.

### 7. Configure Workspaces

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

Pinned workspaces show as permanent buttons; unpinned appear in a dropdown.

### 8. Configure Custom Commands (Optional)

`configuration/commands.json` defines custom slash commands:

```json
{
  "commands": [
    { "name": "/cp", "description": "Commit and push all changes", "prompt": "Commit and push all changes" },
    { "name": "/tf", "description": "Check test failures and fix them", "prompt": "There are visual studio test failures, check the test failure file for details and work on fixing them" }
  ]
}
```

### 9. Run

```powershell
.\scripts\run.ps1          # build frontend, start backend
.\scripts\run.ps1 dev      # dev mode with Vite HMR
```

Access at `https://localhost:3005`.

### 10. Configure Counsel

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

## Features

### Chat
- **Dynamic workspaces** — configurable workspace buttons with per-workspace CWD and agent
- **Chat branching/forking** — fork a conversation at any point to explore alternatives
- **Fork merging** — merge forked conversations back into parent with auto-generated summary
- **Streaming with adaptive typewriter** — character-by-character rendering that speeds up under buffer pressure
- **Memoized markdown** — block-level caching for smooth streaming without re-parsing
- **Slash commands** — built-in (`/compact`, `/context`, `/agent`, `/help`) plus custom commands from `configuration/commands.json`
- **Context progress bar** — live context usage percentage from provider metadata
- **Compaction** — `/compact` locks prompt, shows summary, saves to DB
- **Auto title generation** — generates chat titles after first response
- **Desktop notifications** — Windows toast notifications when background chats complete
- **Image attachments** — drag & drop images with compression, thumbnails in message bubbles
- **Session export** — export chat sessions
- **Permission system** — ACP-compliant permission request/response with approve/deny buttons

### Canvas
- **Monaco editor** — view/edit files with syntax highlighting, "Open in VS Code" button
- **Integrated terminal** — multiple terminal tabs within the canvas
- **Git file list** — staged/modified/untracked files with diff view and stage/unstage
- **Diff viewer** — side-by-side diff display for file changes
- **Canvas resize** — adjustable canvas panel width
- **Syntax highlighting in tool output** — code blocks in tool results are highlighted

### Sidebar
- **Session archive** — archive/restore sessions, or permanent delete (configurable)
- **Sidebar folders** — nested folders with drag & drop, persisted expand/collapse
- **Scratch pad notes** — per-session markdown notes with raw/rendered tabs
- **Empty state on load** — no chat auto-selected; starts with empty state until user picks or creates a session

### System Settings
- **Provider tab** — view and edit `user.json` fields directly in the UI
- **Monaco editors** — JSON config editing with syntax highlighting for provider (user.json), workspaces, and commands

### Other
- **Stdio MCP proxy** — Stdio MCP proxy spawned per ACP session — exposes UI-specific tools (shell, sub-agents) via /api/mcp/tool-call
- **Sub-agent system** — `invoke_sub_agents` spawns parallel AI agents with live streaming, sidebar nesting under parent chat, and permission inheritance
- **Multi-perspective counsel** — spawn Advocate, Critic, Pragmatist + optional domain experts to evaluate decisions
- **Shell execution** — `run_shell_command` with live streaming output and ANSI color rendering
- **Tool & turn timers** — live elapsed time on each tool call and assistant turn
- **File explorer** — full-screen file browser with Monaco editor and markdown preview
- **JSONL rehydration** — rebuild chat history from raw session files
- **Agent hooks** — `session_start`, `post_tool`, `stop` hooks from agent JSON configs
- **Voice STT** — speech-to-text input (requires whisper setup)
- **Session persistence** — periodic saves during streaming, full restore on refresh

## Tests

```powershell
cd backend; npm test     # 397 tests
cd frontend; npm test    # 657 tests
```

Total: 1,054 tests.

## Provider System

The application is fully provider-agnostic. All branding, models, paths, and extension protocols are defined in a provider directory. To use a different ACP backend, create a new provider and point `ACP_PROVIDER` to it.

See [PROVIDERS.md](PROVIDERS.md) for the complete provider system documentation, including the JSON schema, module interface, and step-by-step guide for creating new providers.

## Troubleshooting

- **"ACP_PROVIDER not configured"** — set `ACP_PROVIDER` in `.env` (no default)
- **Can't access from browser** — verify `https://localhost:3005` and SSL cert is trusted
- **"Engine warming up..."** — ACP CLI not in PATH or not authenticated
- **Socket disconnects** — check `pingTimeout` in server.js
- **Extensions not working** — verify `protocolPrefix` in `provider.json` matches ACP daemon output
