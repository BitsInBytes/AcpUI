# Terminal in Canvas

Canvas terminals are session-scoped PTY tabs embedded in the canvas pane. They use dedicated `terminal_*` Socket.IO events, xterm.js on the frontend, and a backend `node-pty` map keyed by socket id plus terminal id.

This feature is easy to misread because AcpUI also has tool-step shell terminals for `ux_invoke_shell`; those use the `shell_run_*` event family and `ShellToolTerminal`, not the canvas terminal pipeline.

---

## Overview

### What It Does

- Creates per-session terminal tab records with `useCanvasStore.openTerminal`.
- Restores canvas visibility and active terminal selection when the active chat session changes.
- Mounts xterm.js for each rendered terminal and subscribes to `terminal_output` and `terminal_exit`.
- Spawns one backend PTY per socket-scoped terminal id through `terminal_spawn`.
- Forwards keyboard input, clipboard paste, and resize dimensions through `terminal_input` and `terminal_resize`.
- Kills PTYs on terminal close, PTY exit, or socket disconnect.

### Why This Matters

- Terminal state crosses three lifecycles: Zustand tab state, module-level spawn guard state, and backend PTY process state.
- UI session scoping exists only in frontend state; backend PTY keys do not include chat session ids.
- `Terminal` component unmount disposes xterm but does not kill the PTY, so cleanup must happen through explicit close, exit, or disconnect paths.
- Canvas terminals and `ux_invoke_shell` tool terminals share terminal-style UI, but their socket contracts and process ownership are different.

### Architectural Role

- Frontend state: `useCanvasStore`, `sessionSwitchHelper`, `App` active-session effect.
- Frontend UI: `ChatInput`, `CanvasPane`, `Terminal`, `SessionItem`.
- Frontend utility: `terminalState` spawned-id guard.
- Backend socket layer: `terminalHandlers`, registered from `backend/sockets/index.js`.
- Runtime: host shell process spawned through `node-pty`.

---

## How It Works - End-to-End Flow

1. The user creates a terminal tab from chat input.
   - File: `frontend/src/components/ChatInput/ChatInput.tsx` (Component: `ChatInput`, Button title: `New Terminal`)
   - File: `frontend/src/store/useCanvasStore.ts` (Store action: `openTerminal`)
   - `ChatInput` calls `openTerminal(activeSessionId || '')`. `openTerminal` creates `{ id, label, sessionId }`, labels the tab as `Terminal N` for that session, sets `activeTerminalId`, and opens the canvas.

```ts
// FILE: frontend/src/store/useCanvasStore.ts (Store action: openTerminal)
const id = `term-${Date.now()}`;
const sessionTerminals = prev.terminals.filter(t => t.sessionId === sessionId);
return { terminals: [...prev.terminals, { id, label: `Terminal ${num}`, sessionId }], activeTerminalId: id, isCanvasOpen: true };
```

2. Active-session switching restores the terminal view for that session.
   - File: `frontend/src/App.tsx` (Effect: active-session switch block)
   - File: `frontend/src/utils/sessionSwitchHelper.ts` (Function: `computeSessionSwitch`)
   - The app saves `canvasOpenBySession` for the departing session, clears active artifacts, filters `useCanvasStore.terminals` by the incoming `activeSessionId`, opens the canvas if that session has terminals, and selects the first session terminal as `activeTerminalId`.

3. `CanvasPane` filters terminal tabs and resolves the working directory.
   - File: `frontend/src/components/CanvasPane/CanvasPane.tsx` (Component: `CanvasPane`, Derived values: `sessionTerminals`, `cwd`)
   - `sessionTerminals` uses `terminal.sessionId === activeSessionId`. `cwd` comes from the active session `cwd`, then the first workspace path, then an empty string.
   - Terminal tabs and artifact tabs share the `canvas-file-tabs` strip. Selecting a file tab calls `setActiveTerminalId(null)` so the editor surface replaces the terminal surface.

4. `Terminal` initializes xterm and socket listeners on mount.
   - File: `frontend/src/components/Terminal.tsx` (Component: `Terminal`, Handlers: `handleOutput`, `handleExit`)
   - The component creates `XTerm`, loads `FitAddon` and `WebLinksAddon`, opens the xterm instance in `.git-terminal`, and registers listeners for `terminal_output` and `terminal_exit`.
   - `handleOutput` writes only when the payload `terminalId` matches `terminalIdRef.current`.

5. The frontend spawn guard emits `terminal_spawn` once per terminal id lifecycle.
   - File: `frontend/src/utils/terminalState.ts` (Functions: `hasSpawnedTerminal`, `addSpawnedTerminal`, `clearSpawnedTerminal`)
   - File: `frontend/src/components/Terminal.tsx` (Mount effect: `terminal_spawn` emit)
   - If `socket`, `cwd`, and an unspawned terminal id are present, `Terminal` marks the id spawned and emits `terminal_spawn` after a short timer. Unmount removes socket listeners and disposes xterm, but keeps the spawned-id guard intact.

6. The backend owns PTY creation and socket-scoped process identity.
   - File: `backend/sockets/index.js` (Function: `registerSocketHandlers`, Registration: `registerTerminalHandlers`)
   - File: `backend/sockets/terminalHandlers.js` (Function: `registerTerminalHandlers`, Socket event: `terminal_spawn`, Helper: `key`)
   - `terminal_spawn` builds `${socket.id}:${terminalId}`. A duplicate key kills the existing PTY before creating a replacement. The shell is `process.env.COMSPEC || 'powershell.exe'`, with initial `cols: 120`, `rows: 24`, `cwd: cwd || process.cwd()`, and `env: process.env`.

7. PTY output and exit events return to the matching frontend terminal.
   - File: `backend/sockets/terminalHandlers.js` (PTY callbacks: `term.onData`, `term.onExit`)
   - File: `frontend/src/components/Terminal.tsx` (Handlers: `handleOutput`, `handleExit`)
   - `term.onData` emits `terminal_output` with `{ terminalId, data }`. `term.onExit` deletes the backend map entry and emits `terminal_exit` with `{ terminalId, exitCode }`. Frontend exit handling writes an exit marker, clears the spawned-id guard, and calls `onExit`; `CanvasPane` wires `onExit` to `closeTerminal`.

8. User input and paste travel through `terminal_input`.
   - File: `frontend/src/components/Terminal.tsx` (xterm callback: `term.onData`, Key handler: `attachCustomKeyEventHandler`)
   - File: `backend/sockets/terminalHandlers.js` (Socket event: `terminal_input`)
   - xterm `onData` emits typed input unless the component is in the clipboard paste path. Ctrl+V reads `navigator.clipboard.readText()` and emits the pasted text explicitly. The backend writes the payload to the matching PTY with `pty.write(data)`.

9. Resize uses xterm dimensions and backend validation.
   - File: `frontend/src/components/Terminal.tsx` (Effect: visible resize block)
   - File: `backend/sockets/terminalHandlers.js` (Socket event: `terminal_resize`)
   - When a terminal becomes visible, `FitAddon.fit()` runs after a short timer and emits `{ terminalId, cols: term.cols, rows: term.rows }`. The backend calls `pty.resize(cols, rows)` only when both values are positive.

10. Close and disconnect paths release process and guard state.
    - File: `frontend/src/components/CanvasPane/CanvasPane.tsx` (Terminal tab close button, terminal tab `onAuxClick`, Terminal `onExit` prop)
    - File: `backend/sockets/terminalHandlers.js` (Socket events: `terminal_kill`, `disconnect`)
    - Tab close and middle-click emit `terminal_kill`, call `clearSpawnedTerminal(t.id)`, and call `closeTerminal(t.id)`. `terminal_kill` kills the matching PTY and deletes the backend key. `disconnect` scans the terminal map for keys beginning with the socket id and kills each matching PTY.

11. Sidebar and helper tests expose terminal ownership by session.
    - File: `frontend/src/components/SessionItem.tsx` (Derived value: `hasTerminal`)
    - File: `frontend/src/utils/sessionSwitchHelper.ts` (Function: `computeSessionSwitch`)
    - `SessionItem` shows a terminal icon when `useCanvasStore.terminals` contains a terminal for that session, unless sub-agent or fork indicators take precedence. `computeSessionSwitch` mirrors the app's session-switch terminal restoration logic for focused tests.

---

## Architecture Diagram

```mermaid
graph TB
  CI[ChatInput New Terminal button] --> CS[useCanvasStore.openTerminal]
  CS --> APP[App active-session effect]
  APP --> CP[CanvasPane sessionTerminals + cwd]
  CP --> T[Terminal component + xterm]
  T --> TS[terminalState spawned id set]
  T -->|terminal_spawn {cwd, terminalId}| TH[backend terminalHandlers]
  T -->|terminal_input {terminalId, data}| TH
  T -->|terminal_resize {terminalId, cols, rows}| TH
  CP -->|terminal_kill {terminalId}| TH
  TH --> MAP[terminals Map keyed by socketId:terminalId]
  MAP --> PTY[node-pty shell process]
  PTY -->|onData| TH
  TH -->|terminal_output {terminalId, data}| T
  PTY -->|onExit| TH
  TH -->|terminal_exit {terminalId, exitCode}| T
  TH -->|socket disconnect cleanup| PTY
  SI[SessionItem hasTerminal] --> CS
```

---

## The Critical Contract: Terminal Identity and Lifecycle

The canvas terminal contract has five parts:

1. Frontend terminal identity is `terminalId`, stored as `useCanvasStore.terminals[].id` with a `sessionId` for UI scoping.
2. Backend PTY identity is `${socket.id}:${terminalId}`, built by `key(socketId, terminalId)` in `backend/sockets/terminalHandlers.js`.
3. Every socket payload for canvas terminals includes `terminalId`; output and exit handlers ignore payloads for other terminal ids.
4. `terminal_spawn` is guarded by `terminalState` and must be paired with `clearSpawnedTerminal` on explicit close or PTY exit.
5. Session scope is a frontend rendering concern; backend PTY ownership is socket-scoped and does not receive UI session ids.

If any part is broken, the system can create duplicate shells, route output to the wrong xterm instance, hide a live PTY behind a stale guard value, or leave a PTY alive until socket disconnect.

---

## Configuration / Data Flow

Canvas terminal behavior is provider-agnostic. No provider module, model config, or ACP session metadata is required for a canvas terminal.

Runtime inputs:

- Shell executable: `process.env.COMSPEC || 'powershell.exe'` in `backend/sockets/terminalHandlers.js`.
- PTY working directory: active session `cwd`, then first workspace path, then empty string on the frontend; backend falls back to `process.cwd()` when `cwd` is empty.
- PTY dimensions: backend spawn defaults to `cols: 120` and `rows: 24`; visible terminals resize through `terminal_resize`.
- Dependencies: backend requires `node-pty`; frontend uses `@xterm/xterm`, `@xterm/addon-fit`, and `@xterm/addon-web-links`.

Socket event contract:

| Event | Direction | Payload | Handler anchor | Purpose |
|---|---|---|---|---|
| `terminal_spawn` | Frontend to backend | `{ cwd, terminalId }`, callback `{ success }` or `{ error }` | `backend/sockets/terminalHandlers.js` (`terminal_spawn`) | Create or replace the PTY for the socket-scoped terminal key |
| `terminal_output` | Backend to frontend | `{ terminalId, data }` | `frontend/src/components/Terminal.tsx` (`handleOutput`) | Write PTY output to the matching xterm instance |
| `terminal_input` | Frontend to backend | `{ terminalId, data }` | `backend/sockets/terminalHandlers.js` (`terminal_input`) | Write typed or pasted data to PTY stdin |
| `terminal_resize` | Frontend to backend | `{ terminalId, cols, rows }` | `backend/sockets/terminalHandlers.js` (`terminal_resize`) | Resize the PTY after xterm fitting |
| `terminal_kill` | Frontend to backend | `{ terminalId }` | `backend/sockets/terminalHandlers.js` (`terminal_kill`) | Kill and delete the PTY for a closed tab |
| `terminal_exit` | Backend to frontend | `{ terminalId, exitCode }` | `frontend/src/components/Terminal.tsx` (`handleExit`) | Clear frontend guard state and close the tab via `onExit` |

Tool-step shell terminal separation:

- Canvas terminals use `terminal_*` events, `frontend/src/components/Terminal.tsx`, and `backend/sockets/terminalHandlers.js`.
- Tool-step shell terminals use `shell_run_*` events, `frontend/src/components/ShellToolTerminal.tsx`, `backend/sockets/shellRunHandlers.js`, and shell-run store state.
- `frontend/src/test/ShellToolTerminal.test.tsx` includes coverage that shell tool terminals do not emit `terminal_spawn`.

---

## Data Flow / Rendering Pipeline

### Terminal Tab State

```ts
// FILE: frontend/src/store/useCanvasStore.ts (Store state: terminals)
terminals: { id: string; label: string; sessionId: string }[];
activeTerminalId: string | null;
```

### Spawn Request

```ts
// FILE: frontend/src/components/Terminal.tsx (Mount effect: terminal_spawn)
if (socket && cwd && !hasSpawnedTerminal(terminalId)) {
  addSpawnedTerminal(terminalId);
  socket.emit('terminal_spawn', { cwd, terminalId }, callback);
}
```

### Backend PTY Registration

```js
// FILE: backend/sockets/terminalHandlers.js (Socket event: terminal_spawn)
const k = key(socket.id, terminalId);
const term = pty.spawn(shell, [], { name: 'xterm-256color', cols: 120, rows: 24, cwd: cwd || process.cwd(), env: process.env });
terminals.set(k, { pty: term, cwd });
```

### Output Rendering

```js
// FILE: backend/sockets/terminalHandlers.js (PTY callback: term.onData)
term.onData((data) => socket.emit('terminal_output', { terminalId, data }));
```

```ts
// FILE: frontend/src/components/Terminal.tsx (Handler: handleOutput)
if (msg.terminalId === terminalIdRef.current) xtermRef.current?.write(msg.data);
```

### Close Path

```tsx
// FILE: frontend/src/components/CanvasPane/CanvasPane.tsx (Terminal tab close handler)
socket?.emit('terminal_kill', { terminalId: t.id });
clearSpawnedTerminal(t.id);
closeTerminal(t.id);
```

---

## Component Reference

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Frontend entry | `frontend/src/components/ChatInput/ChatInput.tsx` | `ChatInput`, `New Terminal`, `openTerminal` | Creates terminal tabs from the input footer |
| Frontend store | `frontend/src/store/useCanvasStore.ts` | `openTerminal`, `closeTerminal`, `setActiveTerminalId`, `resetCanvas`, `terminals`, `activeTerminalId` | Owns tab records, active terminal id, and canvas open state |
| Frontend session switch | `frontend/src/App.tsx` | active-session switch effect, `canvasOpenBySession`, `sessionTerminals`, `setActiveTerminalId` | Restores terminal visibility and active tab when sessions change |
| Frontend helper | `frontend/src/utils/sessionSwitchHelper.ts` | `computeSessionSwitch` | Pure session-switch calculation covered by focused tests |
| Frontend pane | `frontend/src/components/CanvasPane/CanvasPane.tsx` | `CanvasPane`, `sessionTerminals`, `cwd`, terminal tab close handlers, `Terminal` render map | Renders session-scoped terminal tabs, selects tabs, and sends terminal kill events |
| Frontend terminal | `frontend/src/components/Terminal.tsx` | `Terminal`, `handleOutput`, `handleExit`, `terminal_spawn`, `terminal_input`, `terminal_resize` | xterm setup, socket subscriptions, input, paste, resize, spawn, and exit handling |
| Frontend guard | `frontend/src/utils/terminalState.ts` | `addSpawnedTerminal`, `hasSpawnedTerminal`, `clearSpawnedTerminal` | Module-level spawn guard by terminal id |
| Frontend sidebar | `frontend/src/components/SessionItem.tsx` | `SessionItem`, `hasTerminal` | Shows session terminal presence in sidebar icon selection |
| Backend registry | `backend/sockets/index.js` | `registerSocketHandlers`, `registerTerminalHandlers` | Registers terminal socket handlers for each Socket.IO connection |
| Backend socket | `backend/sockets/terminalHandlers.js` | `registerTerminalHandlers`, `key`, `terminal_spawn`, `terminal_input`, `terminal_resize`, `terminal_kill`, `disconnect` | Owns PTY map, process spawn, input, resize, kill, exit, and socket cleanup |
| Related shell UI | `frontend/src/components/ShellToolTerminal.tsx` | `ShellToolTerminal`, `shell_run_input`, `shell_run_resize`, `shell_run_kill` | Tool-step terminal renderer using a different event family |
| Related shell backend | `backend/sockets/shellRunHandlers.js` | `registerShellRunHandlers`, `shell_run_input`, `shell_run_resize`, `shell_run_kill` | Tool-step shell run control channel |
| Backend tests | `backend/test/terminalHandlers.test.js` | suite `Terminal Handlers` | Verifies PTY spawn, input, resize, kill, disconnect, and multi-terminal behavior |
| Frontend tests | `frontend/src/test/Terminal.test.tsx` | suite `Terminal` | Verifies visibility rendering and `terminal_spawn` emit |
| Frontend tests | `frontend/src/test/terminalState.test.ts` | suite `terminalState` | Verifies spawned-id add, check, clear, and independent ids |
| Frontend tests | `frontend/src/test/useCanvasStore.test.ts` | `openTerminal adds a terminal and sets it as active`, `closeTerminal handles termination and active switch` | Verifies store-level terminal lifecycle |
| Frontend tests | `frontend/src/test/CanvasPane.test.tsx` | suites `CanvasPane - Terminal Tab`, `CanvasPane - multiple terminals and tab interactions` | Verifies session-scoped tabs, selection, and close events |
| Frontend tests | `frontend/src/test/sessionSwitchHelper.test.ts` | suite `computeSessionSwitch` | Verifies terminal-driven canvas restore and active terminal selection |
| Frontend tests | `frontend/src/test/SessionItem.test.tsx` | suite `SessionItem - terminal icon` | Verifies sidebar terminal icon precedence |
| Related shell tests | `frontend/src/test/ShellToolTerminal.test.tsx` | suite `ShellToolTerminal` | Verifies shell-run terminals stay on `shell_run_*` events |

---

## Gotchas & Important Notes

1. Spawn guard is module-scoped memory.
   - `terminalState` tracks spawned ids outside React. Explicit close and PTY exit must call `clearSpawnedTerminal`, or a terminal id can be blocked from spawning again.

2. Unmount is not process cleanup.
   - `Terminal` cleanup removes listeners and disposes xterm. It does not emit `terminal_kill`; PTY cleanup belongs to close, exit, or disconnect paths.

3. Backend identity is socket-scoped.
   - The same `terminalId` in another browser socket maps to a different PTY because the key includes `socket.id`.

4. UI session scope is frontend-only.
   - Backend terminal handlers receive `terminalId` and `cwd`, not UI session id. Session filtering must stay in `CanvasPane`, `App`, and store logic.

5. Duplicate spawn replaces the backend PTY.
   - A repeated `terminal_spawn` for the same socket key kills the existing PTY before spawning another one. The frontend guard exists to avoid accidental replacement.

6. Resize ignores invalid dimensions.
   - `terminal_resize` only calls `pty.resize` when `cols > 0` and `rows > 0`. Invisible or unfitted xterm instances should not drive backend dimensions.

7. Ctrl+V has a custom path.
   - `attachCustomKeyEventHandler` reads the browser clipboard and emits pasted text. The `isPasting` flag suppresses duplicate `terminal_input` from xterm `onData`.

8. Active terminal selection can point outside the rendered session if session-switch logic drifts.
   - `App` and `computeSessionSwitch` both filter by session id and pick the first matching terminal. Keep them aligned when changing session switching.

9. Sidebar icon precedence matters.
   - `SessionItem` uses terminal presence only when sub-agent and fork indicators do not take precedence.

10. Canvas terminals do not use shell-run state.
    - Do not connect canvas terminal lifecycle to `useShellRunStore`, `ShellToolTerminal`, or `shell_run_*` handlers.

---

## Unit Tests

### Backend

- `backend/test/terminalHandlers.test.js`
  - `creates a PTY and calls callback with success`
  - `kills existing terminal before creating new one with same id`
  - `handles spawn errors gracefully`
  - `writes data to the PTY`
  - `does nothing if no terminal exists`
  - `resizes the PTY`
  - `ignores invalid dimensions (0 or negative)`
  - `kills the PTY and removes from map`
  - `cleans up the PTY`
  - `multiple terminals can coexist for the same socket`
  - `killing one terminal does not affect another`
  - `disconnect cleans up all terminals for that socket`

### Frontend

- `frontend/src/test/Terminal.test.tsx`
  - `renders container div when visible`
  - `hides container when not visible`
  - `calls socket.emit terminal_spawn on mount`

- `frontend/src/test/terminalState.test.ts`
  - `hasSpawnedTerminal returns false for unknown id`
  - `addSpawnedTerminal marks terminal as spawned`
  - `clearSpawnedTerminal removes terminal`
  - `clearSpawnedTerminal on unknown id does not throw`
  - `multiple terminals tracked independently`

- `frontend/src/test/useCanvasStore.test.ts`
  - `openTerminal adds a terminal and sets it as active`
  - `closeTerminal handles termination and active switch`
  - `resetCanvas clears artifacts and closes canvas`

- `frontend/src/test/CanvasPane.test.tsx`
  - `renders terminal tab when terminals array has entries`
  - `does NOT render terminal tab when terminals array is empty`
  - `clicking a file tab calls setActiveTerminalId(null)`
  - `renders multiple terminal tabs when multiple terminals in store for active session`
  - `clicking a terminal tab calls setActiveTerminalId`
  - `close button on terminal tab calls closeTerminal`

- `frontend/src/test/sessionSwitchHelper.test.ts`
  - `sets activeTerminalId from session terminals`
  - `canvas stays open when terminals exist even if not saved as open`

- `frontend/src/test/SessionItem.test.tsx`
  - `shows Terminal icon when session has a terminal in canvas store`
  - `shows MessageSquare icon when session has no terminal and no fork`
  - `fork icon takes priority over terminal icon when session has both forkedFrom and a terminal`

- `frontend/src/test/ShellToolTerminal.test.tsx`
  - Uses `shell_run_*` assertions for tool-step terminals and includes coverage that `terminal_spawn` is not used by shell-run rendering.

---

## How to Use This Guide

### For implementing/extending this feature

1. Start with the intended event family: canvas terminal changes belong to `terminal_*`; tool-step shell changes belong to `shell_run_*`.
2. Keep identity stable: frontend terminal id in `useCanvasStore.terminals[].id`, backend key from `key(socket.id, terminalId)`.
3. Update close and exit paths together: `CanvasPane` close handlers, `Terminal.handleExit`, `terminalState`, and `terminalHandlers` process deletion.
4. Check session switching in `App` and `computeSessionSwitch` when changing `terminals`, `activeTerminalId`, or `canvasOpenBySession` behavior.
5. Add or update backend tests in `backend/test/terminalHandlers.test.js` for socket/PTY behavior.
6. Add or update frontend tests in `Terminal.test.tsx`, `terminalState.test.ts`, `useCanvasStore.test.ts`, `CanvasPane.test.tsx`, and `sessionSwitchHelper.test.ts` for UI lifecycle behavior.

### For debugging issues with this feature

1. Trace the socket sequence: `terminal_spawn`, `terminal_output`, `terminal_input`, `terminal_resize`, `terminal_kill`, `terminal_exit`.
2. Inspect `useCanvasStore.terminals`, `activeTerminalId`, and active session id before checking backend state.
3. Check `hasSpawnedTerminal(id)` when a tab renders but no backend spawn happens.
4. Verify `cwd` resolution in `CanvasPane` before diagnosing shell startup failures.
5. Reproduce with two terminal tabs in one browser socket to test terminal-id routing.
6. Reproduce with two browser sockets to test socket-id scoping.
7. Compare against `ShellToolTerminal` only to rule out event-family confusion; do not share state between the two systems.

---

## Summary

- Canvas terminals are frontend session-scoped tabs backed by socket-scoped PTY processes.
- `useCanvasStore` owns tab records and active terminal selection.
- `App` and `sessionSwitchHelper` restore canvas and terminal selection when chat sessions change.
- `Terminal` owns xterm setup, output filtering, input forwarding, paste handling, spawn emit, and resize emit.
- `terminalState` prevents accidental duplicate `terminal_spawn` for a terminal id.
- `backend/sockets/terminalHandlers.js` owns the PTY map and all `terminal_*` socket events.
- Cleanup requires backend PTY deletion and frontend spawned-id cleanup.
- Canvas terminals are independent from `ux_invoke_shell` tool-step shell terminals.
- Tests cover PTY lifecycle, socket event behavior, store lifecycle, session-switch restoration, tab UX, and sidebar terminal indicators.