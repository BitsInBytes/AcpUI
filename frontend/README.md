# Frontend

React application providing an IDE-grade chat interface. Runs natively on Windows.

## Tech Stack

- **React 19 + Vite 8** — fast builds, HMR in dev mode
- **Zustand** — state management split across focused stores
- **Socket.IO Client** — singleton connection, infinite reconnection
- **Monaco Editor** — syntax-highlighted canvas, diff viewer (SafeDiffEditor)
- **ReactMarkdown** — with memoized block rendering for smooth streaming
- **xterm.js** — integrated terminal tabs

## Architecture

```
store/
  useChatStore.ts       — Session CRUD, submit, hydrate, initial load, dynamic model state
  useStreamStore.ts     — Streaming: tokens, thoughts, events, typewriter, processBuffer
  useSystemStore.ts     — Socket, connection state, slash commands, context usage, compaction, branding, inspectConfig
  useUIStore.ts         — Sidebar, modals, settings, model dropdown
  useFolderStore.ts     — Folder CRUD, expand/collapse with localStorage persistence
  useVoiceStore.ts      — Recording state, audio devices
  useCanvasStore.ts     — Canvas artifacts, file editing, terminal tabs
  useSubAgentStore.ts   — Sub-agent lifecycle, tokens, tool steps, permissions

components/
  ChatMessage.tsx       — Router: delegates to UserMessage or AssistantMessage
  UserMessage.tsx       — User bubble with image thumbnails and file pills
  AssistantMessage.tsx  — Timeline rendering with collapse logic, turn timer, fork button
  ToolStep.tsx          — Tool call display with diff/output rendering, tool timer
  PermissionStep.tsx    — Permission request with action buttons
  renderToolOutput.tsx  — Syntax highlighting for file reads/creates, JSON pretty-printing, diff coloring, ANSI color rendering
  MemoizedMarkdown.tsx  — Stable DOM for completed messages (no re-render on parent update)
  Terminal.tsx          — Integrated terminal component
  SubAgentPanel.tsx     — Sub-agent cards with tool steps and permission actions
  Sidebar.tsx           — Session list, search, dynamic workspaces (pinned + overflow picker), folder tree, fork nesting
  SessionItem.tsx       — Session row with rename/pin/archive, notes indicator, fork icon for forked sessions
  FolderItem.tsx        — Recursive folder with expand/collapse, rename, drag & drop
  WorkspacePickerModal.tsx — Overflow workspace picker
  ArchiveModal.tsx      — Archive browser with search, restore, delete
  SessionSettingsModal.tsx — Session info, context usage, full dynamic model catalog, rehydrate, delete
  SystemSettingsModal.tsx  — Audio devices, environment variables, Monaco editors for JSON config
  NotesModal.tsx        — Per-session scratch pad with syntax-highlighted markdown preview, no close on outside click
  FileExplorer.tsx      — Full-screen file browser with Monaco editor + markdown preview
  ConfirmModal.tsx      — Reusable confirmation dialog
  FileTray.tsx          — File attachment tray
  HistoryList.tsx       — Chat history list
  ChatInput/
    ChatInput.tsx       — Input area, paste handler, voice, file upload, terminal/canvas/auto-scroll/merge-fork pills, context progress bar
    SlashDropdown.tsx   — Slash command autocomplete
    ModelSelector.tsx   — Footer model display with quick-access choices plus the current non-quick model
  ChatHeader/
    ChatHeader.tsx      — Auto-scroll, file explorer, system settings buttons
  CanvasPane/
    CanvasPane.tsx      — Monaco editor, terminal tabs, git file list, diff viewer (SafeDiffEditor), canvas resize
  MessageList/
    MessageList.tsx     — Virtualized message list
  Status/
    StatusIndicator.tsx — Connection status indicator
  Modals/
    SSLErrorOverlay.tsx — SSL certificate error overlay

hooks/
  useSocket.ts          — Singleton socket, provider_extension handling, session_model_options, branding handler, custom_commands handler, compaction
  useChatManager.ts     — Socket event listeners, typewriter loop
  useFileUpload.ts      — File upload via HTTP + paste handler
  useScroll.ts          — Auto-scroll with manual override
  useVoice.ts           — WavRecorder integration, voice recording

utils/
  terminalState.ts      — Terminal instance state management
  extensionRouter.ts    — Pure function routing for provider extension events
  canvasHelpers.ts      — File change detection, path building
  notificationHelper.ts — Notification decision logic
  modelOptions.ts       — Dynamic model labels, footer quick choices, full settings choices, selection matching
  sessionSwitchHelper.ts — Session switch state computation
  resizeHelper.ts       — Canvas resize width calculation
  timer.ts              — formatDuration + useElapsed hook for live timers
  backendConfig.ts      — Backend URL/port resolution from env or window.location
  wavRecorder.ts        — Audio recording
```

## Key Design Decisions

- **Unified Timeline** — The primary data contract between backend and frontend. Messages are rendered as a sequence of discrete, chronological steps (thoughts, tool executions, text, and permissions).
- **Provider-based Branding** — All UI strings, labels, and iconography are sourced dynamically from the backend; the frontend has zero hardcoded provider names.
- **Dynamic Model Catalog + Quick Access** — The session settings Config tab shows the full provider-advertised model catalog. The chat footer keeps the provider's three `user.json` quick aliases (**Flagship**, **Balanced**, **Fast**) and adds the current model when it is outside those aliases.
- **Current Model Source of Truth** — `currentModelId` is the selected model ID used for display and active-state matching. The legacy `model` field can still hold a quick alias or raw model ID for compatibility.
- **Provider-Agnostic Routing** — Extension events and custom protocol prefixes are handled via a generic `protocolPrefix`, allowing the frontend to route provider-specific updates without implementation knowledge.
- **Singleton Socket** — Created at module level, never destroyed by React lifecycle.
- **Memoized Markdown** — Splits content on `\n\n`, caches completed blocks, only re-parses active block; stable DOM for completed messages prevents re-renders on parent update.
- **Adaptive Typewriter** — Chars per tick scales with buffer size (1 char when idle, full flush when behind).
- **Store Split** — Session CRUD, streaming, and folders are separate Zustand stores to minimize re-renders.
- **Native Windows** — Direct filesystem access, `git` used natively.
- **Canvas Pane** — Unified pane with terminal tabs, git file list, and diff viewer replacing the old standalone GitChanges component.
- **Fork Support** — Sessions can be forked from assistant messages; sidebar shows fork nesting with fork icons.

## Development

```bash
npm install
npm run dev         # Vite dev server with HMR
npx tsc -b          # TypeScript check
npx eslint src/     # 0 errors, 0 warnings
```

## Testing

```bash
npx vitest run              # 645 tests across 57 files
npx vitest run --coverage   # with coverage report
```
