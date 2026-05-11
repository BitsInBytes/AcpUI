# AcpUI Backend

This backend is the bridge between the web UI and ACP-compatible agent daemons.

It is intentionally provider-agnostic: provider identity, branding, models, and protocol quirks are supplied by provider configuration/modules instead of hardcoded backend logic.

## What It Handles

- Starts and manages provider runtimes.
- Maintains Socket.IO communication with the frontend.
- Persists sessions/folders/artifacts/notes in SQLite.
- Routes ACP updates into the normalized timeline/events the UI expects.
- Hosts MCP tool execution endpoints and related orchestration helpers.
- Propagates MCP cancellation/disconnect signals so long-running tools can stop their descendant work.

## Quick Start

```bash
npm install
npm run dev
```

Common validation commands:

```bash
npm run lint
npx vitest run
```

## Project Layout (High-Level)

- `server.js`: server bootstrap (HTTPS, Express, Socket.IO).
- `sockets/`: socket event handlers grouped by domain.
- `services/`: runtime, session, parsing, persistence, and helper services.
- `mcp/`: MCP server/proxy/tool orchestration.
- `routes/`: HTTP routes (uploads/static/internal APIs).
- `database.js`: SQLite schema and data access.

## Configuration

The backend reads from repository-level configuration and environment files:

- `configuration/providers.json`
- `configuration/workspaces.json`
- `configuration/commands.json`
- `configuration/counsel.json`
- `.env`

`ux_invoke_shell` uses the backend `ShellRunManager` and session-scoped `shell_run_*` socket events for interactive terminal execution. Concurrent shell calls are supported; each command receives a separate `shellRunId`, PTY, and terminal stream. On Windows, PowerShell startup terminal-control noise is sanitized before transcript streaming so the injected command prompt stays aligned with command output.

## Where To Find Detailed Technical Docs

Feature docs are now the source of truth for implementation detail and exact line references:

- [Feature Doc - Backend Architecture](../documents/%5BFeature%20Doc%5D%20-%20Backend%20Architecture.md)
- [Feature Doc - Provider System](../documents/%5BFeature%20Doc%5D%20-%20Provider%20System.md)
- [Feature Doc - JSONL Rehydration & Session Persistence](../documents/%5BFeature%20Doc%5D%20-%20JSONL%20Rehydration%20%26%20Session%20Persistence.md)
- [Feature Doc - MCP Server System](../documents/%5BFeature%20Doc%5D%20-%20MCP%20Server.md)
