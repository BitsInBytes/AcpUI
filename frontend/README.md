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
    ModelSelector.tsx   — Footer model display with provider-defined quick-access choices
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
  useSocket.ts          — Singleton socket, provider_extension handling, session_model_options, branding handler, custom_commands handler, provider status, compaction
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

- **Unified Timeline** — Discrete, chronological rendering of thoughts, tool executions, text, and permissions for a high-fidelity agent experience.
- **Multi-Provider "Stack"** — Sidebar groups sessions by AI provider (Claude, Gemini, etc.), allowing concurrent interaction with multiple agent identities.
- **Live Provider Status** — Real-time monitoring of quotas, spend, and health metrics via provider-emitted status contracts.
- **Adaptive Typewriter** — High-performance rendering pipeline that character-scales to clear large buffers without dropping frames.
- **Hot-Resume Navigation** — Instant session switching for memory-resident chats, bypassing redundant network "warm-up" phases.
- **Provider-based Branding** — Zero hardcoded identity; all UI strings, icons, and themes are sourced dynamically from the active backend provider.
- **Current Model Source of Truth** — `currentModelId` is the selected model ID used for display and active-state matching.
- **Singleton Socket** — Created at module level, never destroyed by React lifecycle.
- **Memoized Markdown** — Splits content on `\n\n`, caches completed blocks, only re-parses active block; stable DOM for completed messages prevents re-renders on parent update.
- **Store Split** — Session CRUD, streaming, and folders are separate Zustand stores to minimize re-renders.
- **Native Windows** — Direct filesystem access, `git` used natively.
- **Canvas Pane** — Unified pane with terminal tabs, git file list, and diff viewer (SafeDiffEditor).
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
npx vitest run              # 736 tests across 64 files
npx vitest run --coverage   # with coverage report
```
