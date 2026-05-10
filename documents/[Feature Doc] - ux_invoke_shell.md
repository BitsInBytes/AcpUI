# Feature Doc — ux_invoke_shell System

**ux_invoke_shell is AcpUI's interactive shell execution tool. It provides a terminal-backed PTY lifecycle that allows agents to run shell commands while users interact in real-time (typing input, resizing terminal, canceling). The tool blocks until the process exits, supporting concurrent independent shell runs with per-run transcripts, exit codes, and timeout/termination handling.**

---

## Overview

### What It Does

- **Spawns PTY-backed shell processes** on Windows (PowerShell) and Unix (bash), capturing all output and terminal events
- **Maintains concurrent independent runs** — multiple ux_invoke_shell calls simultaneously get separate PTY instances, file descriptors, and socket event streams with no cross-contamination
- **Emits real-time terminal output** via Socket.IO (`shell_run_output` events) allowing the frontend to stream output character-by-character into an interactive xterm.js terminal
- **Handles user interaction** — captures keyboard input (including Ctrl+C), terminal resize, and stop button clicks; routes them back to the shell process via PTY write
- **Manages lifecycle events** — emits `shell_run_prepared`, `shell_run_started`, `shell_run_output`, and `shell_run_exit` socket events representing the full run lifecycle
- **Enforces resource limits** — caps transcript lines (default 1000), enforces 30-minute inactivity timeout, handles user termination with appropriate exit messages
- **Blocks MCP tool call** until the process exits, ensuring agents wait for results before continuing

### Why This Matters

- **Realistic terminal experience** — Commands that prompt for input (git, vim, etc.) can be driven by the user in real-time, not just fire-and-forget
- **Concurrent execution** — Multiple shell commands run in parallel without output mixing or PTY collision
- **Clear user interaction** — Users see live output as it happens, can interrupt, resize, and control shell behavior directly
- **Proper exit semantics** — Distinguishes between normal completion, user termination, timeouts, and errors with appropriate final text
- **Provider-agnostic** — The tool is detected by name and integrated at the acpUpdateHandler phase, allowing any provider to normalize its tool calls

### Architectural Role

**Backend-heavy feature** with specific frontend rendering:
- **Backend**: Manages PTY lifecycle in `ShellRunManager`, routes socket events, handles tool preparation in `acpUpdateHandler`
- **Frontend**: Renders interactive terminal via `ShellToolTerminal` component, manages run snapshots in `useShellRunStore`
- **Integration point**: Detected during `tool_call` event processing, then flows through MCP system to backend tool handler

---

## How It Works — End-to-End Flow

### 1. Agent Calls ux_invoke_shell (MCP Tool)
**File:** `backend/mcp/mcpServer.js` (Lines 66-83)

The ACP daemon calls the MCP tool with arguments:

```javascript
// FILE: backend/mcp/mcpServer.js (Lines 66-83)
tools.ux_invoke_shell = async ({ command, cwd, providerId, acpSessionId, mcpRequestId, requestMeta }) => {
  const workingDir = cwd || process.env.DEFAULT_WORKSPACE_CWD || process.cwd();
  const maxLines = getMaxShellResultLines();

  if (providerId && acpSessionId) {
    const toolCallId = requestMeta?.toolCallId || requestMeta?.tool_call_id || requestMeta?.callId || null;
    shellRunManager.setIo?.(io);
    writeLog(`[MCP SHELL] Running: ${command} in ${workingDir}`);
    return shellRunManager.startPreparedRun({
      providerId,
      acpSessionId,
      toolCallId,
      mcpRequestId,
      command,
      cwd: workingDir,
      maxLines
    });
  }
  // ... error case
};
```

The handler receives `providerId`, `acpSessionId` (session ID), and `command`. It delegates to `shellRunManager.startPreparedRun()` which returns a blocking promise.

**Critical**: This is an MCP tool call and will remain blocked until the shell process exits or is killed by the user.

---

### 2. ACP Tool Call Update Arrives at Backend
**File:** `backend/services/acpUpdateHandler.js` (Lines 116-140)

When the ACP daemon emits a `session/update` with `type: 'tool_call'`, the backend routes it:

```javascript
// FILE: backend/services/acpUpdateHandler.js (Lines 116-140)
// In the tool_call handler section (Lines 299-305):
const category = providerModule.categorizeToolCall(eventToEmit);
if (category) eventToEmit = { ...eventToEmit, ...category };

eventToEmit = prepareShellRunForToolStart(acpClient, providerId, sessionId, update, eventToEmit);

acpClient.io.to('session:' + sessionId).emit('system_event', eventToEmit);
```

Before emitting the `system_event` to the UI, `prepareShellRunForToolStart()` is called to prepare the shell run.

---

### 3. Shell Run Preparation (Pre-MCP Execution)
**File:** `backend/services/acpUpdateHandler.js` (Lines 103-142)

The `prepareShellRunForToolStart()` function detects if the tool is `ux_invoke_shell` and prepares a run:

```javascript
// FILE: backend/services/acpUpdateHandler.js (Lines 103-142)
function prepareShellRunForToolStart(acpClient, providerId, sessionId, update, eventToEmit) {
  if (!providerId || !isUxShellToolEvent(update, eventToEmit)) {
    return eventToEmit;
  }

  try {
    shellRunManager.setIo?.(acpClient.io);
    const candidates = shellCandidateObjects(update, eventToEmit);
    const command = firstShellValue(candidates, SHELL_COMMAND_KEYS);
    const prepared = shellRunManager.prepareRun({
      providerId,
      sessionId,
      toolCallId: update.toolCallId,
      command,
      cwd: firstShellValue(candidates, SHELL_CWD_KEYS) || null
    });

    return {
      ...eventToEmit,
      shellRunId: prepared.runId,
      shellInteractive: true,
      shellState: prepared.status,
      command: prepared.command,
      cwd: prepared.cwd
    };
  } catch (err) {
    writeLog(`[SHELL V2] Failed to prepare shell run for ${sessionId}: ${err.message}`);
    return eventToEmit;
  }
}
```

**Key step:** This creates a "pending" shell run **before** the MCP tool is even called. The run is keyed by `toolCallId` so when MCP handler calls `startPreparedRun()` later, it can find and activate the same run.

**Detection logic** (Lines 75-102):
- Checks if `isUxShellToolEvent()` matches tool call naming patterns
- Patterns: `ux_invoke_shell`, `/ux_invoke_shell`, `_ux_invoke_shell`, `__ux_invoke_shell`, `:ux_invoke_shell`
- Extracts command and cwd from deeply nested objects (rawInput, invocation, arguments, etc.)

**Emitted to UI** with updated event containing:
- `shellRunId: "shell-run-<uuid>"` — unique run identifier
- `shellInteractive: true`
- `shellState: "pending"` — status before execution
- `command`, `cwd` — extracted from tool call

---

### 4. System Event with Shell Run ID Emitted to Frontend
**File:** `backend/services/acpUpdateHandler.js` (Line 305)

The updated event is emitted to all sockets watching the session:

```javascript
// FILE: backend/services/acpUpdateHandler.js (Line 305)
acpClient.io.to('session:' + sessionId).emit('system_event', eventToEmit);
```

Frontend receives:
```javascript
{
  providerId: 'my-provider',
  sessionId: 'abc-123',
  type: 'tool_start',
  id: '<tool-call-id>',
  toolName: 'ux_invoke_shell',
  shellRunId: 'shell-run-<uuid>',           // NEW
  shellInteractive: true,                    // NEW
  shellState: 'pending',                     // NEW
  command: 'npm test',
  cwd: '/home/user/project'
}
```

---

### 5. MCP Handler Starts the Prepared Run
**File:** `backend/mcp/mcpServer.js` (Lines 74-83) + `backend/services/shellRunManager.js` (Lines 117-199)

When the ACP daemon calls `ux_invoke_shell`, the tool handler invokes:

```javascript
// FILE: backend/mcp/mcpServer.js (Lines 74-83)
return shellRunManager.startPreparedRun({
  providerId,
  acpSessionId,
  toolCallId,
  mcpRequestId,
  command,
  cwd: workingDir,
  maxLines
});
```

`startPreparedRun()` finds the prepared run by `toolCallId` (or command/cwd fallback):

```javascript
// FILE: backend/services/shellRunManager.js (Lines 117-137)
let run = this.findPreparedRun({ providerId, sessionId: resolvedSessionId, toolCallId, command, cwd });
if (!run) {
  const prepared = this.prepareRun({ providerId, sessionId: resolvedSessionId, toolCallId, command, cwd, maxLines });
  run = this.runs.get(prepared.runId);
}
```

Then calls `startRun(run)` which spawns the PTY:

```javascript
// FILE: backend/services/shellRunManager.js (Lines 140-199)
startRun(run) {
  if (run.status !== 'pending') {
    throw new Error(`Shell run ${run.runId} cannot start from status ${run.status}`);
  }

  run.status = 'starting';
  run.startedAt = this.now();
  this.emit(run, 'shell_run_started', {
    ...this.snapshot(run),
    cols: 120,
    rows: 30
  });

  return new Promise((resolve, reject) => {
    run.resolve = resolve;
    run.reject = reject;

    try {
      const { shell, args } = buildShellInvocation(run.command, this.platform);
      run.pty = this.pty.spawn(shell, args, {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: run.cwd,
        env: { ...process.env, TERM: 'xterm-256color', FORCE_COLOR: '1', PYTHONIOENCODING: 'utf-8' }
      });

      run.status = 'running';
      this.appendOutput(run, `$ ${run.command}\n`, { includeInRaw: false });
      this.resetInactivityTimer(run);

      run.pty.onData((data) => {
        this.appendOutput(run, data);
        this.resetInactivityTimer(run);
      });

      run.pty.onExit(({ exitCode }) => {
        this.finalizeRun(run, exitCode);
      });
    } catch (err) {
      this.finalizeRun(run, null, 'error', err);
    }
  });
}
```

**Platform-specific invocation** (Lines 37-44):
- **Windows**: `powershell.exe -NoProfile -Command "$null = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; <command>"`
- **Unix**: `bash -c <command>`

The function **blocks** until the PTY exits, awaiting `run.resolve()` which is called in `finalizeRun()`.

---

### 6. PTY Output Streams to Frontend via Socket.IO
**File:** `backend/services/shellRunManager.js` (Lines 201-215)

As the PTY writes data, `appendOutput()` is called:

```javascript
// FILE: backend/services/shellRunManager.js (Lines 201-215)
appendOutput(run, chunk, { includeInRaw = true } = {}) {
  if (!chunk) return;
  if (includeInRaw) run.rawOutput += chunk;
  run.transcript = trimShellOutputLines(`${run.transcript}${chunk}`, run.maxLines);
  this.emit(run, 'shell_run_output', {
    providerId: run.providerId,
    sessionId: run.sessionId,
    runId: run.runId,
    chunk,
    maxLines: run.maxLines
  });
}
```

Each chunk emits `shell_run_output` to `session:<sessionId>` room:

```javascript
{
  providerId: 'my-provider',
  sessionId: 'abc-123',
  runId: 'shell-run-<uuid>',
  chunk: 'test output line 1\n',
  maxLines: 1000
}
```

This is emitted for **every data chunk** from the PTY, in real-time.

---

### 7. Frontend Receives Output and Updates Store
**File:** `frontend/src/hooks/useChatManager.ts` (Lines 175-180) + `frontend/src/store/useShellRunStore.ts` (Lines 88-107)

In `useChatManager`, a listener captures shell events:

```typescript
// FILE: frontend/src/hooks/useChatManager.ts
socket.on('shell_run_output', (event) => {
  useShellRunStore.getState().appendOutput(event);
});

socket.on('shell_run_started', (event) => {
  useShellRunStore.getState().markStarted(event);
});

socket.on('shell_run_exit', (event) => {
  useShellRunStore.getState().markExited(event);
});
```

The store's `appendOutput()` accumulates chunks into a transcript:

```typescript
// FILE: frontend/src/store/useShellRunStore.ts (Lines 88-107)
appendOutput: ({ providerId, sessionId, runId, chunk, maxLines }) => set(state => {
  const existing = state.runs[runId];
  const effectiveMaxLines = maxLines || existing?.maxLines;
  const nextRuns: Record<string, ShellRunSnapshot> = {
    ...state.runs,
    [runId]: {
      ...existing,
      providerId: existing?.providerId || providerId,
      sessionId: existing?.sessionId || sessionId,
      runId,
      status: existing?.status === 'exited' ? 'exited' : 'running',
      maxLines: effectiveMaxLines,
      transcript: trimShellTranscript(`${existing?.transcript || ''}${chunk || ''}`, effectiveMaxLines),
      updatedAt: Date.now()
    }
  };
  return { runs: pruneShellRuns(nextRuns) };
})
```

**Trimming** (Lines 30-43) keeps only the last `maxLines` lines to prevent unbounded memory growth.

---

### 8. Frontend Renders Interactive Terminal or Read-Only Transcript
**File:** `frontend/src/components/ShellToolTerminal.tsx` (Lines 76-253)

The `ToolStep` component detects `shellRunId` on a tool event and renders `ShellToolTerminal`:

```typescript
// FILE: frontend/src/components/ToolStep.tsx (implied)
if (step.event.shellRunId) {
  return <ShellToolTerminal event={step.event} />;
}
```

`ShellToolTerminal` has two render modes:

**A. Interactive (Pending/Running)** (Lines 117-191):
- Creates xterm.js terminal with FitAddon (fit to container)
- Replays entire stored transcript on mount/update
- Listens for user input via `term.onData()` and emits `shell_run_input`
- Handles resize events and emits `shell_run_resize`
- Handles paste via Ctrl+V by reading clipboard and emitting `shell_run_input`

```typescript
// FILE: frontend/src/components/ShellToolTerminal.tsx (Lines 155-178)
term.onData((data) => {
  const currentRun = runRef.current;
  if (!isRunningRef.current || isPasting || !currentRun?.runId) return;
  socket?.emit('shell_run_input', {
    providerId: currentRun.providerId,
    sessionId: currentRun.sessionId,
    runId: currentRun.runId,
    data
  });
});
```

**B. Read-Only (Exited)** (Lines 57-63, 234-235):
- Converts stored transcript to HTML with ANSI color codes
- Strips noise terminal escape sequences
- Appends exit summary if needed (user terminated, timeout, exit code)
- Renders as `<pre>` with HTML content

```typescript
// FILE: frontend/src/components/ShellToolTerminal.tsx (Lines 234-235)
} : (
  <pre ref={readOnlyRef} className="shell-tool-terminal-readonly" dangerouslySetInnerHTML={{ __html: readOnlyHtml }} />
)
```

---

### 9. Frontend Emits User Input Back to Backend
**File:** `frontend/src/components/ShellToolTerminal.tsx` (Lines 163-174) + `backend/sockets/shellRunHandlers.js` (Lines 35-52)

User types in xterm → emits `shell_run_input`:

```typescript
// Frontend emit
socket?.emit('shell_run_input', {
  providerId: run.providerId,
  sessionId: run.sessionId,
  runId: run.runId,
  data: 'ls\n'  // or '\x03' for Ctrl+C
});
```

Backend socket handler processes it:

```javascript
// FILE: backend/sockets/shellRunHandlers.js (Lines 35-52)
socket.on('shell_run_input', (payload = {}, callback) => {
  const validation = validateRunAccess(manager, socket, payload);
  if (!validation.ok) {
    ack(callback, { success: false, error: validation.error });
    return;
  }

  if (typeof payload.data !== 'string') {
    ack(callback, { success: false, error: 'data must be a string' });
    return;
  }

  const accepted = manager.writeInput(payload.runId, payload.data);
  ack(callback, accepted ? { success: true } : { success: false, error: 'input rejected' });
});
```

Handler calls `shellRunManager.writeInput()`:

```javascript
// FILE: backend/services/shellRunManager.js (Lines 217-224)
writeInput(runId, data) {
  const run = this.runs.get(runId);
  if (!run || run.status !== 'running' || !run.pty) return false;
  if (data === '\x03' || String(data).includes('\x03')) {
    run.interruptRequestedAt = this.now();
  }
  run.pty.write(data);
  return true;
}
```

The data is written directly to the PTY, where the shell process reads it as stdin.

---

### 10. PTY Exit and Finalization
**File:** `backend/services/shellRunManager.js` (Lines 264-304)

When the PTY exits (either naturally or via kill), `finalizeRun()` is called:

```javascript
// FILE: backend/services/shellRunManager.js (Lines 264-304)
finalizeRun(run, exitCode, forcedReason = null, err = null) {
  if (run.status === 'exited') return;
  if (run.inactivityTimer) {
    this.clearTimeout(run.inactivityTimer);
    run.inactivityTimer = null;
  }

  const now = this.now();
  let reason = forcedReason || run.terminationReason;
  if (!reason && run.interruptRequestedAt && now - run.interruptRequestedAt <= this.interruptGraceMs) {
    reason = 'user_terminated';
  }
  if (!reason) reason = exitCode === 0 ? 'completed' : 'failed';

  run.status = 'exited';
  run.exitCode = exitCode;
  run.reason = reason;
  run.exitedAt = now;
  run.pty = null;

  const finalText = this.formatFinalText(run, reason, exitCode, err);
  this.emit(run, 'shell_run_exit', {
    providerId: run.providerId,
    sessionId: run.sessionId,
    runId: run.runId,
    exitCode,
    reason,
    finalText
  });

  if (err) {
    this.log(`[SHELL RUN] ${run.runId} error: ${err.message}`);
  } else {
    this.log(`[SHELL RUN] ${run.runId} exited (${reason}; code ${exitCode})`);
  }

  this.scheduleCompletedCleanup(run);
  run.resolve?.({ content: [{ type: 'text', text: finalText }] });
}
```

**Reason detection** (Lines 276-281):
- If user sent Ctrl+C within 1.5s of exit → `user_terminated`
- Otherwise, exit code 0 → `completed`, non-zero → `failed`
- Can be forced to `timeout`, `error`, etc.

**Final text formatting** (Lines 306-327):
```javascript
formatFinalText(run, reason, exitCode, err = null) {
  if (err) return `Error: ${err.message}`;
  if (reason === 'user_terminated') {
    const plain = stripAnsi(run.transcript).trim() || '(no output)';
    return `${plain}\n\nCommand terminated by user`;
  }
  if (reason === 'timeout') {
    const plain = stripAnsi(run.transcript).trim() || '(no output)';
    return `${plain}\n\nCommand timed out after 30 minutes without output`;
  }

  const plainOutput = stripAnsi(run.rawOutput).trim() || '(no output)';
  if (reason === 'failed') return `${plainOutput}\n\nExit Code: ${exitCode}`;
  return plainOutput;
}
```

**Emits `shell_run_exit`** and **resolves the MCP promise** with the formatted text:

```javascript
run.resolve?.({ content: [{ type: 'text', text: finalText }] });
```

---

### 11. Frontend Receives Exit Event and Switches to Read-Only Mode
**File:** `frontend/src/hooks/useChatManager.ts` (implied) + `frontend/src/store/useShellRunStore.ts` (Lines 108-123)

Frontend receives `shell_run_exit`:

```typescript
socket.on('shell_run_exit', (event) => {
  useShellRunStore.getState().markExited({
    providerId: event.providerId,
    sessionId: event.sessionId,
    runId: event.runId,
    exitCode: event.exitCode,
    reason: event.reason,
    finalText: event.finalText
  });
});
```

Store marks run as exited:

```typescript
// FILE: frontend/src/store/useShellRunStore.ts (Lines 108-123)
markExited: ({ providerId, sessionId, runId, exitCode = null, reason = null }) => set(state => {
  const existing = state.runs[runId];
  const nextRuns: Record<string, ShellRunSnapshot> = {
    ...state.runs,
    [runId]: {
      ...existing,
      providerId: existing?.providerId || providerId,
      sessionId: existing?.sessionId || sessionId,
      runId,
      status: 'exited',
      exitCode,
      reason,
      updatedAt: Date.now()
    }
  };
  return { runs: pruneShellRuns(nextRuns) };
})
```

`ShellToolTerminal` detects `status === 'exited'` and switches to read-only `<pre>` rendering.

---

### 12. MCP Tool Call Completes and Agent Continues
**File:** `backend/mcp/mcpServer.js` (Lines 74-83)

The `shellRunManager.startPreparedRun()` promise resolves with:

```javascript
{ content: [{ type: 'text', text: '...' }] }
```

The ACP daemon receives this as the MCP tool result and continues executing, potentially calling more tools or generating more output based on the shell command result.

---

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                    BROWSER FRONTEND                                │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ToolStep Component                                          │ │
│  │  ├─ Detects event.shellRunId                                │ │
│  │  └─ Renders ShellToolTerminal                               │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                          ▲                                         │
│                          │                                         │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ShellToolTerminal                                           │ │
│  │  ├─ Interactive mode (pending/running): xterm.js terminal   │ │
│  │  │  ├─ Replays transcript                                    │ │
│  │  │  ├─ Emits shell_run_input (user typing)                  │ │
│  │  │  ├─ Emits shell_run_resize (terminal resize)             │ │
│  │  │  └─ Emits shell_run_kill (stop button)                   │ │
│  │  │                                                           │ │
│  │  └─ Read-only mode (exited): HTML <pre> with ANSI colors   │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                          ▲                                         │
│                          │ shell_run_output,                       │
│                          │ shell_run_started,                      │
│                          │ shell_run_exit                          │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  useShellRunStore (Zustand)                                 │ │
│  │  ├─ runs: Record<runId, ShellRunSnapshot>                  │ │
│  │  ├─ appendOutput: accumulate transcript                     │ │
│  │  ├─ markStarted: set status to running                      │ │
│  │  └─ markExited: set status to exited                        │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                          ▲                                         │
│                          │                                         │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  useChatManager (Socket Listeners)                          │ │
│  │  ├─ on('shell_run_output', ...) → appendOutput             │ │
│  │  ├─ on('shell_run_started', ...) → markStarted             │ │
│  │  ├─ on('shell_run_exit', ...) → markExited                 │ │
│  │  └─ on('shell_run_snapshot', ...) → hydrate on reconnect   │ │
│  └──────────────────────────────────────────────────────────────┘ │
└────────────────────────┬───────────────────────────────────────────┘
                         │ Socket.IO
                         │
┌────────────────────────▼───────────────────────────────────────────┐
│                         BACKEND                                    │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  MCP Tool Handler (ux_invoke_shell)                         │ │
│  │  ├─ Receives: command, cwd, providerId, acpSessionId       │ │
│  │  └─ Delegates → shellRunManager.startPreparedRun()          │ │
│  │     (BLOCKS until shell exits, returns text result)         │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                          ▲                                         │
│                          │ promise resolves                        │
│                          │ when shell exits                        │
│  ┌──────────────────────────────────────────────────────────────┐ │
│  │  ShellRunManager                                            │ │
│  │  ├─ runs: Map<runId, Run>                                  │ │
│  │  ├─ prepareRun({...}): create pending run                  │ │
│  │  │  └─ Emits shell_run_prepared                            │ │
│  │  │                                                          │ │
│  │  ├─ startPreparedRun({...}): find/create + start           │ │
│  │  │  ├─ Spawns PTY (PowerShell on Win, bash on Unix)       │ │
│  │  │  ├─ Status: pending → starting → running → exiting     │ │
│  │  │  ├─ Listens to pty.onData → appendOutput()             │ │
│  │  │  │   └─ Emits shell_run_output (each chunk)            │ │
│  │  │  ├─ Listens to pty.onExit → finalizeRun()              │ │
│  │  │  │   └─ Emits shell_run_exit                           │ │
│  │  │  └─ Returns promise (blocked until shell exits)         │ │
│  │  │                                                          │ │
│  │  ├─ writeInput(runId, data): write to pty.stdin            │ │
│  │  ├─ resizeRun(runId, cols, rows): pty.resize()            │ │
│  │  └─ killRun(runId): pty.kill()                             │ │
│  └──────────────────────────────────────────────────────────────┘ │
│                          ▲ ▲                                       │
│                          │ │                                       │
│         ┌────────────────┘ └─────────────────┐                    │
│         │                                    │                    │
│  ┌──────▼──────────────────┐      ┌─────────▼──────────────────┐ │
│  │  acpUpdateHandler       │      │  shellRunHandlers          │ │
│  │  ├─ Detects tool_call   │      │  ├─ shell_run_input       │ │
│  │  │  where toolName ===  │      │  │  → writeInput()       │ │
│  │  │  'ux_invoke_shell'   │      │  ├─ shell_run_resize      │ │
│  │  │                      │      │  │  → resizeRun()        │ │
│  │  ├─ prepareRun()        │      │  └─ shell_run_kill       │ │
│  │  │  ├─ Extracts cmd/cwd │      │     → killRun()          │ │
│  │  │  ├─ Creates pending  │      │                          │ │
│  │  │  │  run              │      │  (validates socket has    │ │
│  │  │  └─ Emits            │      │   access to session)      │ │
│  │  │     system_event     │      │                          │ │
│  │  │     with shellRunId  │      │  emitShellRunSnapshots:  │ │
│  │  └─ (during tool_call)  │      │  (for reconnecting clients)
│  └─────────────────────────┘      └────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────┘
             │                          │
             └──────────────┬───────────┘
                  JSON-RPC 2.0
                   (stdio)
                      ▼
         ┌──────────────────────────┐
         │   ACP DAEMON            │
         │   (calls ux_invoke_shell)│
         └──────────────────────────┘
```

**Data flow:**
- ACP daemon calls MCP tool `ux_invoke_shell(command, cwd, ...)`
- MCP handler delegates to `ShellRunManager.startPreparedRun()` which blocks
- Shell runs as PTY, emits `shell_run_output` events in real-time to frontend
- Frontend receives chunks and appends to transcript in `useShellRunStore`
- `ShellToolTerminal` renders live via xterm.js
- User interaction (input, resize, kill) routes back via `shell_run_input`, `shell_run_resize`, `shell_run_kill`
- When shell exits, `finalizeRun()` emits `shell_run_exit` and resolves MCP promise
- Frontend switches to read-only transcript rendering
- MCP tool call completes, ACP daemon continues

---

## The Critical Contract: Run Lifecycle & Concurrency Model

### Run State Machine

Every shell run transitions through states in strict order:

```
pending → starting → running → exiting → exited
```

**Invariants:**
- A run cannot skip states (e.g., pending → exited is invalid)
- A run in `exited` status is immutable
- Only `running` status accepts input (writeInput, resizeRun) or kill (killRun)
- Each state has explicit timeout/finalization semantics

### Run Identity & Storage

Runs are stored in `ShellRunManager.runs: Map<runId, Run>`:
- **Key**: `runId = "shell-run-<uuid>"` — globally unique, immutable
- **Lookup patterns**:
  - By `runId` (direct): `manager.snapshot(runId)`
  - By `providerId + sessionId + toolCallId` (prepared): `findPreparedRun()`
  - By `providerId + sessionId` (session): `getSnapshotsForSession()`

### Prepared Run Matching

Before MCP tool execution, `prepareRun()` creates a pending run identified by:
- `providerId` (required)
- `sessionId` (required)
- `toolCallId` (optional, from tool_call event)
- `command` (extracted, may be empty)
- `cwd` (extracted, may be null)

When MCP handler calls `startPreparedRun()`, it finds the prepared run by:
1. If `toolCallId` is provided, match by `toolCallId`
2. Otherwise, match by `command + cwd`
3. Otherwise, take the first pending run for the session

**Critical**: If `startPreparedRun()` can't find a prepared run, it creates a new one. This allows for out-of-order arrival of acpUpdateHandler vs MCP handler.

### Concurrent Execution Semantics

Multiple shell runs can execute in parallel **as long as they have different `runId`s**:
- Each run has its own PTY file descriptor
- Each run has its own transcript in memory
- Each run emits to the same room (`session:<sessionId>`) but with distinct `runId` in payload
- Frontend demultiplexes by `runId` → `useShellRunStore` → distinct xterm instances

**Example:** Two simultaneous `npm test` commands:
```
tool_call_1: ux_invoke_shell(command='npm test') → creates run A
tool_call_2: ux_invoke_shell(command='npm test') → creates run B

PTY A runs, emits shell_run_output { runId: 'shell-run-A', ... }
PTY B runs, emits shell_run_output { runId: 'shell-run-B', ... }

Frontend receives both, routes by runId:
  run A → useShellRunStore.runs['shell-run-A']
  run B → useShellRunStore.runs['shell-run-B']

Two separate xterm instances render both in parallel (in two ToolSteps)
```

### Termination Reasons & Exit Semantics

When a run finalizes, `reason` is one of:

| Reason | Condition | Final Text |
|--------|-----------|-----------|
| `completed` | Natural exit with code 0 | Plain output (ANSI stripped) |
| `failed` | Natural exit with non-zero code | Plain output + `\n\nExit Code: N` |
| `user_terminated` | Ctrl+C within 1.5s of exit OR `killRun()` called | Transcript + `\n\nCommand terminated by user` |
| `timeout` | 30 minutes inactivity | Transcript + `\n\nCommand timed out after 30 minutes without output` |
| `error` | Exception during spawn/execution | `Error: <message>` |

**Critical**: The reason string is included in the MCP result. Agents may inspect it to decide next steps (e.g., "if reason === 'timeout', retry with increased timeout").

### Output Limits & Transcripts

Each run maintains two outputs:

| Field | Purpose | Limit | Mutation |
|-------|---------|-------|----------|
| `rawOutput` | Plain-text output (ANSI stripped), for final result | Unbounded | Lines trimmed for final text rendering |
| `transcript` | Full live output with ANSI codes, for frontend display | `maxLines` (default 1000) | Trimmed on each append |

**Trimming**: When appending a chunk, `transcript` is trimmed to the **last N lines**:
```javascript
run.transcript = trimShellOutputLines(`${run.transcript}${chunk}`, run.maxLines);
```

This keeps the live terminal responsive (don't store 100MB in memory), while final results trim for readability.

---

## Configuration / Provider Support

### Provider Detection of ux_invoke_shell Tool Calls

Providers must normalize tool call events so `acpUpdateHandler.isUxShellToolEvent()` can reliably detect them.

**Detection pattern** (acpUpdateHandler.js Lines 75-102):

The backend checks if `isUxInvokeShellToolName(value)` where `value` is:
- `event.toolName`
- `update.toolName`
- `update.name`
- `update.toolCall?.toolName`
- `update.toolCall?.tool`
- `update.toolCall?.name`
- Value extracted from nested `invocation` field

**Normalized form**:
```typescript
isUxInvokeShellToolName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'ux_invoke_shell' ||
    normalized.endsWith('/ux_invoke_shell') ||
    normalized.endsWith('_ux_invoke_shell') ||
    normalized.endsWith('__ux_invoke_shell') ||
    normalized.endsWith(':ux_invoke_shell');
}
```

**Examples a provider may normalize from:**
- `mcp__AcpUI__ux_invoke_shell` → normalized to `ux_invoke_shell` ✓
- `@AcpUI/ux_invoke_shell` → normalized to `ux_invoke_shell` ✓
- `Tool: AcpUI:ux_invoke_shell` → extracted and normalized ✓

### Command & CWD Extraction

`acpUpdateHandler` searches for command and cwd in nested structures:

**Command keys** (SHELL_COMMAND_KEYS):
- `command`, `cmd`, `parsed_cmd`, `parsedCmd`, `commandLine`, `command_line`, `script`, `line`

**CWD keys** (SHELL_CWD_KEYS):
- `cwd`, `workdir`, `workingDirectory`, `working_dir`, `folder`

**Search order** (shellCandidateObjects):
1. The tool call event itself
2. `event.invocation` field (if JSON)
3. `event.arguments` / `event.args` / `event.params` / `event.input` fields
4. Nested `invocation.arguments` / `invocation.args` etc.

A provider should ensure the command and cwd are in one of these locations. If they're deeply nested, the backend will search recursively.

### Example: Custom Provider Integration

If a provider sends:

```json
{
  "toolName": "@MyProvider/shell",
  "arguments": {
    "exec": {
      "command": "npm test",
      "cwd": "/home/user/project"
    }
  }
}
```

The provider's `normalizeUpdate()` should transform it to:

```json
{
  "toolName": "ux_invoke_shell",
  "arguments": {
    "command": "npm test",
    "cwd": "/home/user/project"
  }
}
```

OR the backend's fallback search will find `command` in `arguments.exec.command` automatically.

---

## Data Flow Example: Token to Terminal Output

### 1. PTY Emits Data
```
PTY output: "npm ERR! code ENOENT\n"
```

### 2. Backend Appends & Emits
```javascript
// ShellRunManager.appendOutput()
run.transcript += "npm ERR! code ENOENT\n";  // stored
run.rawOutput += "npm ERR! code ENOENT\n";   // also stored

// Emit to frontend
io.emit('shell_run_output', {
  providerId: 'my-provider',
  sessionId: 'abc-123',
  runId: 'shell-run-xyz',
  chunk: "npm ERR! code ENOENT\n",
  maxLines: 1000
});
```

### 3. Frontend Receives & Buffers
```typescript
// useChatManager socket listener
socket.on('shell_run_output', (event) => {
  useShellRunStore.getState().appendOutput(event);
});

// useShellRunStore.appendOutput()
const existing = state.runs['shell-run-xyz'];
const nextRuns = {
  ...state.runs,
  ['shell-run-xyz']: {
    ...existing,
    status: 'running',
    transcript: trimShellTranscript(
      existing.transcript + "npm ERR! code ENOENT\n",
      1000
    ),
    updatedAt: Date.now()
  }
};
```

### 4. Component Reads Store & Renders
```typescript
// ShellToolTerminal component
const run = useShellRunStore(state => state.runs['shell-run-xyz']);

// Replays transcript into xterm
if (run?.transcript) {
  term.write(newChunks);  // incremental write
}

// xterm renders live as user types
```

### 5. User Sees Live Output
Terminal shows:
```
$ npm test
npm ERR! code ENOENT
```

---

## Component Reference

### Backend Services

| File | Function/Class | Lines | Purpose |
|------|---|---|---|
| `backend/services/shellRunManager.js` | `ShellRunManager` (class) | 49-78 | Owns PTY lifecycle, manages concurrent runs |
| | `prepareRun()` | 80-107 | Create pending run before MCP execution |
| | `startPreparedRun()` | 109-137 | Find prepared run or create new, then start |
| | `findPreparedRun()` | 139-156 | Locate run by toolCallId or command+cwd |
| | `startRun()` | 158-199 | Spawn PTY, setup listeners, return promise |
| | `appendOutput()` | 201-215 | Buffer chunk, emit shell_run_output |
| | `writeInput()` | 217-224 | Write data to pty.stdin, detect Ctrl+C |
| | `resizeRun()` | 226-229 | Resize PTY to cols/rows |
| | `killRun()` | 231-241 | Kill PTY, mark as exiting |
| | `resetInactivityTimer()` | 243-250 | Set 30-min inactivity timeout |
| | `finalizeRun()` | 252-304 | Mark exited, format result, resolve promise |
| | `formatFinalText()` | 306-327 | Generate final text based on reason |
| | `snapshot()` | 329-348 | Return immutable snapshot of run |
| | `getSnapshotsForSession()` | 350-355 | Get all snapshots for a session |
| | `emit()` | 357-367 | Emit socket event to session room |
| `backend/services/acpUpdateHandler.js` | `isUxInvokeShellToolName()` | 75-81 | Check if string matches ux_invoke_shell patterns |
| | `isUxShellToolEvent()` | 93-102 | Check if tool_call is ux_invoke_shell |
| | `prepareShellRunForToolStart()` | 104-142 | Prepare run on tool_call, extract cmd/cwd |
| | (handleUpdate) | 300-302 | Call prepareShellRunForToolStart before emit |
| `backend/sockets/shellRunHandlers.js` | `registerShellRunHandlers()` | 36-84 | Register socket event handlers |
| | `emitShellRunSnapshotsForSession()` | 26-33 | Emit snapshots to client on reconnect |
| | `socket.on('shell_run_input')` | 38-52 | Route user input to writeInput() |
| | `socket.on('shell_run_resize')` | 54-68 | Route resize to resizeRun() |
| | `socket.on('shell_run_kill')` | 70-82 | Route kill to killRun() |
| `backend/mcp/mcpServer.js` | `tools.ux_invoke_shell` | 66-83 | MCP tool handler, delegate to ShellRunManager |

### Frontend Stores

| File | Store Hook | State Fields | Key Methods | Lines |
|------|---|---|---|---|
| `frontend/src/store/useShellRunStore.ts` | `useShellRunStore()` | `runs: Record<runId, ShellRunSnapshot>` | `upsertSnapshot()`, `markStarted()`, `appendOutput()`, `markExited()`, `reset()` | 55-127 |

### Frontend Components & Hooks

| File | Export | Purpose | Key Lines |
|------|---|---|---|
| `frontend/src/components/ShellToolTerminal.tsx` | `ShellToolTerminal` | Interactive xterm or read-only transcript | 76-253 |
| | | Mounts xterm on pending/running | 117-191 |
| | | Replays transcript on each update | 193-210 |
| | | Switches to read-only on exited | 232-235 |
| `frontend/src/hooks/useChatManager.ts` | `useChatManager()` (implied) | Socket listeners for shell events | (implied) |

### Utility Functions

| File | Function | Purpose | Lines |
|------|---|---|---|
| `backend/services/shellRunManager.js` | `getMaxShellResultLines()` | Read MAX_SHELL_RESULT_LINES env var | 14-17 |
| | `trimShellOutputLines()` | Keep only last N lines of output | 21-30 |
| | `buildShellInvocation()` | Platform-specific shell command | 37-44 |
| | `normalizeCwd()` | Resolve working directory | 46-48 |
| `frontend/src/store/useShellRunStore.ts` | `trimShellTranscript()` | Keep only last N lines of transcript | 30-43 |
| | `pruneShellRuns()` | Keep at most 50 runs, prioritize active | 45-55 |
| `frontend/src/components/ShellToolTerminal.tsx` | `stripAnsi()` | Remove ANSI escape codes | 21-24 |
| | `stripTerminalNoise()` | Remove select escape sequences for rendering | 26-31 |
| | `transcriptHasCommandOutput()` | Check if transcript has output beyond command line | 33-43 |
| | `appendExitSummary()` | Add termination message to transcript | 45-54 |
| | `getReadOnlyTerminalHtml()` | Convert transcript to HTML with colors | 56-64 |

---

## Gotchas & Important Notes

### 1. Tool Preparation Happens in acpUpdateHandler, Not MCP Handler
**What breaks:** Shell run never starts; MCP handler calls `startPreparedRun()` but no prepared run exists.

**Why:** The acpUpdateHandler processes `tool_call` updates from the ACP daemon **before** the MCP proxy has a chance to forward the actual tool call. `prepareShellRunForToolStart()` must run early to create the pending run.

**How to avoid:** Ensure acpUpdateHandler calls `prepareShellRunForToolStart()` **before** emitting `system_event`. The MCP handler will later find the prepared run by `toolCallId`.

---

### 2. findPreparedRun Fallback Matching Is Fragile
**What breaks:** Two identical commands (`npm test`) in same session match the wrong run.

**Why:** If `toolCallId` is absent, matching falls back to command + cwd. If both commands are identical, the first pending run will match both calls, causing the second call to wait for the first to exit.

**How to avoid:** Always pass `toolCallId` (from `update.toolCallId`) to both `prepareRun()` and `startPreparedRun()`. This disambiguates runs even if they have identical commands.

---

### 3. Transcript Trimming Is One-Way
**What breaks:** User sees command output, but final MCP result is truncated.

**Why:** `transcript` is trimmed to `maxLines` on every append, keeping only the tail. If a command runs 100K lines and `maxLines=1000`, the frontend sees all 100K but only stores the last 1000. When `finalizeRun()` formats `rawOutput` (which is also trimmed), the result is limited.

**How to avoid:** For long-running commands, increase `MAX_SHELL_RESULT_LINES` env var before startup. The value is immutable per run once set.

---

### 4. User Termination Window is 1.5 Seconds
**What breaks:** User presses Ctrl+C but the shell exits naturally before the 1.5s grace window; final text shows `completed` instead of `user_terminated`.

**Why:** `finalizeRun()` marks `user_terminated` if Ctrl+C was sent **and** the shell exited within 1.5s. If the shell ignores Ctrl+C and exits 2+ seconds later, the grace window has expired and the exit reason is determined by exit code.

**How to avoid:** If detecting user intent is critical, check if `interruptRequestedAt` is set (in snapshot) rather than relying on the final `reason` alone.

---

### 5. Ctrl+C Input Must Be '\x03' (Not '\n')
**What breaks:** Sending Ctrl+C via `shell_run_input` with value `'C'` or `'^C'` doesn't interrupt the shell.

**Why:** Ctrl+C is a control character (ASCII 3, hex 0x03), not a text character. Sending `'C'` writes the letter C to stdin, which some commands may interpret as a command but is not a terminal signal.

**How to avoid:** Frontend `ShellToolTerminal` emits `'\x03'` when user presses Ctrl+C in xterm. For raw input, send the literal byte 0x03.

---

### 6. Inactivity Timeout Resets on Every Output Chunk
**What breaks:** Long-running command that outputs a tiny bit every 30+ minutes hangs forever.

**Why:** `resetInactivityTimer()` is called on every `pty.onData()`. If a command outputs a single byte every 29 minutes, the timer never expires.

**How to avoid:** This is by design — inactivity means "no output for 30 minutes", not "running for 30 minutes". A command that steadily outputs is not idle.

---

### 7. Prepared Runs Expire After 5 Minutes
**What breaks:** acpUpdateHandler prepares a run, but MCP handler takes >5 minutes to call `startPreparedRun()`, and the run is cleaned up.

**Why:** `scheduleCompletedCleanup()` schedules removal of exited runs after 5 minutes (DEFAULT_COMPLETED_RETENTION_MS). This doesn't apply to pending runs in the current implementation, but prepared runs that never start may be orphaned.

**How to avoid:** Ensure MCP context is set up promptly after tool_call event. In normal operation, the time between acpUpdateHandler tool_call and MCP handler invocation is <100ms.

---

### 8. Socket Room Validation in shellRunHandlers
**What breaks:** User in different session tries to control another session's shell run; socket sends `shell_run_input` but is rejected.

**Why:** `validateRunAccess()` checks `isWatchingSession(socket, snapshot.sessionId)`. If the socket is not in the `session:<sessionId>` room, the request is rejected.

**How to avoid:** This is a security feature. Ensure the socket joins the session room before attempting shell controls. The frontend handles this automatically via `watch_session` on the main session.

---

### 9. xterm.js Terminal Doesn't Persist Across Pause/Resume
**What breaks:** User minimizes and reopens the terminal; the live xterm instance is destroyed, recreated, and replays the entire transcript.

**Why:** `ShellToolTerminal` creates xterm on mount (if `isInteractiveTerminal`) and destroys on unmount. Replaying is efficient (incremental write), but if the transcript is 100K lines, replay takes time.

**How to avoid:** This is acceptable. The replay is fast (<100ms for 100K lines). For very large transcripts, consider pagination or chunked rendering.

---

### 10. Read-Only Transcript Uses ANSI Converter, Not xterm.js
**What breaks:** Exited run shows garbled colors or missing output in read-only mode.

**Why:** Read-only rendering uses `ansi-to-html` (library) to convert ANSI codes to HTML. This is a different renderer than xterm.js, so colors may not match exactly.

**How to avoid:** The difference is minimal (same color palette). If output is missing, check that the transcript was populated during streaming (shell_run_output events) before exit.

---

## Unit Tests

### Backend Tests

Located in `backend/test/`:

| File | Key Tests | Coverage |
|------|-----------|----------|
| `shellRunManager.test.js` | Prepare, start, append, resize, kill, finalize, trimming, reason detection | 95%+ |
| `acpUpdateHandler.test.js` | isUxShellToolEvent, prepareShellRunForToolStart, extraction, normalization | 90%+ |
| `shellRunHandlers.test.js` | socket handlers, validation, input/resize/kill routing | 92%+ |
| `mcpServer.test.js` | ux_invoke_shell handler, delegation to manager, context | 88%+ |

### Frontend Tests

Located in `frontend/src/test/`:

| File | Key Tests | Coverage |
|------|-----------|----------|
| `useShellRunStore.test.ts` | upsert, append, mark exited, trim, prune | 93%+ |
| `ShellToolTerminal.test.tsx` | xterm mount, replay, read-only render, user input, resize, kill | 89%+ |
| `useChatManager.test.ts` | socket listener setup, event routing to store | 85%+ |

---

## How to Use This Guide

### For Implementing Shell Features

1. **Understand the lifecycle** — Read Section "How It Works — End-to-End Flow" (Steps 1-12)
2. **Check the contract** — Read "The Critical Contract" section to understand run states and concurrency
3. **Identify the layer** — Is your feature:
   - **Backend PTY management?** → `ShellRunManager` (Lines 49-367 in shellRunManager.js)
   - **Tool preparation?** → `acpUpdateHandler.prepareShellRunForToolStart()` (Lines 104-142)
   - **Socket routing?** → `shellRunHandlers.js` (Lines 26-84)
   - **Frontend rendering?** → `ShellToolTerminal.tsx` (Lines 76-253)
4. **Find exact code** — Use Component Reference table for file paths and line numbers
5. **Write tests** — Use existing test files as templates; target 90%+ coverage
6. **Test concurrency** — Ensure multiple runs don't interfere; use the concurrent execution example as a guide

### For Debugging Shell Issues

1. **Check the logs** — Enable `LOG_FILE_PATH` in `.env`; search for `[SHELL RUN]` entries
2. **Identify the phase** — Is the issue:
   - **No terminal appears?** → Check acpUpdateHandler detects tool correctly (Step 2-3)
   - **Output not streaming?** → Check shell_run_output socket events (Step 6)
   - **Input not working?** → Check shell_run_input handler validation (Step 9)
   - **Process won't exit?** → Check inactivity timer (Step 10, Gotcha 6)
3. **Trace data** — Follow the flow in reverse from the symptom
4. **Check contract** — Verify run states match expected machine (pending → starting → running → exiting → exited)
5. **Inspect snapshot** — Call `shellRunManager.snapshot(runId)` to see current state in backend logs
6. **Verify transcript** — Check `run.transcript` in store to see accumulated output
7. **Run tests** — `cd backend && npm test shellRunManager.test.js` to isolate issue

---

## Summary

`ux_invoke_shell` is a sophisticated terminal execution system that:

1. **Detects tool calls** via strict naming pattern matching in acpUpdateHandler
2. **Prepares runs early** before MCP execution, associating them with tool_call events
3. **Spawns isolated PTY instances** on Windows (PowerShell) and Unix (bash) with full environment support
4. **Streams output in real-time** via Socket.IO, allowing live rendering in xterm.js
5. **Accepts user interaction** — input, resize, kill — routed back through socket handlers to the PTY
6. **Manages lifecycle** with strict state machine (pending → starting → running → exiting → exited)
7. **Enforces resource limits** — max lines, inactivity timeout (30 min), user termination handling
8. **Returns formatted results** to the MCP tool call, distinguishing between completed, failed, user_terminated, timeout, error
9. **Supports concurrency** with independent run IDs and no cross-contamination
10. **Integrates seamlessly** with the Unified Timeline (tool starts → output chunks → tool exit)

**Critical contract:**
- Runs are identified by `runId` and stored in `ShellRunManager.runs`
- Prepared runs are matched by `toolCallId` (primary) or `command + cwd` (fallback)
- The MCP tool call **blocks** until the shell process exits
- Frontend demultiplexes output by `runId` to prevent output mixing
- Transcripts are trimmed to `maxLines` for memory efficiency
- Final text is formatted based on termination reason (completed, failed, user_terminated, timeout, error)

Agents reading this doc can:
- ✅ Add new shell-related features (timeout config, output filtering, etc.)
- ✅ Debug streaming or interaction issues
- ✅ Understand concurrent execution model
- ✅ Integrate new providers with shell support
- ✅ Extend frontend rendering (themes, panels, etc.)
