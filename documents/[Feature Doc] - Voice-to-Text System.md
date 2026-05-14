# Feature Doc - Voice-to-Text System

Voice-to-text lets a user record microphone audio in the chat input, encode it as a local WAV blob, send it to the backend through Socket.IO, and insert the local whisper.cpp transcript into the active prompt textarea.

Why this matters: the feature crosses browser media APIs, frontend state, Socket.IO payload limits, temporary files, a spawned whisper-server process, and optional environment configuration. Most failures happen at those boundaries.

## Overview

### What It Does
- Captures microphone audio through `navigator.mediaDevices.getUserMedia()` in `frontend/src/utils/wavRecorder.ts` (Class: `WavRecorder`).
- Buffers mono audio in the browser and encodes it as a 16 kHz, 16-bit PCM WAV `Blob`.
- Advertises feature availability through the `voice_enabled` socket event and `useVoiceStore.isVoiceEnabled`.
- Renders a mic control in `frontend/src/components/ChatInput/ChatInput.tsx` (Component: `ChatInput`, Handler: `onMicClick`) when voice is enabled.
- Sends the recorded `ArrayBuffer` through the `process_voice` socket event.
- Spawns `backend/whisper/whisper-server.exe` from `backend/voiceService.js` (Function: `startSTTServer`) when `VOICE_STT_ENABLED=true`, and stops it through `stopSTTServer` during backend shutdown.
- Posts the WAV file to whisper-server's `/inference` endpoint and returns `{ text }` through the socket callback.
- Replaces the active session input with the transcript through `useInputStore.setInput()`.

### Why This Matters
- The browser must produce a WAV shape that whisper-server can decode.
- `VOICE_STT_ENABLED` controls UI visibility but does not validate microphone permission, whisper binary health, or model file health.
- The frontend holds the full recording in memory until stop, so this is a one-shot recording path, not streaming transcription.
- The backend writes a temporary WAV file and must delete it after the HTTP request.
- The feature is provider-independent; transcript text enters the same prompt input as typed text.

Architectural role: frontend recording and UI state, backend Socket.IO routing, local whisper.cpp process management, and temporary file IO. It does not use provider config, provider protocol extensions, or database tables.

## How It Works - End-to-End Flow

### 1. Backend Loads STT Configuration and Starts whisper-server
File: `backend/server.js` (Startup block: `startSTTServer()`, Shutdown path: `shutdownServer`)
File: `backend/voiceService.js` (Functions: `isSTTEnabled`, `startSTTServer`, `stopSTTServer`; Config keys: `VOICE_STT_ENABLED`, `STT_PORT`)

```javascript
// FILE: backend/voiceService.js (Functions: isSTTEnabled, startSTTServer, stopSTTServer)
const WHISPER_SERVER = path.join(__dirname, 'whisper', 'whisper-server.exe');
const WHISPER_MODEL = path.join(__dirname, 'whisper', 'ggml-small.bin');
const STT_PORT = process.env.STT_PORT || '9877';

export function isSTTEnabled() {
  return process.env.VOICE_STT_ENABLED === 'true';
}

export function startSTTServer() {
  if (!isSTTEnabled() || serverProcess) return;
  serverProcess = spawn(WHISPER_SERVER, [
    '-m', WHISPER_MODEL,
    '--port', String(STT_PORT),
    '-t', '4'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
}

export function stopSTTServer() {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;
  proc.kill?.();
}
```

`backend/server.js` calls `startSTTServer()` during backend initialization and calls `stopSTTServer()` through `shutdownServer`. The service checks `VOICE_STT_ENABLED`, keeps a module-level `serverProcess` guard, launches the whisper server with the configured port, `ggml-small.bin`, and four worker threads, and clears/kills the process reference during controlled backend shutdown.

### 2. Backend Advertises Voice Availability
File: `backend/sockets/index.js` (Socket event: `voice_enabled`)
File: `backend/services/acpClient.js` (Method: `performHandshake`, Socket event: `voice_enabled`)
File: `frontend/src/hooks/useSocket.ts` (Hook: `useSocket`, Socket event handler: `voice_enabled`)

```javascript
// FILE: backend/sockets/index.js (Socket event: voice_enabled)
socket.emit('voice_enabled', { enabled: isSTTEnabled() });
```

```typescript
// FILE: frontend/src/hooks/useSocket.ts (Socket event handler: voice_enabled)
_socket.on('voice_enabled', (data: { enabled: boolean }) => {
  useVoiceStore.getState().setIsVoiceEnabled(data.enabled);
});
```

Each socket connection receives `voice_enabled` from `registerSocketHandlers()`. `acpClient.performHandshake()` also emits the same event after the provider handshake. The frontend stores the boolean in `useVoiceStore.isVoiceEnabled`; `ChatInput` uses that state to decide whether to render the mic button.

### 3. Frontend Discovers Audio Devices
File: `frontend/src/hooks/useChatManager.ts` (Hook: `useChatManager`, Initial load callback: `mockFetch`)
File: `frontend/src/hooks/useVoice.ts` (Hook: `useVoice`, Function: `fetchAudioDevices`)
File: `frontend/src/store/useVoiceStore.ts` (Store: `useVoiceStore`, Action: `fetchAudioDevices`)
File: `frontend/src/components/SystemSettingsModal.tsx` (Component: `SystemSettingsModal`, Tab: `audio`)

```typescript
// FILE: frontend/src/hooks/useVoice.ts (Function: fetchAudioDevices)
const devices = await navigator.mediaDevices.enumerateDevices();
const audioInputs = devices
  .filter(d => d.kind === 'audioinput')
  .map(d => ({ id: d.deviceId, label: d.label || 'Default Microphone' }));

setAvailableAudioDevices(audioInputs);
if (audioInputs.length > 0 && !selectedAudioDevice) {
  setSelectedAudioDevice(audioInputs[0].id);
}
```

`useChatManager()` enumerates input devices during initial session load and writes them to `useVoiceStore.availableAudioDevices`. `SystemSettingsModal` renders the Audio tab from the same store and lets the user select a device. `useVoice.fetchAudioDevices()` also selects the first discovered device when no `selectedAudioDevice` is stored.

### 4. System Settings Persists the Selected Microphone
File: `frontend/src/store/useVoiceStore.ts` (Store: `useVoiceStore`, Action: `setSelectedAudioDevice`, localStorage key: `selectedAudioDevice`)
File: `frontend/src/components/SystemSettingsModal.tsx` (Component: `SystemSettingsModal`, Tab: `audio`)

```typescript
// FILE: frontend/src/store/useVoiceStore.ts (Action: setSelectedAudioDevice)
selectedAudioDevice: localStorage.getItem('selectedAudioDevice') || '',

setSelectedAudioDevice: (deviceId) => {
  localStorage.setItem('selectedAudioDevice', deviceId);
  set({ selectedAudioDevice: deviceId });
},
```

The selected browser device ID is global frontend state and persists in localStorage. An empty string means the recorder asks the browser for the default system audio input.

### 5. ChatInput Renders and Toggles the Mic Button
File: `frontend/src/components/ChatInput/ChatInput.tsx` (Component: `ChatInput`, Handler: `onMicClick`, CSS classes: `mic-btn`, `recording`, `processing`)
File: `frontend/src/components/ChatInput/ChatInput.css` (Selectors: `.mic-btn.recording`, `.mic-btn.processing`)

```typescript
// FILE: frontend/src/components/ChatInput/ChatInput.tsx (Handler: onMicClick)
const onMicClick = () => {
  if (isRecording) {
    stopRecording((text) => setInput(activeSessionId || '', text));
  } else {
    startRecording();
  }
};
```

When `isVoiceEnabled` is true, `ChatInput` renders a mic button. The button calls `startRecording()` when idle and `stopRecording()` when recording. The transcript callback writes the returned text into the input store for the active session ID. The current behavior replaces the full input value with the transcript.

### 6. WavRecorder Starts Browser Audio Capture
File: `frontend/src/hooks/useVoice.ts` (Hook: `useVoice`, Function: `startRecording`)
File: `frontend/src/utils/wavRecorder.ts` (Class: `WavRecorder`, Method: `start`)

```typescript
// FILE: frontend/src/utils/wavRecorder.ts (Method: start)
const constraints: MediaStreamConstraints = {
  audio: deviceId ? { deviceId: { exact: deviceId } } : true,
};

this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
```

`useVoice.startRecording()` creates one `WavRecorder` instance per hook lifecycle and calls `WavRecorder.start(selectedAudioDevice)`. The recorder requests microphone access, creates an `AudioContext`, creates a `ScriptProcessorNode`, and buffers channel 0 samples as `Float32Array` chunks.

### 7. WavRecorder Stops, Cleans Up, and Encodes WAV
File: `frontend/src/hooks/useVoice.ts` (Hook: `useVoice`, Function: `stopRecording`)
File: `frontend/src/utils/wavRecorder.ts` (Class: `WavRecorder`, Methods: `stop`, `createWavBlob`, `downsample`, `encodeWAV`)

```typescript
// FILE: frontend/src/hooks/useVoice.ts (Function: stopRecording)
setIsRecording(false);
const blob = await recorderRef.current.stop();

const duration = Date.now() - voiceStartTimeRef.current;
if (duration < 400) {
  console.log('[VOICE] Recording too short, ignoring');
  return;
}
```

```typescript
// FILE: frontend/src/utils/wavRecorder.ts (Methods: createWavBlob, downsample, encodeWAV)
const inputSampleRate = this.audioContext?.sampleRate || 44100;
const downsampled = this.downsample(result, inputSampleRate, this.targetSampleRate);
const dataview = this.encodeWAV(downsampled, this.targetSampleRate);
return new Blob([dataview.buffer as ArrayBuffer], { type: 'audio/wav' });
```

`stop()` disconnects the source and processor, stops every media stream track, closes the `AudioContext`, and creates a WAV blob. `createWavBlob()` flattens buffered samples, downsamples to 16000 Hz, and writes a RIFF/WAVE header plus 16-bit signed PCM sample data. `useVoice.stopRecording()` ignores recordings shorter than 400 ms.

### 8. Frontend Sends the WAV Through Socket.IO
File: `frontend/src/hooks/useVoice.ts` (Hook: `useVoice`, Function: `stopRecording`, Socket event: `process_voice`)
File: `backend/server.js` (Socket.IO option: `maxHttpBufferSize`)

```typescript
// FILE: frontend/src/hooks/useVoice.ts (Socket event: process_voice)
const reader = new FileReader();
reader.onload = () => {
  const arrayBuffer = reader.result as ArrayBuffer;
  setIsProcessingVoice(true);
  if (socket) {
    socket.emit('process_voice', { audioBuffer: arrayBuffer }, (res: { text: string | null }) => {
      setIsProcessingVoice(false);
      if (res.text) callback(res.text);
    });
  }
};
reader.readAsArrayBuffer(blob);
```

The hook converts the WAV blob to an `ArrayBuffer` and emits `process_voice`. `ChatInput` does not pass `sessionId` through this path, so the backend uses the fallback `voice` temp directory for recordings started from the mic button. Socket.IO is configured with `maxHttpBufferSize: 100 * 1024 * 1024` in `backend/server.js`.

### 9. Backend Routes process_voice to the STT Service
File: `backend/sockets/voiceHandlers.js` (Function: `registerVoiceHandlers`, Socket event: `process_voice`)
File: `backend/voiceService.js` (Function: `transcribeAudio`)

```javascript
// FILE: backend/sockets/voiceHandlers.js (Socket event: process_voice)
socket.on('process_voice', async ({ audioBuffer, sessionId }, callback) => {
  const text = await voice.transcribeAudio(audioBuffer, writeLog, sessionId);
  callback({ text });
});
```

`registerVoiceHandlers()` receives the binary payload and optional `sessionId`, calls `transcribeAudio()`, and always replies through the Socket.IO callback with `{ text }`. `text` is a string on success and `null` for disabled STT, missing audio, whisper errors, blank output, or caught exceptions.

### 10. Backend Writes a Temp WAV and Calls whisper-server
File: `backend/voiceService.js` (Function: `transcribeAudio`, Config key: `STT_PORT`)
File: `backend/services/attachmentVault.js` (Function: `getAttachmentsRoot`)

```javascript
// FILE: backend/voiceService.js (Function: transcribeAudio)
const dir = path.join(getAttachmentsRoot(), sessionId || 'voice');
if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
filePath = path.join(dir, `stt-${Date.now()}.wav`);
fs.writeFileSync(filePath, Buffer.from(audioBuffer));

const formData = new FormData();
formData.append('file', new Blob([fs.readFileSync(filePath)]), 'audio.wav');
formData.append('response_format', 'text');

const res = await fetch(`http://127.0.0.1:${STT_PORT}/inference`, {
  method: 'POST',
  body: formData
});
```

`transcribeAudio()` writes the received buffer to the attachment vault under `sessionId` or `voice`, posts a multipart form to whisper-server, trims the plain text response, and deletes the temporary WAV file in a `finally` block.

### 11. Frontend Inserts the Transcript
File: `frontend/src/hooks/useVoice.ts` (Hook: `useVoice`, Function: `stopRecording`)
File: `frontend/src/components/ChatInput/ChatInput.tsx` (Component: `ChatInput`, Handler: `onMicClick`)
File: `frontend/src/store/useInputStore.ts` (Store action: `setInput`)

```typescript
// FILE: frontend/src/components/ChatInput/ChatInput.tsx (Handler: onMicClick)
stopRecording((text) => setInput(activeSessionId || '', text));
```

The socket callback clears `isProcessingVoice`, and non-empty transcripts call the callback passed by `ChatInput`. The text lands in the same prompt store as typed input and follows the normal submit path when the user sends it.

## Architecture Diagram

```mermaid
flowchart TD
  ENV[.env: VOICE_STT_ENABLED, STT_PORT] --> VS[backend/voiceService.js]
  VS -->|startSTTServer| WSP[backend/whisper/whisper-server.exe]
  WSP --> MODEL[backend/whisper/ggml-small.bin]

  SI[backend/sockets/index.js] -->|voice_enabled| US[frontend/src/hooks/useSocket.ts]
  ACP[backend/services/acpClient.js performHandshake] -->|voice_enabled| US
  US --> STORE[useVoiceStore.isVoiceEnabled]

  STORE --> CI[ChatInput mic button]
  SETTINGS[SystemSettingsModal Audio tab] --> STORE
  MANAGER[useChatManager initial load] --> STORE
  CI -->|onMicClick| UV[useVoice startRecording/stopRecording]
  UV --> REC[WavRecorder]
  REC -->|getUserMedia + AudioContext| MIC[Browser microphone]
  REC -->|16 kHz mono PCM WAV Blob| UV
  UV -->|process_voice ArrayBuffer| VH[backend/sockets/voiceHandlers.js]
  VH -->|transcribeAudio| VS
  VS -->|temp WAV under attachment vault| TMP[stt timestamp WAV]
  VS -->|multipart POST /inference| WSP
  WSP -->|plain text| VS
  VS -->|delete temp file; return text/null| VH
  VH -->|callback { text }| UV
  UV --> INPUT[useInputStore.setInput]
```

## The Critical Contract: WAV Payload, Socket Callback, and Null-on-Failure

### WAV Format Contract
File: `frontend/src/utils/wavRecorder.ts` (Class: `WavRecorder`, Methods: `downsample`, `encodeWAV`)

The backend treats `audioBuffer` as a complete WAV file. The frontend must send a RIFF/WAVE payload with this shape:

```typescript
// Contract produced by WavRecorder.encodeWAV()
type VoiceWavPayload = {
  container: 'RIFF/WAVE';
  format: 'PCM';
  channels: 1;
  sampleRate: 16000;
  bitsPerSample: 16;
  endian: 'little';
};
```

`WavRecorder.encodeWAV()` writes `fmt ` and `data` chunks, stores mono PCM metadata, and clamps each float sample into signed 16-bit PCM. `WavRecorder.downsample()` averages source samples into the target sample rate before encoding.

### Socket Contract
File: `frontend/src/hooks/useVoice.ts` (Socket event: `process_voice`)
File: `backend/sockets/voiceHandlers.js` (Socket event: `process_voice`)

```typescript
// Client payload and callback shape
socket.emit(
  'process_voice',
  { audioBuffer: arrayBuffer },
  (res: { text: string | null }) => { /* update UI */ }
);
```

```javascript
// Server callback shape
callback({ text });
```

The callback payload always uses the `text` field. The frontend only inserts text when the field is truthy. Empty transcripts and failed transcriptions leave the prompt input unchanged.

### Backend Failure Contract
File: `backend/voiceService.js` (Function: `transcribeAudio`)

`transcribeAudio()` returns `null` when:
- `VOICE_STT_ENABLED` is not exactly `true`.
- `audioBuffer` is missing.
- whisper-server returns a non-OK HTTP status.
- `fetch()` throws.
- whisper-server returns only whitespace.
- any caught file, form, or HTTP operation throws.

The function deletes `filePath` in `finally` when the temporary file exists. Callers must treat `null` as a normal transcription result, not as an exception path.

## Configuration / Data Flow

### Environment and Runtime Files

| Config or File | Anchor | Current Behavior |
|---|---|---|
| `VOICE_STT_ENABLED` | `backend/voiceService.js` (Function: `isSTTEnabled`) | Enables server startup and `voice_enabled` when the value is exactly `true`. |
| `STT_PORT` | `backend/voiceService.js` (Constant: `STT_PORT`) | Controls the whisper-server port and `/inference` URL. Runtime fallback is `9877`. |
| `.env.example` | `.env.example` (Keys: `VOICE_STT_ENABLED`, `STT_PORT`) | Example config sets `VOICE_STT_ENABLED=false` and `STT_PORT=9777`. |
| `backend/whisper/whisper-server.exe` | `backend/voiceService.js` (Constant: `WHISPER_SERVER`) | Spawn target for local STT. |
| `backend/whisper/ggml-small.bin` | `backend/voiceService.js` (Constant: `WHISPER_MODEL`) | Model path passed with `-m`. |
| `backend/whisper/*.dll` | `backend/whisper/` | Runtime libraries loaded by the whisper executable. |

Effective endpoint selection is:

```text
process.env.STT_PORT if set
else backend/voiceService.js fallback 9877

POST http://127.0.0.1:<effective STT_PORT>/inference
```

### Frontend State Flow

```text
voice_enabled socket event
  -> useSocket handler
  -> useVoiceStore.setIsVoiceEnabled(enabled)
  -> ChatInput renders or hides mic button
```

```text
navigator.mediaDevices.enumerateDevices()
  -> audioinput entries only
  -> useVoiceStore.availableAudioDevices
  -> SystemSettingsModal Audio tab select
  -> useVoiceStore.setSelectedAudioDevice(deviceId)
  -> localStorage key selectedAudioDevice
  -> WavRecorder.start(deviceId)
```

### Recording and Transcription Flow

```text
ChatInput.onMicClick
  -> useVoice.startRecording()
  -> WavRecorder.start(selectedAudioDevice)
  -> browser audio chunks in recordingBuffer
  -> ChatInput.onMicClick while recording
  -> useVoice.stopRecording(callback)
  -> WavRecorder.stop()
  -> createWavBlob() -> downsample() -> encodeWAV()
  -> FileReader.readAsArrayBuffer(blob)
  -> socket.emit('process_voice', { audioBuffer }, callback)
  -> registerVoiceHandlers() -> transcribeAudio()
  -> temp stt-<timestamp>.wav file
  -> whisper-server /inference
  -> callback({ text })
  -> useInputStore.setInput(activeSessionId, text)
```

### Provider and Persistence Behavior

- Provider config is not involved.
- The transcript is plain text and enters the prompt box before submission.
- No voice-specific database table is used.
- Temporary WAV files are stored under `getAttachmentsRoot()` and removed by `transcribeAudio()` after the request finishes.
- ChatInput-originated recordings omit `sessionId`; direct `process_voice` callers can include `sessionId` to scope the temp directory.

## Component Reference

### Frontend

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Socket hydration | `frontend/src/hooks/useSocket.ts` | `useSocket`, socket event `voice_enabled`, `setIsVoiceEnabled` | Converts backend voice availability into Zustand state. |
| Chat bootstrap | `frontend/src/hooks/useChatManager.ts` | `useChatManager`, initial load callback `mockFetch`, `handleInitialLoad` | Enumerates audio input devices during initial load. |
| Voice hook | `frontend/src/hooks/useVoice.ts` | `useVoice`, `fetchAudioDevices`, `startRecording`, `stopRecording`, `recorderRef`, `voiceStartTimeRef`, `isMouseDownOnMicRef` | Owns recording lifecycle and `process_voice` emission. |
| Voice store | `frontend/src/store/useVoiceStore.ts` | `useVoiceStore`, `setIsRecording`, `setIsProcessingVoice`, `setIsVoiceEnabled`, `setAvailableAudioDevices`, `setSelectedAudioDevice`, `fetchAudioDevices` | Stores voice UI state and selected microphone. |
| WAV recorder | `frontend/src/utils/wavRecorder.ts` | `WavRecorder`, `start`, `stop`, `createWavBlob`, `downsample`, `encodeWAV`, `targetSampleRate` | Captures Web Audio chunks and produces the WAV payload. |
| Prompt UI | `frontend/src/components/ChatInput/ChatInput.tsx` | `ChatInput`, `onMicClick`, `isVoiceEnabled`, `isRecording`, `isProcessingVoice`, `setInput` | Renders the mic button and inserts transcripts into the prompt input. |
| Prompt styling | `frontend/src/components/ChatInput/ChatInput.css` | `.mic-btn.recording`, `.mic-btn.processing`, `recording-glow`, `processing-glow` | Shows recording and processing visual states. |
| Settings UI | `frontend/src/components/SystemSettingsModal.tsx` | `SystemSettingsModal`, `activeTab: 'audio'`, `fetchAudioDevices`, `setSelectedAudioDevice` | Lets the user refresh and select audio input devices. |

### Backend

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Server startup/shutdown | `backend/server.js` | `startSTTServer`, `shutdownServer`, Socket.IO option `maxHttpBufferSize` | Starts STT service, stops it during backend shutdown, and permits large socket payloads. |
| Socket connection | `backend/sockets/index.js` | `registerSocketHandlers`, socket event `voice_enabled`, `registerVoiceHandlers` | Advertises voice support and registers voice handlers. |
| Voice socket handler | `backend/sockets/voiceHandlers.js` | `registerVoiceHandlers`, socket event `process_voice` | Routes audio buffers to the STT service and replies with `{ text }`. |
| STT service | `backend/voiceService.js` | `isSTTEnabled`, `startSTTServer`, `stopSTTServer`, `transcribeAudio`, `WHISPER_SERVER`, `WHISPER_MODEL`, `STT_PORT` | Manages whisper-server lifecycle and transcription requests. |
| Attachment root | `backend/services/attachmentVault.js` | `getAttachmentsRoot` | Provides the base directory for temporary WAV files. |
| Provider handshake | `backend/services/acpClient.js` | `performHandshake`, socket event `voice_enabled` | Re-emits voice availability after provider readiness. |

### Configuration and Runtime Assets

| Area | File | Anchors | Purpose |
|---|---|---|---|
| Env example | `.env.example` | `VOICE_STT_ENABLED`, `STT_PORT` | Documents optional voice STT env keys. |
| Whisper binary | `backend/whisper/whisper-server.exe` | Spawn target `WHISPER_SERVER` | Local whisper.cpp HTTP server executable. |
| Whisper model | `backend/whisper/ggml-small.bin` | Model target `WHISPER_MODEL` | Local speech model passed to whisper-server. |
| Whisper DLLs | `backend/whisper/ggml-base.dll`, `backend/whisper/ggml-cpu.dll`, `backend/whisper/ggml.dll`, `backend/whisper/whisper.dll` | Runtime library files | Support files loaded by the Windows executable. |

## Gotchas & Important Notes

1. **Feature enablement is env-only**
   `isSTTEnabled()` checks only `process.env.VOICE_STT_ENABLED === 'true'`. The `voice_enabled` event can be true even if the microphone permission, whisper executable, model file, port, or DLLs are not healthy.

2. **Runtime port has two source values**
   `backend/voiceService.js` falls back to `9877` when `STT_PORT` is unset. `.env.example` sets `STT_PORT=9777`. The effective port is the environment value when present; debugging should inspect the loaded `.env` value and the `[VOICE] Starting whisper-server on port ...` log.

3. **ChatInput recordings do not include sessionId**
   `useVoice.stopRecording()` emits `{ audioBuffer }`. The backend supports `{ audioBuffer, sessionId }`, but the mic button path uses the fallback temp directory `voice` under `getAttachmentsRoot()`.

4. **Voice transcript replaces prompt input**
   `ChatInput.onMicClick` calls `setInput(activeSessionId || '', text)`. It does not append to existing text or preserve a cursor position.

5. **Null socket can leave processing state set**
   `useVoice.stopRecording()` sets `isProcessingVoice` to true inside `FileReader.onload`; the false transition is inside the `socket.emit` callback. If `socket` is null after the blob is read, `isProcessingVoice` remains true until another state transition changes it.

6. **Short recordings never reach the backend**
   `useVoice.stopRecording()` returns early when duration is under 400 ms. That path sets `isRecording` false and skips FileReader, `process_voice`, and `isProcessingVoice`.

7. **Device labels can differ by enumeration path**
   `useVoice.fetchAudioDevices()` and `useChatManager()` use `Default Microphone` for blank labels. `useVoiceStore.fetchAudioDevices()` uses `Unknown Microphone`. Tests cover the store fallback label.

8. **The recorder is one-shot per stop call**
   Audio chunks stay in browser memory until `stop()` flattens and encodes them. Long recordings increase memory usage and socket payload size; the backend accepts large socket payloads through `maxHttpBufferSize`, but the feature does not stream partial audio.

9. **whisper-server output logging is selective**
   `startSTTServer()` ignores stdout and writes stderr only when the message contains `error`. Port binding, model loading, and process exit debugging starts in `backend/voiceService.js` logs.

10. **Controlled backend shutdown stops whisper-server**
   `shutdownServer()` calls `stopSTTServer()` so backend watch restarts and normal process termination clear the module-level child process reference and send a kill signal to whisper-server.

11. **Temp file cleanup depends on process continuity**
   `transcribeAudio()` removes the temp WAV file in `finally`. A Node process exit during transcription can leave `stt-*.wav` files under the attachment vault.

## Unit Tests

### Frontend Tests

| File | Test Names | Coverage |
|---|---|---|
| `frontend/src/test/useVoice.test.ts` | `fetchAudioDevices updates store`; `startRecording calls WavRecorder.start and updates state`; `stopRecording processes voice if duration is sufficient`; `stopRecording calls WavRecorder.stop and emits process_voice` | Hook-level device discovery, recorder start, duration-gated stop, FileReader conversion, and `process_voice` emission. |
| `frontend/src/test/useVoiceStore.test.ts` | `updates recording and processing state`; `manages available audio devices`; `updates selected audio device and persists to localStorage`; `fetchAudioDevices updates state from navigator.mediaDevices`; `setIsVoiceEnabled updates state`; `fetchAudioDevices handles errors gracefully`; `fetchAudioDevices labels unknown devices` | Zustand state transitions, persistence key `selectedAudioDevice`, device filtering, enablement state, and error handling. |
| `frontend/src/test/wavRecorder.test.ts` | `downsamples buffer correctly`; `encodes WAV header correctly`; `stops recording and returns a blob` | Downsampling behavior, WAV header fields, and `audio/wav` blob creation. |
| `frontend/src/test/useSocket.test.ts` | `handles "voice_enabled" event` | Socket-to-store enablement contract. |
| `frontend/src/test/SystemSettingsModal.test.tsx` | `renders and switches tabs` | Audio tab rendering with `Audio Input` and stored microphone choices. |
| `frontend/src/test/ChatInput.test.tsx` | `automatically focuses the textarea when enabled` and general ChatInput tests using `isVoiceEnabled: true` test setup | ChatInput renders with voice state seeded; there is no dedicated named test that clicks the mic button. |

### Backend Tests

| File | Test Names | Coverage |
|---|---|---|
| `backend/test/voiceService.test.js` | `returns null if no audio buffer is provided`; `returns null if STT is not enabled`; `isSTTEnabled returns true when env var is true`; `isSTTEnabled returns false when env var is not true`; `startSTTServer does nothing when STT is disabled`; `startSTTServer starts when STT is enabled`; `transcribeAudio returns result or null on error` | Feature flag, empty input, startup guard, broad transcription behavior. |
| `backend/test/voiceService.test.js` | `transcribeAudio catches fetch error and returns null`; `transcribeAudio returns null when sessionId is undefined`; `startSTTServer registers exit handler on server process`; `exit handler body logs and clears serverProcess`; `stopSTTServer kills an active whisper-server process once`; `transcribeAudio returns transcribed text on successful whisper-server response`; `transcribeAudio returns null when server response text is blank`; `transcribeAudio returns null and logs error when server returns non-ok status` | Fetch failures, fallback `voice` temp directory, process exit handler, controlled stop, successful text trimming, blank output, and HTTP error handling. |
| `backend/test/voiceHandlers.test.js` | `should call transcribeAudio and return text` | `process_voice` socket handler callback shape. |
| `backend/test/coverage-boost.test.js` | server import coverage with `startSTTServer` mocked | Confirms server startup imports without launching the real STT process in that test path. |

### Test Commands

```bash
# Backend voice tests
cd backend && npx vitest run test/voiceService.test.js test/voiceHandlers.test.js

# Frontend voice tests
cd frontend && npx vitest run src/test/useVoice.test.ts src/test/useVoiceStore.test.ts src/test/wavRecorder.test.ts src/test/useSocket.test.ts src/test/SystemSettingsModal.test.tsx src/test/ChatInput.test.tsx
```

## How to Use This Guide

### For Implementing or Extending This Feature

1. Start at `frontend/src/components/ChatInput/ChatInput.tsx` (Handler: `onMicClick`) to understand when recording starts and where transcript text lands.
2. Follow `frontend/src/hooks/useVoice.ts` (Functions: `startRecording`, `stopRecording`) before changing socket payloads, processing state, or duration gating.
3. Follow `frontend/src/utils/wavRecorder.ts` (Methods: `downsample`, `encodeWAV`) before changing sample rate, channels, bit depth, or recording APIs.
4. Follow `backend/sockets/voiceHandlers.js` (Socket event: `process_voice`) before changing the callback contract.
5. Follow `backend/voiceService.js` (Functions: `startSTTServer`, `stopSTTServer`, `transcribeAudio`) before changing whisper-server startup/shutdown, temp file handling, endpoint shape, or null/error behavior.
6. Update the tests listed in the Unit Tests section when changing state keys, socket payloads, WAV format, or backend STT behavior.

### For Debugging This Feature

1. If the mic button is hidden, check `backend/sockets/index.js` and `frontend/src/hooks/useSocket.ts` for the `voice_enabled` event, then check `VOICE_STT_ENABLED` in the loaded `.env`.
2. If the mic button appears but transcription fails, check `backend/voiceService.js` logs for whisper-server startup, `/inference` fetch errors, and `[VOICE ERR]` messages.
3. If microphone selection is wrong, check `useVoiceStore.selectedAudioDevice`, localStorage key `selectedAudioDevice`, and `SystemSettingsModal` Audio tab state.
4. If no socket request is sent, check `useVoice.stopRecording()` duration gating and `FileReader.onload` execution.
5. If whisper-server receives invalid audio, inspect `WavRecorder.encodeWAV()` and run `frontend/src/test/wavRecorder.test.ts`.
6. If temporary files accumulate, inspect `transcribeAudio()` cleanup and the attachment vault directory returned by `getAttachmentsRoot()`.
7. If the transcript appears in the wrong input state, inspect `ChatInput.onMicClick` and `useInputStore.setInput(activeSessionId || '', text)`.

## Summary

- Voice-to-text is an optional, provider-independent path from microphone recording to prompt text insertion.
- Backend enablement comes from `VOICE_STT_ENABLED`; runtime endpoint selection comes from `STT_PORT` or the `9877` fallback in `backend/voiceService.js`, and controlled backend shutdown stops the whisper-server child process.
- The browser recorder must produce 16 kHz mono 16-bit PCM WAV data.
- `process_voice` carries `{ audioBuffer }` from the frontend and replies with `{ text: string | null }`.
- `transcribeAudio()` treats failure as `null`, logs errors, and cleans up the temp WAV file when the process remains alive.
- The ChatInput mic path replaces the active prompt text with the transcript.
- Tests cover the hook, store, WAV encoder, socket enablement, System Settings audio tab, STT service, and voice socket handler.
