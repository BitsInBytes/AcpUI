# Feature Doc — Voice-to-Text System

Real-time speech-to-text transcription using whisper.cpp, enabling users to compose prompts via microphone input. Integrates with the Chat Input component to insert transcribed text directly into the textarea.

---

## Overview

### What It Does
- **Microphone input** — Captures audio from selected audio device via Web Audio API (getUserMedia)
- **Local WAV recording** — Frontend records audio to WAV format (16kHz mono PCM) without sending to server
- **whisper-server process** — Backend spawns `whisper-server.exe` with `ggml-small.bin` model on dedicated port (default 9877)
- **Audio transcription** — Backend sends recorded WAV to whisper-server HTTP endpoint for real-time inference
- **Minimal latency** — Local model inference (~1-3 sec for typical input) vs cloud API calls
- **Device selection** — User chooses microphone via System Settings Audio tab; persisted in localStorage
- **UI feedback** — Mic button shows recording state and processing spinner; disable prevents interaction during warming up

### Why This Matters
- **Hands-free input** — Users can record prompts without typing
- **Local processing** — Audio never leaves user's machine; no cloud API dependency or costs
- **Privacy-first** — Whisper model runs locally; recording is temporary (deleted after transcription)
- **Keyboard-free workflow** — Natural for mobile or dictation-style interaction
- **Accessibility** — Voice input helps users with limited keyboard accessibility

---

## How It Works — End-to-End Flow

### 1. Frontend Detects Voice Enabled
**File:** `frontend/src/hooks/useSocket.ts` (socket event handler)

```typescript
socket.on('voice_enabled', ({ enabled }) => {
  useVoiceStore.setState({ isVoiceEnabled: enabled });
});
```

On socket connect, backend emits `voice_enabled` event. Frontend sets `isVoiceEnabled` flag in Zustand store. If `true`, the mic button appears in ChatInput (Lines 245-254 of ChatInput.tsx).

### 2. User Clicks Mic Button to Start Recording
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 165-171)

```typescript
const onMicClick = () => {
  if (isRecording) {
    stopRecording((text) => setInput(activeSessionId || '', text));  // LINE 167
  } else {
    startRecording();  // LINE 169
  }
};
```

Clicking the mic button calls `startRecording()` (from `useVoice` hook) or `stopRecording()` if already recording.

### 1. Audio Capture (WavRecorder)
**File:** `frontend/src/hooks/useVoice.ts` (Function: `useVoice`, Lines 36-47; Lines 49-77)

The `useVoice` hook manages the `WavRecorder` instance. It handles starting and stopping the recording, capturing the audio blob, and converting it to an `ArrayBuffer` for socket transmission.

```typescript
// FILE: frontend/src/hooks/useVoice.ts (Lines 36-47)
const startRecording = useCallback(async () => {
  // ... initializes WavRecorder and starts capture ...
}, [selectedAudioDevice, setIsRecording]);
```

1. WavRecorder instance is created (singleton per session)
2. Calls `WavRecorder.start(deviceId)` with selected audio device
3. Sets `isRecording = true` in Zustand
4. Records start timestamp for minimum duration check

### 4. WavRecorder Captures Audio via Web Audio API
**File:** `frontend/src/utils/wavRecorder.ts` (Lines 10-35)

```typescript
async start(deviceId?: string): Promise<void> {
  this.recordingBuffer = [];
  this.recordingLength = 0;

  const constraints: MediaStreamConstraints = {
    audio: deviceId ? { deviceId: { exact: deviceId } } : true,  // LINE 15
  };

  this.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);  // LINE 18
  this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();  // LINE 20
  
  this.source = this.audioContext.createMediaStreamSource(this.mediaStream);  // LINE 22
  this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);  // LINE 23

  this.processor.onaudioprocess = (e) => {
    const inputData = e.inputBuffer.getChannelData(0);  // LINE 26
    const float32Array = new Float32Array(inputData.length);
    float32Array.set(inputData);
    this.recordingBuffer.push(float32Array);  // LINE 29
    this.recordingLength += float32Array.length;  // LINE 30
  };

  this.source.connect(this.processor);  // LINE 33
  this.processor.connect(this.audioContext.destination);  // LINE 34
}
```

1. Requests microphone access with optional deviceId constraint (Line 15)
2. Creates AudioContext and connects source → processor (Lines 20-23)
3. `onaudioprocess` callback accumulates audio chunks (Lines 25-31)
4. Processor buffers are connected to destination for monitoring (optional)

### 5. User Clicks Mic Button Again to Stop Recording
**File:** `frontend/src/hooks/useVoice.ts` (Lines 49-77)

```typescript
const stopRecording = useCallback(async (callback: (text: string) => void) => {
  if (!recorderRef.current) return;
  try {
    setIsRecording(false);  // LINE 52
    const blob = await recorderRef.current.stop();  // LINE 53
    
    const duration = Date.now() - voiceStartTimeRef.current;  // LINE 55
    if (duration < 400) {
      console.log('[VOICE] Recording too short, ignoring');
      return;  // LINE 58
    }

    const reader = new FileReader();  // LINE 61
    reader.onload = () => {
      const arrayBuffer = reader.result as ArrayBuffer;  // LINE 63
      setIsProcessingVoice(true);  // LINE 64
      if (socket) {
        socket.emit('process_voice', { audioBuffer: arrayBuffer }, (res: { text: string | null }) => {  // LINE 66
          setIsProcessingVoice(false);
          if (res.text) callback(res.text);  // LINE 68
        });
      }
    };
    reader.readAsArrayBuffer(blob);  // LINE 72
  } catch (e) {
    console.error('Failed to stop recording:', e);
    setIsProcessingVoice(false);
  }
}, [socket, setIsRecording, setIsProcessingVoice]);
```

1. Calls `WavRecorder.stop()` which returns Blob (Line 53)
2. Checks minimum duration (400ms) to avoid accidental clicks (Lines 55-58)
3. Reads blob as ArrayBuffer via FileReader (Lines 61-72)
4. Emits `process_voice` socket event with audioBuffer (Line 66)
5. On response, calls callback with transcribed text (Line 68)

### 6. WavRecorder Converts Audio Buffers to WAV Blob
**File:** `frontend/src/utils/wavRecorder.ts` (Lines 37-79)

```typescript
async stop(): Promise<Blob> {
  return new Promise((resolve) => {
    if (this.processor && this.source) {
      this.source.disconnect();  // LINE 40
      this.processor.disconnect();  // LINE 41
    }

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach((track) => track.stop());  // LINE 45
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close().then(() => {
        resolve(this.createWavBlob());  // LINE 50
      });
    } else {
      resolve(this.createWavBlob());  // LINE 53
    }
  });
}
```

1. Disconnects audio nodes (Lines 40-41)
2. Stops media stream tracks (stops microphone) (Line 45)
3. Closes AudioContext (Line 49)
4. Creates WAV blob from buffered audio (Lines 50, 53)

### 7. WavRecorder Downsamples and Encodes WAV
**File:** `frontend/src/utils/wavRecorder.ts` (Lines 58-79, 81-102, 104-135)

```typescript
private createWavBlob(): Blob {
  if (this.recordingLength === 0) {
    return new Blob([], { type: 'audio/wav' });
  }

  const inputSampleRate = this.audioContext?.sampleRate || 44100;  // LINE 63
  
  // Flatten buffer
  const result = new Float32Array(this.recordingLength);  // LINE 66
  let offset = 0;
  for (let i = 0; i < this.recordingBuffer.length; i++) {
    result.set(this.recordingBuffer[i], offset);
    offset += this.recordingBuffer[i].length;
  }

  // Downsample to 16kHz
  const downsampled = this.downsample(result, inputSampleRate, this.targetSampleRate);  // LINE 74
  
  // Encode to WAV
  const dataview = this.encodeWAV(downsampled, this.targetSampleRate);  // LINE 77
  return new Blob([dataview.buffer as ArrayBuffer], { type: 'audio/wav' });  // LINE 78
}

private downsample(buffer: Float32Array, sampleRate: number, targetSampleRate: number): Float32Array {
  if (sampleRate === targetSampleRate) {
    return buffer;
  }
  const ratio = sampleRate / targetSampleRate;  // LINE 85
  const newLength = Math.round(buffer.length / ratio);
  const result = new Float32Array(newLength);
  let offsetResult = 0;
  let offsetBuffer = 0;
  while (offsetResult < result.length) {
    const nextOffsetBuffer = Math.round((offsetResult + 1) * ratio);
    let accum = 0, count = 0;
    for (let i = offsetBuffer; i < nextOffsetBuffer && i < buffer.length; i++) {
      accum += buffer[i];
      count++;
    }
    result[offsetResult] = accum / count;  // Average-based resampling
    offsetResult++;
    offsetBuffer = nextOffsetBuffer;
  }
  return result;
}

private encodeWAV(samples: Float32Array, sampleRate: number): DataView {
  const buffer = new ArrayBuffer(44 + samples.length * 2);  // WAV header + PCM data
  const view = new DataView(buffer);

  // Write RIFF headers (Lines 114-126)
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);  // File size
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);  // Subchunk1Size
  view.setUint16(20, 1, true);  // AudioFormat (PCM)
  view.setUint16(22, 1, true);  // NumChannels (Mono)
  view.setUint32(24, sampleRate, true);  // SampleRate (16000)
  view.setUint32(28, sampleRate * 2, true);  // ByteRate
  view.setUint16(32, 2, true);  // BlockAlign
  view.setUint16(34, 16, true);  // BitsPerSample
  writeString(view, 36, 'data');
  view.setUint32(40, samples.length * 2, true);  // Subchunk2Size

  // Write PCM samples (Lines 128-132)
  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return view;
}
```

Process:
1. Flattens recorded buffers into single Float32Array (Lines 66-71)
2. Downsamples from system sample rate (44.1kHz/48kHz) to 16kHz (Line 74)
3. Downsampling uses average-based approach (simpler than linear interpolation)
4. Encodes downsampled audio to WAV format (Lines 104-135):
   - RIFF/WAVE header with PCM format metadata
   - Mono, 16-bit PCM samples at 16kHz
   - Samples are clipped to [-1, 1] and converted to 16-bit signed integers

### 8. Backend Receives process_voice Socket Event
**File:** `backend/sockets/voiceHandlers.js` (Lines 4-9)

```javascript
socket.on('process_voice', async ({ audioBuffer, sessionId }, callback) => {
  const text = await voice.transcribeAudio(audioBuffer, writeLog, sessionId);  // LINE 6
  callback({ text });  // LINE 7
});
```

Backend receives ArrayBuffer, passes to `transcribeAudio` for processing, returns result via callback.

### 9. Backend Writes Audio to Disk and Calls whisper-server
**File:** `backend/voiceService.js` (Lines 45-80)

```javascript
export async function transcribeAudio(audioBuffer, log, sessionId) {
  if (!isSTTEnabled()) return null;  // LINE 46
  if (!audioBuffer) { log('[VOICE] No audio buffer received.'); return null; }  // LINE 47

  let filePath = null;
  try {
    const dir = path.join(getAttachmentsRoot(), sessionId || 'voice');  // LINE 51
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });  // LINE 52
    filePath = path.join(dir, `stt-${Date.now()}.wav`);  // LINE 53
    fs.writeFileSync(filePath, Buffer.from(audioBuffer));  // LINE 54

    const formData = new FormData();  // LINE 56
    formData.append('file', new Blob([fs.readFileSync(filePath)]), 'audio.wav');  // LINE 57
    formData.append('response_format', 'text');  // LINE 58

    const res = await fetch(`http://127.0.0.1:${STT_PORT}/inference`, {  // LINE 60
      method: 'POST',
      body: formData
    });

    if (!res.ok) throw new Error(`whisper-server returned ${res.status}`);  // LINE 65
    const text = (await res.text()).trim();  // LINE 66

    log(`[VOICE] Transcribed: "${text}"`);  // LINE 68
    return text || null;  // LINE 69
  } catch (err) {
    log(`[VOICE ERR] ${err.message}`);  // LINE 71
    return null;  // LINE 72
  } finally {
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);  // LINE 76: Delete temp WAV
      } catch { /* ignore */ }
    }
  }
}
```

1. Checks if STT is enabled (Line 46)
2. Writes ArrayBuffer to temp WAV file on disk (Lines 51-54)
3. Creates FormData with file + response format (Lines 56-58)
4. POSTs to whisper-server HTTP endpoint (Line 60)
5. Reads response text (Line 66)
6. Deletes temp WAV file in finally block (Line 76)

### 10. whisper-server Processes Audio and Returns Transcript
**File:** `backend/voiceService.js` (Lines 14-43)

```javascript
export function startSTTServer() {
  if (!isSTTEnabled() || serverProcess) return;  // LINE 25

  writeLog(`[VOICE] Starting whisper-server on port ${STT_PORT}...`);  // LINE 27
  serverProcess = spawn(WHISPER_SERVER, [
    '-m', WHISPER_MODEL,  // ggml-small.bin (71MB model)
    '--port', String(STT_PORT),  // Default 9877
    '-t', '4'  // 4 threads
  ], { stdio: ['ignore', 'pipe', 'pipe'] });  // LINE 28-32

  serverProcess.stdout.on('data', () => {});  // LINE 34
  serverProcess.stderr.on('data', d => {
    const msg = d.toString().trim();
    if (msg && msg.includes('error')) writeLog(`[WHISPER] ${msg}`);
  });
  serverProcess.on('exit', (code) => {
    writeLog(`[VOICE] whisper-server exited with code ${code}`);
    serverProcess = null;
  });
}
```

On server startup (Lines 24-43):
1. Spawns `whisper-server.exe` with model path and port (Lines 28-32)
2. Passes model file `ggml-small.bin` (71MB, supports 99 languages, ~1-3s inference)
3. Uses 4 threads for processing
4. Keeps process alive; logs errors; handles exit

whisper-server:
- Listens on `http://127.0.0.1:9877/inference` (configurable port)
- Accepts multipart form with audio file
- Runs whisper inference (ggml-cpp optimized)
- Returns plain text transcript

### 11. Backend Returns Transcript via Socket Callback
**File:** `backend/sockets/voiceHandlers.js` (Lines 5-8)

```javascript
socket.on('process_voice', async ({ audioBuffer, sessionId }, callback) => {
  const text = await voice.transcribeAudio(audioBuffer, writeLog, sessionId);
  callback({ text });
});
```

Returns text (or null if failed) via callback to frontend.

### 12. Frontend Inserts Transcribed Text into Textarea
**File:** `frontend/src/hooks/useVoice.ts` (Line 68)

```typescript
if (res.text) callback(res.text);
```

The callback (from stopRecording) calls `setInput(activeSessionId, text)`, which updates the textarea with the transcribed text.

```typescript
// From ChatInput.tsx Line 167
stopRecording((text) => setInput(activeSessionId || '', text));
```

Text is inserted into Zustand useInputStore, which updates the textarea value (Lines 236-240 of ChatInput.tsx).

### 13. User Reviews and Submits
User can edit the transcribed text in the textarea and then click Send to submit the prompt (same as normal text input).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                   Frontend: Microphone Input                 │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  User clicks Mic button                                       │
│  ↓                                                            │
│  startRecording():                                            │
│  1. navigator.mediaDevices.getUserMedia(deviceId)            │
│  2. AudioContext + ScriptProcessor (4096-sample chunks)      │
│  3. Set isRecording = true                                   │
│  ↓                                                            │
│  Audio stream flows through processor onaudioprocess         │
│  chunks accumulate in recordingBuffer[]                       │
│  ↓                                                            │
│  User clicks Mic button again                                │
│  ↓                                                            │
│  stopRecording():                                            │
│  1. Disconnect source → processor                            │
│  2. Stop media stream (microphone off)                        │
│  3. Flatten buffers → downsample 44.1kHz → 16kHz             │
│  4. Encode to WAV (PCM, mono, 16-bit)                        │
│  5. FileReader.readAsArrayBuffer(blob)                       │
│  6. socket.emit('process_voice', {audioBuffer})              │
│  7. Set isProcessingVoice = true                             │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Socket: process_voice {audioBuffer}
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Backend: whisper-server Integration             │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  voiceHandlers.js receives process_voice                     │
│  ↓                                                            │
│  Call transcribeAudio(audioBuffer, sessionId)                │
│  ↓                                                            │
│  1. Check isSTTEnabled() (env VOICE_STT_ENABLED)             │
│  2. Write ArrayBuffer → temp WAV file                        │
│  3. FormData.append(file + response_format='text')           │
│  4. fetch POST http://127.0.0.1:9877/inference               │
│  5. Read response text                                        │
│  6. Delete temp WAV file                                      │
│  7. Return text (or null on error)                           │
│  ↓                                                            │
│  Callback({ text: '...' })                                   │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ HTTP: POST /inference (multipart)
                              ▼
┌─────────────────────────────────────────────────────────────┐
│         whisper-server.exe (ggml-cpp, local process)        │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Spawned at server startup by voiceService.startSTTServer()  │
│  Port: 9877 (STT_PORT env var)                              │
│  Model: ggml-small.bin (71MB, 99 languages)                 │
│  Threads: 4 (for inference optimization)                     │
│                                                               │
│  Receives: multipart form with audio.wav                     │
│  ↓                                                            │
│  Runs whisper inference (ggml-cpp optimized)                 │
│  ↓                                                            │
│  Returns: plain text transcript                              │
│                                                               │
└─────────────────────────────────────────────────────────────┘
                              │
                              │ Response: "Transcribed text..."
                              ▼
┌─────────────────────────────────────────────────────────────┐
│              Frontend: Insert Transcript                      │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  socket callback({ text })                                   │
│  ↓                                                            │
│  setIsProcessingVoice(false)                                 │
│  callback(text)  ← from useVoice stopRecording              │
│  ↓                                                            │
│  setInput(activeSessionId, text)                             │
│  ↓                                                            │
│  Zustand: useInputStore.inputs[sessionId] = text             │
│  ↓                                                            │
│  Textarea updates: value={input}                             │
│  ↓                                                            │
│  User reviews transcribed text, edits if needed              │
│  ↓                                                            │
│  User clicks Send → prompt submission (normal flow)          │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## The Critical Contract: Audio Format and Transcription Response

### Frontend Audio Encoding

```typescript
// Input: Float32 samples from AudioContext (any sample rate)
// Output: ArrayBuffer in WAV format with these specs:

interface WAVFormat {
  format: 'RIFF',  // Audio file format container
  codec: 'WAVE',   // PCM audio
  channels: 1,     // Mono
  sampleRate: 16000,  // 16kHz (required by whisper)
  bitDepth: 16,    // 16-bit signed PCM
  endian: 'little',
}
```

WAV encoding (Lines 104-135, wavRecorder.ts):
- **Header size**: 44 bytes (RIFF + WAVE + fmt + data chunks)
- **Sample encoding**: Each sample converted from Float32 [-1, 1] to Int16 [-32768, 32767]
- **File structure**: RIFF header → fmt chunk (metadata) → data chunk (PCM samples)

### Backend Transcription Request

```
POST http://127.0.0.1:9877/inference
Content-Type: multipart/form-data

file: (binary WAV data)
response_format: "text"
```

whisper-server API:
- Accepts multipart form with audio file
- `response_format` can be "text" (plain text), "json", "srt", "vtt"
- Returns transcribed text as plain text (or structured format if requested)

### Error Handling Contract

```typescript
// If STT disabled: return null
// If audioBuffer missing: log, return null
// If whisper-server unreachable: log, return null
// If whisper-server errors: catch, log, return null
// If temp WAV write fails: catch, log, return null
// On success: return trimmed text string (or null if empty)
```

---

## Configuration / Provider Support

Voice system requires **environment and file setup**, not provider-specific config:

### 1. **Environment Variables** (`.env`)

```bash
VOICE_STT_ENABLED=true          # Enable voice input (default: false)
STT_PORT=9877                   # whisper-server port (default: 9877)
```

### 2. **Required Files** (Manual Setup)

```
backend/whisper/
├── whisper-server.exe          # Pre-built binary (from whisper.cpp releases)
├── ggml-small.bin              # Model file (71MB, 99 languages)
└── required .dll files         # As needed by whisper-server.exe
```

**Download Links:**
- whisper-server.exe: https://github.com/ggerganov/whisper.cpp (releases page)
- ggml-small.bin: https://huggingface.co/ggerganov/whisper.cpp (models section)

### 3. **No Provider-Specific Configuration**

Voice system is **provider-agnostic**:
- Works with any ACP provider
- Audio device selection is global (not per-provider)
- Transcribed text goes directly to textarea (provider-independent)

---

## Data Flow / Rendering Pipeline

### Microphone Permission Request

```
User clicks Mic button
  │
  ▼ startRecording()
  │
  ├─ navigator.mediaDevices.getUserMedia({audio: {deviceId}})
  │
  ├─ Browser shows permission dialog:
  │  "Allow AcpUI to use your microphone?"
  │
  ├─ User clicks Allow
  │
  └─ MediaStream granted (or exception if denied)
     RecorderRef.current = new WavRecorder()
     recorderRef.start(deviceId)
```

### Audio Buffering and Recording

```
Audio flowing through Web Audio API:
  │
  ├─ MediaStreamAudioSourceNode (input)
  ├─ ScriptProcessorNode (4096-sample chunks)
  │  └─ onaudioprocess callback:
  │     1. Extract Float32 channel[0] data
  │     2. Copy to Float32Array
  │     3. Push to recordingBuffer[]
  │     4. Accumulate length
  ├─ Connect → AudioContext.destination (monitoring only)
  │
  └─ Repeat until stop() called
```

### Audio Encoding Pipeline

```
Raw Float32 buffers[] (44.1kHz or 48kHz, mixed sample rates)
  │
  ▼ Flatten: merge all chunks into single Float32Array
  │
  ▼ Downsample: 44.1kHz/48kHz → 16kHz (via averaging)
  │
  ▼ Encode to WAV:
  │  1. Create 44-byte header (RIFF/WAVE/fmt metadata)
  │  2. For each sample:
  │     - Clamp Float32 to [-1, 1]
  │     - Convert to Int16: s < 0 ? s*0x8000 : s*0x7FFF
  │     - Write 2 bytes (little-endian)
  │  3. Append all Int16 samples to header
  │
  ▼ Return Blob(buffer, {type: 'audio/wav'})
  │
  ▼ FileReader converts Blob → ArrayBuffer
  │
  └─ socket.emit('process_voice', {audioBuffer})
```

### Transcription Flow

```
Backend receives ArrayBuffer {audioBuffer}
  │
  ├─ Check: VOICE_STT_ENABLED env var?
  │  No → return null
  │
  ├─ Check: audioBuffer exists?
  │  No → return null
  │
  ├─ Write: Buffer.from(audioBuffer) → temp file {sessionId}/stt-{timestamp}.wav
  │
  ├─ POST: multipart form to http://127.0.0.1:9877/inference
  │
  ├─ whisper-server:
  │  1. Loads model (first request may take 2-3s)
  │  2. Runs inference (typically 1-2s for short audio)
  │  3. Returns plain text
  │
  ├─ Read response: text = res.text().trim()
  │
  ├─ Log: '[VOICE] Transcribed: "..."'
  │
  ├─ Finally: Delete temp WAV file
  │
  └─ Return text || null
```

### UI Feedback Flow

```
User interaction:
  │
  ├─ Click Mic: setIsRecording(true) → Mic icon shows active state
  │
  ├─ Recording: microphone indicator (green dot or pulsing icon)
  │
  ├─ Release/Click Stop: stopRecording() → disable mic during processing
  │
  ├─ setIsProcessingVoice(true) → Mic button shows spinner (Loader2 icon)
  │
  ├─ Waiting for whisper-server response (typically 1-3 seconds)
  │
  ├─ Socket callback arrives: setIsProcessingVoice(false)
  │
  ├─ setInput(sessionId, transcribedText)
  │
  └─ Textarea updates: shows transcribed text for user review/editing
```

---

## Component Reference

### Frontend Components & Hooks

| File | Component/Function | Lines | Purpose |
|------|-------------------|-------|---------|
| `frontend/src/hooks/useVoice.ts` | `useVoice` | 6-91 | Voice recording lifecycle; requests device list; starts/stops recording; emits process_voice socket event |
| `frontend/src/hooks/useVoice.ts` | `fetchAudioDevices` | 20-34 | Enumerates audio input devices via mediaDevices API |
| `frontend/src/hooks/useVoice.ts` | `startRecording` | 36-47 | Initializes WavRecorder; calls start(deviceId); sets isRecording |
| `frontend/src/hooks/useVoice.ts` | `stopRecording` | 49-77 | Stops WavRecorder; validates duration; reads blob as ArrayBuffer; emits socket event |
| `frontend/src/store/useVoiceStore.ts` | `useVoiceStore` | 24-51 | Zustand store: isRecording, isProcessingVoice, availableAudioDevices, selectedAudioDevice |
| `frontend/src/utils/wavRecorder.ts` | `WavRecorder` class | 1-137 | Web Audio API integration; captures microphone; downsamples; encodes WAV |
| `frontend/src/utils/wavRecorder.ts` | `start()` | 10-35 | Requests getUserMedia; sets up AudioContext + ScriptProcessor |
| `frontend/src/utils/wavRecorder.ts` | `stop()` | 37-56 | Disconnects nodes; stops tracks; creates WAV blob |
| `frontend/src/utils/wavRecorder.ts` | `createWavBlob()` | 58-79 | Flattens buffers; downsamples; calls encodeWAV |
| `frontend/src/utils/wavRecorder.ts` | `downsample()` | 81-102 | Resamples audio from system rate to 16kHz (averaging) |
| `frontend/src/utils/wavRecorder.ts` | `encodeWAV()` | 104-135 | Encodes downsampled audio to WAV format (RIFF header + PCM samples) |
| `frontend/src/components/ChatInput/ChatInput.tsx` | Mic button | 245-255 | Calls onMicClick; shows recording/processing state |
| `frontend/src/components/SystemSettingsModal.tsx` | Audio tab | 104-127 | Audio device selection dropdown; refresh button; device enumeration |

### Backend Services & Handlers

| File | Function | Lines | Purpose |
|------|----------|-------|---------|
| `backend/voiceService.js` | `isSTTEnabled()` | 20-22 | Checks VOICE_STT_ENABLED env var |
| `backend/voiceService.js` | `startSTTServer()` | 24-43 | Spawns whisper-server.exe with model + port; logs errors; handles exit |
| `backend/voiceService.js` | `transcribeAudio()` | 45-80 | Writes audio to temp file; POSTs to whisper-server; deletes temp file; returns text |
| `backend/sockets/voiceHandlers.js` | `process_voice` handler | 5-8 | Receives audioBuffer; calls transcribeAudio; returns text via callback |
| `backend/server.js` | Initialization | Line 95 | Calls startSTTServer() on app startup |

### Socket Events

| Event | Direction | Payload | Purpose |
|-------|-----------|---------|---------|
| `voice_enabled` | Server → Client | `{enabled: boolean}` | Notifies UI if STT is available |
| `process_voice` | Client → Server | `{audioBuffer: ArrayBuffer, sessionId?: string}` | Requests transcription |
| (callback) | Server → Client | `{text: string \| null}` | Returns transcribed text |

---

## Gotchas & Important Notes

### 1. **whisper-server Must Be Running Before Voice is Used**
- **Problem:** If user clicks Mic before whisper-server starts, request times out.
- **Why:** `startSTTServer()` is called at app startup, but initialization takes ~1-2s.
- **Mitigation:** UI disables Mic button until `voice_enabled` event arrives. Consider checking server health.

### 2. **First Inference Request Takes 2-3 Seconds**
- **Problem:** First voice query is slow (whisper model loading into memory).
- **Why:** ggml-small.bin (71MB) is loaded on first inference request.
- **Mitigation:** Model stays in memory; subsequent requests are faster (~1-2s).

### 3. **16kHz Sample Rate is Required**
- **Problem:** If downsampling logic breaks, audio quality degrades or fails to transcribe.
- **Why:** whisper.cpp is optimized for 16kHz; other rates not supported.
- **Verification:** Check audio buffer length vs sample rate; downsampling ratio (44100 / 16000 = 2.75).

### 4. **Minimum Duration Check (400ms) Can Prevent Legitimate Short Recordings**
- **Problem:** User accidentally clicks Mic twice quickly; transcription is skipped silently.
- **Why:** 400ms check prevents noise/click captures (Lines 56-58, useVoice.ts).
- **Tunable:** Adjust duration threshold in stopRecording if needed.

### 5. **Audio Stays in Memory During Processing**
- **Problem:** Large audio files (5+ minutes) consume significant browser memory.
- **Why:** Float32Array buffers accumulate; no streaming compression.
- **Limitation:** Typical use case (10-30 sec) = ~320KB-960KB in memory. Acceptable for local browser.

### 6. **No Streaming Transcription**
- **Problem:** User must wait for entire recording to finish before transcription starts.
- **Why:** WAV encoding happens after recording stops; one-shot POST to whisper-server.
- **Alternative:** Could implement streaming via chunked requests (not implemented).

### 7. **Temp WAV Files Can Accumulate If Process Crashes**
- **Problem:** If Node.js crashes during transcribeAudio, temp WAV files aren't deleted.
- **Why:** Finally block (Line 73-78) may not execute if process dies.
- **Mitigation:** Periodic cleanup of `{attachmentsRoot}/voice/stt-*.wav` files.

### 8. **Device Permissions Are Permanent Per Site (Browser Policy)**
- **Problem:** Once user grants microphone access, they see no more prompts (good for UX, bad if they want to revoke).
- **Why:** Browser caches permission decisions in IndexedDB/site data.
- **Recovery:** User can revoke via browser settings → Privacy → Microphone.

### 9. **Audio Context May Fail in Private Browsing / Incognito**
- **Problem:** Some browsers (Safari) block getUserMedia in private mode.
- **Why:** Privacy policy: no access to hardware in private sessions.
- **Detection:** Try/catch handles exception; isRecording stays false; user sees no feedback.

### 10. **No Feedback if whisper-server Exits Unexpectedly**
- **Problem:** If whisper-server crashes (e.g., memory pressure), user gets null result silently.
- **Why:** `transcribeAudio` catches errors; logs to backend; returns null; UI shows empty transcript.
- **Debugging:** Check server logs for whisper process exit code. Restart backend if needed.

---

## Unit Tests

### Frontend Tests

| Test File | Test Names | Location | Coverage |
|-----------|-----------|----------|----------|
| `frontend/src/test/useVoice.test.ts` | Recording lifecycle tests | ? | startRecording, stopRecording |
| `frontend/src/test/useVoice.test.ts` | Device enumeration tests | ? | fetchAudioDevices |
| `frontend/src/test/useVoiceStore.test.ts` | Store state tests | ? | isRecording, isProcessingVoice, devices |
| `frontend/src/test/wavRecorder.test.ts` | WAV encoding tests | ? | downsample, encodeWAV, createWavBlob |
| `frontend/src/test/wavRecorder.test.ts` | Downsampling tests | ? | downsample accuracy (44.1→16kHz) |

### Backend Tests

| Test File | Test Names | Location | Coverage |
|-----------|-----------|----------|----------|
| `backend/test/voiceService.test.js` | isSTTEnabled tests | ? | env var check |
| `backend/test/voiceService.test.js` | transcribeAudio tests | ? | audio processing, API calls |
| `backend/test/voiceHandlers.test.js` | process_voice handler | ? | socket event handling |

---

## How to Use This Guide

### For Implementing / Extending This Feature

1. **Understand audio capture** — Read Steps 2-7 (microphone → WAV encoding).
2. **Understand transcription** — Read Steps 8-11 (socket → whisper-server → response).
3. **Add custom audio processing** — Modify `wavRecorder.ts` downsample/encode logic if needed.
4. **Add streaming transcription** — Chunk the audio buffer; POST multiple requests to whisper-server with accumulated text.
5. **Support different models** — Change `WHISPER_MODEL` path in voiceService.js; models: tiny, base, small, medium, large.
6. **Change sample rate** — Modify `targetSampleRate` constant in wavRecorder.ts (default 16000); verify whisper-server supports it.
7. **Add real-time feedback** — Emit socket events during recording (e.g., audio level meter).

### For Debugging Issues with This Feature

1. **Mic button doesn't appear** — Check `voice_enabled` event. Verify `VOICE_STT_ENABLED=true` in .env. Check browser console for errors.
2. **Microphone permission denied** — User clicked "Block". Check browser settings → Privacy → Microphone. Request permission again.
3. **Recording doesn't start** — Check `getUserMedia` error in console. Verify device ID is valid. Try default device.
4. **No transcript returned** — Check whisper-server running: `netstat -an | find ":9877"` (Windows) or `lsof -i :9877` (Mac/Linux).
5. **"Recording too short" message** — Recording < 400ms. Increase minimum duration in useVoice.ts Line 56 if needed.
6. **Whisper-server crashes** — Check backend logs for exit code. Model file missing or corrupted? Restart backend.
7. **Transcript contains gibberish** — Audio quality poor? Increase model size (ggml-medium.bin, ggml-large.bin). Try different microphone.
8. **High latency (3+ seconds)** — First request loads model. Subsequent requests faster. Warm-up with dummy request if time-critical.

---

## Summary

The **Voice-to-Text System** enables users to record speech and have it transcribed locally via whisper.cpp, integrated seamlessly into the Chat Input component. Key points:

1. **Frontend recording**: Web Audio API captures microphone → buffers → downsamples 44.1kHz to 16kHz → encodes WAV.
2. **Socket transmission**: ArrayBuffer sent to backend via `process_voice` socket event.
3. **Local inference**: whisper-server.exe (spawned at app startup) processes audio via HTTP POST → returns text.
4. **Text insertion**: Transcribed text inserted into textarea for user review/editing before submission.
5. **Device selection**: User chooses microphone from System Settings Audio tab; persisted in localStorage.

**Critical Contract:** Audio must be 16kHz mono PCM WAV format. whisper-server API expects multipart form with file + `response_format=text`.

**Configuration:** Requires `VOICE_STT_ENABLED=true` env var + manual setup of whisper-server.exe and ggml-small.bin in `backend/whisper/` directory.

**Privacy-First:** All audio processing happens locally; no cloud API calls; temp files deleted after transcription.

This feature is provider-agnostic and optional (only enabled if `VOICE_STT_ENABLED=true`). Perfect for hands-free dictation or accessibility-focused workflows.
