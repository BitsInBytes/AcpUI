# AcpUI Backend

This backend is the bridge between the web UI and ACP-compatible agent daemons.

It is intentionally provider-agnostic: provider identity, branding, models, and protocol quirks are supplied by provider configuration/modules instead of hardcoded backend logic.

## What It Handles

- Starts and manages provider runtimes.
- Maintains Socket.IO communication with the frontend.
- Persists sessions/folders/artifacts/notes in SQLite.
- Routes ACP updates into the normalized timeline/events the UI expects.
- Hosts MCP tool execution endpoints and related orchestration helpers.
- Serves read-only repository Markdown documentation through Socket.IO callbacks.
- Propagates MCP cancellation/disconnect signals so long-running tools can stop their descendant work.

## Quick Start

```bash
npm install
npm run dev      # backend watch mode
npm run start    # production backend process
```

The repository launcher uses `npm run dev` for backend hot reload when you run `..\scripts\run.ps1 dev`.

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
- `configuration/mcp.json`
- `.env`

Invalid startup or socket-hydrated config is collected by `services/jsonConfigDiagnostics.js` and sent to clients as `config_errors`. Provider-critical failures, including malformed JSON and missing required enabled-provider definitions, keep the backend alive but stop provider daemon startup and normal socket hydration until the config is fixed.

`ux_invoke_shell` uses the backend `ShellRunManager` and session-scoped `shell_run_*` socket events for interactive terminal execution. Concurrent shell calls are supported; each command receives a separate `shellRunId`, PTY, and terminal stream. The PTY environment sets `GIT_PAGER=cat` so Git commands print directly instead of launching an interactive pager. Prompt-like output that waits for stdin is flagged with `needsInput` so the frontend can show the session as waiting for input. On Windows, PowerShell startup terminal-control noise is sanitized before transcript streaming so the injected command prompt stays aligned with command output.

MCP tools are controlled by `configuration/mcp.json`, or the JSON file referenced by `MCP_CONFIG`. Core tools are enabled by default. Optional tools are disabled by default; the IO group advertises `ux_read_file`, `ux_write_file`, `ux_replace`, `ux_list_directory`, `ux_glob`, `ux_grep_search`, and `ux_web_fetch`, and the Google search group advertises `ux_google_web_search`. `ux_google_web_search` requires `googleSearch.apiKey` in the MCP config before it is advertised.

## Where To Find Detailed Technical Docs

Feature docs are now the source of truth for implementation detail and stable file/function/event anchors:

- [Feature Doc - Backend Architecture](../documents/%5BFeature%20Doc%5D%20-%20Backend%20Architecture.md)
- [Feature Doc - Help Docs Modal](../documents/%5BFeature%20Doc%5D%20-%20Help%20Docs%20Modal.md)
- [Feature Doc - Provider System](../documents/%5BFeature%20Doc%5D%20-%20Provider%20System.md)
- [Feature Doc - JSONL Rehydration & Session Persistence](../documents/%5BFeature%20Doc%5D%20-%20JSONL%20Rehydration%20%26%20Session%20Persistence.md)
- [Feature Doc - MCP Server System](../documents/%5BFeature%20Doc%5D%20-%20MCP%20Server.md)
- [Feature Doc - IO MCP Tools](../documents/%5BFeature%20Doc%5D%20-%20IO%20MCP%20Tools.md)
- [Feature Doc - Google Search MCP Tool](../documents/%5BFeature%20Doc%5D%20-%20Google%20Search%20MCP%20Tool.md)
- [Feature Doc - MCP Feature Flag System](../documents/%5BFeature%20Doc%5D%20-%20MCP%20Feature%20Flag%20System.md)
