# Terminal in Canvas

Terminals are session-scoped pseudo-terminal (PTY) instances hosted as tabs inside the canvas pane. They are independent of file artifacts and provide a native shell experience with output streaming, input handling, and resize support.

---

## Overview

### What It Does

- **PTY Spawning** — Creates native shell processes (PowerShell on Windows) via `node-pty` on demand, keyed by socket ID and terminal ID.
- **Live Output Streaming** — PTY stdout/stderr is emitted as `terminal_output` Socket.IO events and rendered in xterm.js in real-time.
- **Input Handling** — Keyboard input and clipboard pastes (Ctrl+V) are captured from xterm and sent to the PTY via `terminal_input` events.
- **Terminal Resizing** — Canvas resize or tab switch triggers `terminal_resize` events with actual cols/rows, sent to backend to resize the PTY.
- **Session Scoping** — Each terminal belongs to a specific session (`sessionId` in the terminal object); switching sessions hides non-matching terminals.
- **Spawn-Once Guarantee** — Module-level `spawnedTerminals` Set prevents re-spawning on React component remounts while preserving the PTY connection.
- **Graceful Cleanup** — Terminals are killed explicitly via `terminal_kill` or on socket disconnect; no orphaned PTY processes.

### Why This Matters

- **Persistence Across UI Changes** — PTY survives xterm.js unmount, allowing switching between terminals without losing connection.
- **Session Isolation** — Terminals are tied to sessions; forking a session doesn't inherit parent's terminals (each has its own set).
- **Real-time Shell Interaction** — Full duplex socket communication ensures minimal latency between key press and shell response.
- **xterm.js Integration** — Uses well-tested terminal emulation library with proper ANSI color, scrollback, and keyboard handling.
- **Stateful Keybindings** — Ctrl+V is intercepted for system clipboard paste, a critical feature on Windows where shell paste may not work.

---

## How It Works — End-to-End Flow

### Step 1: User Opens Terminal

User clicks the Terminal pill in ChatInput → `openTerminal(activeSessionId)` is called (frontend/src/components/ChatInput/ChatInput.tsx Line 281).

```typescript
// FILE: frontend/src/store/useCanvasStore.ts (Lines 43-48)
openTerminal: (sessionId) => set(prev => {
  const id = `term-${Date.now()}`;
  const sessionTerminals = prev.terminals.filter(t => t.sessionId === sessionId);
  const num = sessionTerminals.length + 1;
  return { 
    terminals: [...prev.terminals, { id, label: `Terminal ${num}`, sessionId }], 
    activeTerminalId: id, 
    isCanvasOpen: true 
  };
})
```

A new terminal object is added with a unique id and auto-numbered label (Terminal 1, Terminal 2, etc.).

### Step 2: Canvas Opens & Terminal Tab Renders

isCanvasOpen is set to true; CanvasPane mounts and renders terminal tabs from the store's terminals array (CanvasPane.tsx Lines 199-217).

```typescript
// FILE: frontend/src/components/CanvasPane/CanvasPane.tsx (Lines 199-217)
{sessionTerminals.map(t => (
  <div
    key={t.id}
    className={`canvas-file-tab terminal-tab ${activeTerminalId === t.id ? 'active' : ''}`}
    onClick={() => setActiveTerminalId(t.id)}
    title={t.label}
  >
    <TerminalSquare size={14} className="file-icon" />
    <span className="file-name">{t.label}</span>
    {/* close button */}
  </div>
))}
```

The Terminal.tsx component is rendered for each session-scoped terminal (Line 272).

### Step 3: Terminal Component Mounts

Terminal.tsx useEffect (Lines 37-95) initializes xterm.js:

```typescript
// FILE: frontend/src/components/Terminal.tsx (Lines 37-95)
const term = new XTerm({
  fontSize: 13,
  fontFamily: "'Cascadia Code', 'Fira Code', Consolas, monospace",
  theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#58a6ff', selectionBackground: '#264f78' },
  cursorBlink: true,
  scrollback: 5000,
});

const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new WebLinksAddon());
term.open(containerRef.current);
xtermRef.current = term;
fitRef.current = fit;
```

xterm is configured with dark theme, 13pt font, and 5000-line scrollback. FitAddon allows dynamic resizing.

### Step 4: Spawn Guard Check

Before spawning, the component checks if the terminal has already been spawned (Lines 76-82):

```typescript
// FILE: frontend/src/components/Terminal.tsx (Lines 76-82)
if (socket && cwd && !hasSpawnedTerminal(terminalId)) {
  addSpawnedTerminal(terminalId);
  setTimeout(() => {
    socket.emit('terminal_spawn', { cwd, terminalId }, (res: { error?: string }) => {
      if (res?.error) term.writeln(`\x1b[31mFailed to start terminal: ${res.error}\x1b[0m`);
    });
  }, 100);
}
```

The `spawnedTerminals` Set is checked; if not spawned, we add the id and emit `terminal_spawn` with a 100ms delay. This guard persists across remounts.

### Step 5: Backend Spawns PTY

Backend terminalHandlers receives `terminal_spawn`:

```javascript
// FILE: backend/sockets/terminalHandlers.js (Lines 9-38)
socket.on('terminal_spawn', ({ cwd, terminalId }, callback) => {
  try {
    const k = key(socket.id, terminalId);
    const existing = terminals.get(k);
    if (existing) { existing.pty.kill(); terminals.delete(k); }

    const shell = process.env.COMSPEC || 'powershell.exe';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 120,
      rows: 24,
      cwd: cwd || process.cwd(),
      env: process.env,
    });

    term.onData((data) => socket.emit('terminal_output', { terminalId, data }));
    term.onExit(({ exitCode }) => {
      writeLog(`[TERM] Shell ${terminalId} exited (code ${exitCode})`);
      terminals.delete(k);
      socket.emit('terminal_exit', { terminalId, exitCode });
    });

    terminals.set(k, { pty: term, cwd });
    callback?.({ success: true });
  } catch (err) {
    callback?.({ error: err.message });
  }
});
```

The key is `${socket.id}:${terminalId}`. If a PTY already exists with that key, it's killed and replaced. The PTY is stored in a module-level Map and persists for the lifetime of the socket.

### Step 6: PTY Output Streams

As the user types or the shell produces output, the PTY emits data:

```javascript
term.onData((data) => socket.emit('terminal_output', { terminalId, data }));
```

Each chunk is sent via Socket.IO to the frontend as `terminal_output` with the terminalId.

### Step 7: Frontend Receives Output

Terminal.tsx listens for `terminal_output` (Lines 24-26, 72):

```typescript
const handleOutput = useCallback((msg: { terminalId: string; data: string }) => {
  if (msg.terminalId === terminalIdRef.current) xtermRef.current?.write(msg.data);
}, []);

socket?.on('terminal_output', handleOutput);
```

The data is written directly to xterm, which renders it to the DOM in real-time.

### Step 8: User Input

xterm captures keyboard input and clipboard (Lines 56-70):

```typescript
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
    isPasting = true;
    navigator.clipboard.readText().then(text => {
      if (text) socket?.emit('terminal_input', { terminalId, data: text });
      isPasting = false;
    });
    return false;  // Prevent default
  }
  return true;
});

term.onData((data) => {
  if (!isPasting) socket?.emit('terminal_input', { terminalId, data });
});
```

Regular keystrokes emit `terminal_input`; Ctrl+V is intercepted to paste from system clipboard. The `isPasting` flag prevents double-sending clipboard data.

### Step 9: Backend Receives Input

Backend terminal_input handler writes to the PTY:

```javascript
// FILE: backend/sockets/terminalHandlers.js (Lines 40-42)
socket.on('terminal_input', ({ terminalId, data }) => {
  terminals.get(key(socket.id, terminalId))?.pty.write(data);
});
```

Data is written directly to the PTY's stdin.

### Step 10: Resize on Visibility Change

When a terminal tab becomes visible, xterm.FitAddon recalculates dimensions (Lines 98-106):

```typescript
useEffect(() => {
  if (visible && fitRef.current) {
    setTimeout(() => {
      fitRef.current?.fit();
      const term = xtermRef.current;
      if (term && socket) socket.emit('terminal_resize', { terminalId, cols: term.cols, rows: term.rows });
    }, 50);
  }
}, [visible, socket, terminalId]);
```

FitAddon.fit() calculates cols/rows based on container size; then `terminal_resize` is emitted. Backend validates and resizes:

```javascript
// FILE: backend/sockets/terminalHandlers.js (Lines 44-47)
socket.on('terminal_resize', ({ terminalId, cols, rows }) => {
  const t = terminals.get(key(socket.id, terminalId));
  if (t && cols > 0 && rows > 0) t.pty.resize(cols, rows);
});
```

If cols/rows are invalid (≤0), the resize is silently ignored.

---

## Architecture Diagram

```mermaid
graph TB
  subgraph "User Interface"
    ChatInput["ChatInput<br/>(Terminal button)"]
    CanvasPane["CanvasPane<br/>(Terminal tabs)"]
  end

  subgraph "Frontend State & Component"
    CanvasStore["useCanvasStore<br/>(terminals[], activeTerminalId)"]
    TerminalComponent["Terminal.tsx<br/>(xterm.js + FitAddon)"]
    TerminalState["terminalState.ts<br/>(spawnedTerminals Set)"]
  end

  subgraph "Socket.IO Communication"
    TerminalSpawn["terminal_spawn<br/>{cwd, terminalId}"]
    TerminalInput["terminal_input<br/>{terminalId, data}"]
    TerminalOutput["terminal_output<br/>{terminalId, data}"]
    TerminalResize["terminal_resize<br/>{terminalId, cols, rows}"]
    TerminalKill["terminal_kill<br/>{terminalId}"]
    TerminalExit["terminal_exit<br/>{terminalId, exitCode}"]
  end

  subgraph "Backend PTY Management"
    TerminalHandlers["terminalHandlers.js<br/>(registerTerminalHandlers)"]
    PTYMap["Module-level Map<br/>key: socketId:terminalId"]
    NodePTY["node-pty<br/>(spawn PTY process)"]
  end

  subgraph "Shell Process"
    Shell["PowerShell / Shell<br/>(actual process)"]
  end

  ChatInput -->|openTerminal| CanvasStore
  CanvasStore -->|terminals[]| CanvasPane
  CanvasPane -->|render| TerminalComponent
  TerminalComponent -->|spawn guard| TerminalState
  TerminalComponent -->|emit/on| TerminalSpawn
  TerminalComponent -->|emit| TerminalInput
  TerminalComponent -->|emit| TerminalResize
  TerminalComponent -->|emit| TerminalKill
  TerminalComponent -->|on| TerminalOutput
  TerminalComponent -->|on| TerminalExit
  TerminalSpawn -->|handler| TerminalHandlers
  TerminalHandlers -->|create/kill| PTYMap
  PTYMap -->|spawn/write/resize| NodePTY
  NodePTY -->|start/input/stdout| Shell

  style ChatInput fill:#e1f5ff
  style TerminalComponent fill:#f3e5f5
  style Shell fill:#fff9c4
```

---

## The Critical Contract: Terminal Lifecycle

Every terminal must follow this lifecycle:

1. **Creation** — Unique id generated as `term-${Date.now()}`, stored in `terminals[]` with `sessionId`.
2. **Spawn Once** — `hasSpawnedTerminal(id)` prevents re-spawning on React remounts; `addSpawnedTerminal(id)` locks it.
3. **Live Connection** — Socket.IO messages (`terminal_input`, `terminal_output`, `terminal_resize`) flow bidirectionally.
4. **PTY Persistence** — PTY stays alive even if xterm.js is unmounted; xterm is disposed but PTY is NOT killed.
5. **Explicit Kill** — PTY is killed only on `terminal_kill` event or socket `disconnect`.
6. **Cleanup** — `clearSpawnedTerminal(id)` must be called before closing to allow re-spawn of a new terminal with the same id.

### Backend Key Contract

Terminals are keyed in the backend Map as:

```javascript
const key = `${socketId}:${terminalId}`;
```

This dual-key ensures:
- Multiple terminals can coexist for one socket (different terminalIds).
- Same terminalId can exist for different sockets (different socketIds).
- On socket disconnect, all terminals matching `socket.id + ':'` are killed.

---

## Session Scoping & Multi-Terminal

### Multiple Terminals Per Session

A session can have multiple terminals. Each is auto-numbered by session:

```typescript
// FILE: frontend/src/store/useCanvasStore.ts (Lines 43-48)
const sessionTerminals = prev.terminals.filter(t => t.sessionId === sessionId);
const num = sessionTerminals.length + 1;
// Label becomes "Terminal 1", "Terminal 2", etc.
```

### Session Switch Behavior

When switching sessions (App.tsx Lines 116-126):

```typescript
const { canvasOpenBySession, terminals } = useCanvasStore.getState();
const sessionTerminals = terminals.filter(t => t.sessionId === activeSessionId);
const savedOpen = canvasOpenBySession[activeSessionId || ''] ?? false;
setActiveCanvasArtifact(null);
setCanvasArtifacts([]);
setIsCanvasOpen(savedOpen || sessionTerminals.length > 0);  // Keep canvas open if terminals exist
if (sessionTerminals.length > 0) {
  useCanvasStore.setState({ activeTerminalId: sessionTerminals[0].id });
}
```

- **Terminals persist in store** (not cleared on switch).
- **Only matching terminals render** in CanvasPane (session-scoped filter).
- **Canvas stays open** if the new session has terminals.
- **Active terminal auto-switches** to the first terminal of the new session (if any).

### No Terminal Inheritance on Fork

If a session is forked, the fork starts with no terminals (fresh set). Forking clones only the message history, not the terminal instances.

---

## Resize Behavior & Dimensions

### Initial Dimensions

Backend spawns PTY with hardcoded dimensions (terminalHandlers.js Lines 18-19):

```javascript
cols: 120,
rows: 24,
```

### Dynamic Resize

When a terminal tab becomes visible or the canvas is resized:

1. **FitAddon.fit()** calculates cols/rows based on container size (xterm's calculated dimensions).
2. **terminal_resize** event is emitted with actual cols/rows.
3. **Backend validates** dims — rejects if cols ≤ 0 or rows ≤ 0.
4. **PTY is resized** via `pty.resize(cols, rows)`.

**Note:** The frontend must emit cols/rows that match xterm's internal cols/rows. If there's a mismatch, the shell output may wrap at wrong positions.

---

## Keyboard & Input Handling

### Ctrl+V Clipboard Paste

Intercepted at the custom key handler level (Terminal.tsx Lines 56-66):

```typescript
term.attachCustomKeyEventHandler((e) => {
  if (e.type === 'keydown' && e.ctrlKey && e.key === 'v') {
    isPasting = true;
    navigator.clipboard.readText().then(text => {
      if (text) socket?.emit('terminal_input', { terminalId, data: text });
      isPasting = false;
    });
    return false;  // Consume event, don't forward to xterm
  }
  return true;  // Forward other events to xterm
});
```

- **Why intercept?** On Windows, the shell may not have native clipboard access; browser clipboard API is more reliable.
- **isPasting flag** prevents the clipboard text from being sent twice (once via handler, once via xterm.onData).

### Regular Keyboard Input

All other keypresses are captured by xterm.onData and emitted as `terminal_input`:

```typescript
term.onData((data) => {
  if (!isPasting) socket?.emit('terminal_input', { terminalId, data });
});
```

---

## Connection Handling & Cleanup

### Socket Disconnect

When the socket disconnects (terminalHandlers.js Lines 55-59):

```javascript
socket.on('disconnect', () => {
  for (const [k, t] of terminals) {
    if (k.startsWith(socket.id + ':')) { 
      t.pty.kill(); 
      terminals.delete(k); 
    }
  }
});
```

All PTYs belonging to that socket are killed. This prevents orphaned processes.

### Terminal Kill

Explicit terminal_kill event (Lines 49-53):

```javascript
socket.on('terminal_kill', ({ terminalId }) => {
  const k = key(socket.id, terminalId);
  const t = terminals.get(k);
  if (t) { t.pty.kill(); terminals.delete(k); }
});
```

Kills the specific PTY and removes it from the Map.

### Frontend Cleanup

When Terminal.tsx unmounts (Lines 85-93):

```typescript
return () => {
  socket?.off('terminal_output', handleOutput);
  socket?.off('terminal_exit', handleExit);
  // Don't kill PTY — it persists for reconnection
  term.dispose();
  xtermRef.current = null;
  fitRef.current = null;
};
```

xterm is disposed (DOM cleanup) but the PTY is NOT killed. If the component remounts (e.g., tab switch), the PTY is still alive and can be connected.

---

## Gotchas & Important Notes

1. **spawnedTerminals Set is Module-Level**
   - **What:** The `spawnedTerminals` Set is declared at module scope in terminalState.ts and persists across React lifecycle.
   - **Why:** React unmounts and remounts components; if we lost the spawn guard, we'd respawn the PTY on every tab visibility toggle.
   - **Gotcha:** The Set grows unbounded if terminals are created but never cleaned up. Always call `clearSpawnedTerminal` on close.

2. **PTY Survives Component Unmount**
   - **What:** When Terminal.tsx unmounts, xterm is disposed but the backend PTY is NOT killed.
   - **Why:** This allows switching between tabs without losing the shell session; xterm reconnects to the same PTY on remount.
   - **Gotcha:** If a component crashes before calling the cleanup function, the PTY may persist orphaned. Socket disconnect is the ultimate cleanup.

3. **Socket Listeners Are Cleaned Up, PTY Is Not**
   - **What:** Terminal.tsx removes socket.on('terminal_output') and socket.on('terminal_exit') listeners on unmount.
   - **Why:** Prevents stale listeners from accumulating.
   - **Gotcha:** If xterm is unmounted but PTY is still running, the PTY will emit data but the frontend won't hear it. Re-mount the component to reconnect listeners.

4. **Backend Key Combines socketId + terminalId**
   - **What:** The backend stores PTYs in a Map with key = `${socket.id}:${terminalId}`.
   - **Why:** Allows multiple terminals per socket; terminal ids are only unique within a socket session.
   - **Gotcha:** If the socket reconnects with a new socket.id, the old PTY becomes unreachable (orphaned). The old socket's disconnect handler will kill it.

5. **clearSpawnedTerminal Must Be Called Before closeTerminal**
   - **What:** Closing a terminal must call `clearSpawnedTerminal(id)` before `closeTerminal(id)`.
   - **Why:** The Set retains the id; if a new terminal is created with the same id, it won't re-spawn without clearing first.
   - **Gotcha:** Code paths (like auto-close on socket disconnect) must call both in the correct order or re-spawning new terminals will be blocked.

6. **100ms setTimeout Before terminal_spawn**
   - **What:** There's a deliberate 100ms delay before emitting terminal_spawn (Terminal.tsx Line 78).
   - **Why:** Gives xterm time to initialize and attach event handlers before the PTY starts emitting data.
   - **Gotcha:** Removing this delay can cause early PTY output to be lost or cause race conditions.

7. **Backend terminal_spawn Kills Existing PTY**
   - **What:** If a terminal_spawn event arrives for a key that already exists, the old PTY is killed first.
   - **Why:** Prevents double-spawning the same terminal on accidental double-clicks or reconnects.
   - **Gotcha:** This means spamming terminal_spawn for the same terminalId will kill and restart the shell repeatedly.

8. **Resize Events with Invalid Dimensions Are Silently Ignored**
   - **What:** If cols ≤ 0 or rows ≤ 0, backend silently ignores the resize.
   - **Why:** Prevents crashing the PTY with invalid dimensions.
   - **Gotcha:** If the frontend detects but the backend rejects due to invalid dims, the terminal will appear sized differently in the frontend vs backend (shell will wrap at a different col count).

9. **No Cross-Browser PTY Sharing**
   - **What:** Each browser tab has its own socket; PTYs are not shared between tabs.
   - **Why:** Socket.IO creates one connection per page; server-side, each socket has its own terminal Map.
   - **Gotcha:** Opening the same AcpUI URL in two tabs will create separate shell instances.

10. **Scroll Back Limit is 5000 Lines**
    - **What:** xterm is initialized with scrollback: 5000 (Terminal.tsx Line 45).
    - **Why:** Limits memory usage; very long sessions will lose older output.
    - **Gotcha:** Users cannot scroll back beyond 5000 lines. Consider increasing if this becomes a UX issue.

---

## Unit Tests

### Backend Tests

- **File:** `backend/test/terminalHandlers.test.js`
  - `terminal_spawn creates a PTY and calls callback with success` — Verifies pty.spawn is called with correct args (Line ~44)
  - `terminal_spawn kills existing terminal before creating new one with same id` — Verifies pty.kill on duplicate id (Line ~52)
  - `terminal_spawn handles spawn errors gracefully` — Verifies error callback (Line ~60)
  - `terminal_input writes data to the PTY` — Verifies pty.write is called (Line ~68)
  - `terminal_input does nothing if no terminal exists` — Verifies safe no-op (Line ~75)
  - `terminal_resize resizes the PTY` — Verifies pty.resize is called (Line ~82)
  - `terminal_resize ignores invalid dimensions (0 or negative)` — Verifies validation (Line ~88)
  - `terminal_kill kills the PTY and removes from map` — Verifies pty.kill and map deletion (Line ~96)
  - `disconnect kills all PTYs for that socket` — Verifies cleanup on disconnect (Line ~102)

### Frontend Tests

- **File:** `frontend/src/test/terminalState.test.ts`
  - `addSpawnedTerminal adds id to Set` — Verifies Set.add (Line ~5)
  - `hasSpawnedTerminal returns true after adding` — Verifies Set.has (Line ~10)
  - `clearSpawnedTerminal removes id from Set` — Verifies Set.delete (Line ~15)

- **File:** `frontend/src/test/useCanvasStore.test.ts` (Terminal-related tests)
  - `openTerminal adds new terminal with auto-numbered label` — Verifies terminal creation (Line ~110+)
  - `closeTerminal removes terminal and adjusts activeTerminalId` — Verifies cleanup (Line ~120+)
  - `closeTerminal keeps canvas open if artifacts remain` — Verifies canvas visibility logic (Line ~130+)

---

## How to Use This Guide

### For Implementing Terminal Features

1. **Study the lifecycle** — Understand that terminals are spawned once, persist across remounts, and are killed explicitly.
2. **Reference the 10-step flow** — Trace a complete terminal interaction (spawn → output → input → resize → kill).
3. **Check the gotchas** — Before making changes (e.g., removing the 100ms delay), read why it's there.
4. **Write tests** — Add tests to the files listed above; verify spawn, input, output, resize, and cleanup behaviors.
5. **Test multi-terminal scenarios** — Ensure multiple terminals can coexist, be renamed, switched, and killed independently.
6. **Test session switching** — Verify terminals persist across session switches and are filtered correctly.

### For Debugging Terminal Issues

1. **Check logs** — Look for `[TERM]` entries in the backend log (LOG_FILE_PATH).
2. **Inspect store** — Use React DevTools to check useCanvasStore.terminals, spawnedTerminals, activeTerminalId.
3. **Inspect backend Map** — Add logging to terminalHandlers.js to print the terminals Map when events arrive.
4. **Socket inspection** — Use browser DevTools Network tab to watch `terminal_spawn`, `terminal_input`, `terminal_output`, `terminal_resize` events.
5. **xterm inspection** — Use browser console to inspect the xterm instance: `window.lastXterm = xtermRef.current` (add to Terminal.tsx), then `window.lastXterm.cols`, `window.lastXterm.rows`, `window.lastXterm.buffer.lines`.
6. **PTY process inspection** — On Windows, use `Get-Process | grep powershell` or Task Manager to verify PTY processes are actually spawned.
7. **Orphan process cleanup** — If tests leak PTY processes, manually kill them: `taskkill /F /IM powershell.exe` (Windows).

---

## Summary

The terminal system provides in-browser PTY access alongside the chat interface:

- **Session-scoped** — Each session has its own set of terminals; switching sessions shows only matching terminals.
- **Spawn-once guarantee** — Module-level Set prevents re-spawning on React remounts while keeping PTY alive.
- **Bidirectional streaming** — Input/output flows through Socket.IO with no buffering (each event is sent immediately).
- **XTerm integration** — Uses xterm.js with FitAddon for dynamic sizing, keyboard capture, and ANSI color rendering.
- **Backend PTY Map** — Keyed by `socketId:terminalId`; socket disconnect triggers cleanup of all PTYs.
- **Critical contract** — Spawn once, persist PTY, kill explicitly, always cleanup spawn guard.
- **Gotchas** — Module-level state, PTY persistence, key collision avoidance, dimension validation, listener cleanup.

With this doc, an agent should be able to add features (new shell types, session-specific env vars), debug issues (missing output, resize failures, orphaned processes), or extend multi-terminal support with confidence.
