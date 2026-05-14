# AcpUI Frontend

This frontend is a React app for interacting with ACP sessions through a high-fidelity chat interface.

It is designed to stay provider-agnostic. Branding, model metadata, and provider capabilities are supplied by backend payloads rather than hardcoded in UI components.

## What It Handles

- Session navigation and message rendering.
- Streaming output display (thoughts, tools, assistant text).
- Sidebar/folder/session UX flows.
- Canvas/editor/terminal surfaces, plus Shell V2 tool terminals rendered inside shell ToolSteps when `shellRunId` metadata is present, with sanitized read-only transcript rendering after command exit and green sidebar waiting state when a shell prompt needs user input.
- Settings, attachments, documentation browsing, and utility modals.

## Quick Start

```bash
npm install
npm run dev
```

For full-stack development, run `..\scripts\run.ps1 dev` from the repository root so the backend runs in watch mode and Vite serves the frontend with HMR.

Common validation commands:

```bash
npm run lint
npx vitest run
npm run build
```

## Project Layout (High-Level)

- `src/components/`: UI building blocks and feature components.
- `src/store/`: Zustand stores split by domain.
- `src/hooks/`: socket, streaming, scroll, and feature hooks.
- `src/utils/`: pure helpers and transforms.
- `src/test/`: component/store/integration tests.

## Runtime Model

- Uses a singleton Socket.IO connection.
- Pulls system/provider/session state into dedicated stores.
- Shows a blocking config error modal when the backend emits invalid config diagnostics through `config_errors`.
- Renders timeline-driven chat UI from normalized event data.

## Where To Find Detailed Technical Docs

Feature docs are now the source of truth for implementation detail and stable file/function/event anchors:

- [Feature Doc - Frontend Architecture](../documents/%5BFeature%20Doc%5D%20-%20Frontend%20Architecture.md)
- [Feature Doc - Message Bubble UI & Typewriter System](../documents/%5BFeature%20Doc%5D%20-%20Message%20Bubble%20UI%20%26%20Typewriter%20System.md)
- [Feature Doc - Chat Header](../documents/%5BFeature%20Doc%5D%20-%20Chat%20Header.md)
- [Feature Doc - Help Docs Modal](../documents/%5BFeature%20Doc%5D%20-%20Help%20Docs%20Modal.md)
- [Feature Doc - Chat Input and Prompt Area](../documents/%5BFeature%20Doc%5D%20-%20Chat%20Input%20and%20Prompt%20Area.md)
- [Feature Doc - Sidebar Rendering](../documents/%5BFeature%20Doc%5D%20-%20Sidebar%20Rendering.md)
