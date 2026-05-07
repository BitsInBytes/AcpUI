# Feature Doc — Chat Input and Prompt Area

The footer-positioned input interface for composing and sending prompts, including file attachments, model selection, and context visibility. Supports textarea auto-expansion, image compression, slash command autocomplete, and per-session file uploads.

---

## Overview

### What It Does
- **Textarea input** — Multi-line expandable text area with keyboard shortcuts (Enter to send, Shift+Enter for newline)
- **File attachments** — Upload/paste files with visual thumbnails and removal buttons; images automatically compressed before sending to ACP
- **Model quick-select** — Footer dropdown showing provider-configured quick-access models with active state
- **Slash command autocomplete** — Dropdown menu for slash commands (e.g., `/compact`, `/context`, `/agent`) with arrow key navigation
- **Context progress bar** — Real-time percentage display of token usage (color-coded: green <50%, blue 50-60%, yellow 60-80%, red ≥80%)
- **Reasoning effort selector** — Animated footer toggle for models supporting reasoning levels (e.g., `low`, `medium`, `high`)
- **Canvas/Terminal toggles** — Quick-access pills to open canvas pane or spawn new terminals
- **Auto-scroll toggle pill** — Footer control to enable/disable chat viewport auto-scroll (detailed behavior documented in `[Feature Doc] - Auto-scroll System.md`)
- **Merge fork button** — Appears when chat is a fork; summarizes work and sends back to parent
- **Send/Cancel button** — Changes to cancel button during generation; disabled when no input/attachments or engine not ready

### Why This Matters
- Unified prompt submission point for all chat functionality
- Real-time visual feedback on model selection and context consumption
- File attachments enable multi-modal reasoning and context injection
- Auto-compression prevents image bloat while maintaining clarity
- Keyboard-driven workflow (slash commands, Enter to send) speeds up interaction
- Footer positioning maximizes chat message visibility (vs. header-positioned input)

---

## How It Works — End-to-End Flow

### 1. User Focuses Textarea or Clicks Chat Area
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 139-143)

```typescript
useEffect(() => {
  if (!isDisabled && textareaRef.current) {
    textareaRef.current.focus();  // LINE 141
  }
}, [isDisabled, activeSession?.id]);
```

When a session is selected or becomes available, the textarea auto-focuses. The `isDisabled` flag (Line 81) prevents focus when engine is not ready or session is warming up.

### 2. User Types "/" — Slash Command Autocomplete
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 104-112)

```typescript
const filteredCommands = useMemo(() => {
  const HIDDEN = ['/usage', '/reply', '/quit', '/plan', '/clear', '/knowledge', '/paste'];
  if (!input.startsWith('/')) return [];  // LINE 106
  const query = input.toLowerCase();
  return slashCommands
    .filter(c => !HIDDEN.includes(c.name))  // LINE 109
    .filter(c => c.name.toLowerCase().startsWith(query));  // LINE 110
}, [input, slashCommands]);
const showSlash = filteredCommands.length > 0 && input.startsWith('/') && !input.includes(' ');  // LINE 112
```

As user types `/`, the component:
1. Checks if input starts with `/` (Line 106)
2. Filters out hidden commands (Line 109)
3. Matches commands starting with the input prefix (Line 110)
4. Shows dropdown if matches exist and no space yet (Line 112)

The `slashCommands` array comes from two sources (Lines 39-45):
- Provider-specific commands (if active session has a provider)
- Global custom commands (from `configuration/commands.json`)

### 3. User Navigates Slash Dropdown with Arrow Keys
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 152-157)

```typescript
const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
  if (showSlash) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setSlashIndex(i => Math.min(i + 1, filteredCommands.length - 1)); return; }  // LINE 154
    if (e.key === 'ArrowUp') { e.preventDefault(); setSlashIndex(i => Math.max(i - 1, 0)); return; }  // LINE 155
    if (e.key === 'Tab' || (e.key === 'Enter' && slashIndex >= 0)) { e.preventDefault(); selectSlashCommand(filteredCommands[Math.max(slashIndex, 0)]); return; }  // LINE 156
    if (e.key === 'Escape') { e.preventDefault(); setInput(activeSessionId || '', ''); return; }  // LINE 157
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    handleSubmit(socket);  // LINE 161
  }
};
```

Arrow keys navigate the dropdown. Tab or Enter selects the command. Shift+Enter adds a newline (not intercepted). Plain Enter sends the message.

### 4. User Selects Slash Command
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 130-137)

```typescript
const selectSlashCommand = (cmd: typeof slashCommands[0]) => {
  const hasArgs = cmd.meta?.inputType === 'panel' || cmd.meta?.hint;
  setInput(activeSessionId || '', cmd.name + (hasArgs ? ' ' : ''));  // LINE 132
  if (!hasArgs) {
    setTimeout(() => handleSubmit(socket), 0);  // LINE 134
  }
  textareaRef.current?.focus();  // LINE 136
};
```

The command is inserted into the textarea. If it has arguments (metadata `inputType === 'panel'` or hint), the prompt waits for user input. Otherwise, it auto-submits.

### 5. User Pastes or Drags Image/File
**File:** `frontend/src/hooks/useFileUpload.ts` (Lines 55-79)

```typescript
const handlePaste = useCallback((e: ClipboardEvent) => {
  const clipboardData = e.clipboardData;
  if (!clipboardData) return;

  if (clipboardData.files && clipboardData.files.length > 0) {
    e.preventDefault();
    handleFileUpload(clipboardData.files);  // LINE 61
    return;
  }

  const items = clipboardData.items;
  const files: File[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === 'file') {
      const file = items[i].getAsFile();
      if (file) files.push(file);  // LINE 70
    }
  }
  
  if (files.length > 0) {
    e.preventDefault();
    e.stopPropagation();
    handleFileUpload(files);  // LINE 77
  }
}, [handleFileUpload]);

useEffect(() => {
  window.addEventListener('paste', handlePaste);  // LINE 82
  return () => window.removeEventListener('paste', handlePaste);
}, [handlePaste]);
```

The hook listens for paste events (Line 82). If clipboard has files, `handleFileUpload` is called.

### 6. handleFileUpload POSTs to Backend
**File:** `frontend/src/hooks/useFileUpload.ts` (Lines 11-53)

```typescript
const handleFileUpload = useCallback(async (files: FileList | File[] | null) => {
  if (!files) return;
  const currentSessionId = activeSessionIdRef.current;
  if (!currentSessionId) {
    alert('Please select a chat session before uploading files.');
    return;
  }
  
  const fileArray = Array.from(files);
  if (fileArray.length === 0) return;

  const formData = new FormData();
  for (const file of fileArray) {
    formData.append('files', file);  // LINE 24
  }

  try {
    const response = await fetch(`${BACKEND_URL}/upload/${currentSessionId}`, {  // LINE 28
      method: 'POST',
      body: formData
    });
    const result = await response.json();
    if (result.success) {
      // Read base64 data for image preview in chat bubbles
      const filesWithData = await Promise.all(result.files.map(async (f: { mimeType?: string }, i: number) => {
        if (fileArray[i] && (f.mimeType || '').startsWith('image/')) {
          const data = await new Promise<string>(resolve => {
            const reader = new FileReader();
            reader.onload = (e) => resolve((e.target?.result as string).split(',')[1]);  // LINE 39
            reader.readAsDataURL(fileArray[i]);
          });
          return { ...f, data };  // LINE 42
        }
        return f;
      }));
      setAttachments(currentSessionId, prev => [...prev, ...filesWithData]);  // LINE 46
    } else {
      alert(`Upload failed: ${result.error}`);
    }
  } catch (err: unknown) {
    alert(`Upload network error: ${(err as Error).message || 'Unknown error'}`);
  }
}, [activeSessionIdRef, setAttachments]);
```

Files are POSTed to `POST /upload/{sessionId}` (Line 28). Backend multer stores them on disk. For images, base64 data is read locally (Line 39) and stored in the Zustand input store so thumbnails can be displayed immediately (Line 46).

### 7. Backend Stores Files on Disk
**File:** `backend/services/attachmentVault.js` (Lines 14-40)

```javascript
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    const { uiId } = _req.params;
    const providerId = (_req?.query || {}).providerId || (_req?.body || {}).providerId || null;
    const sessionDir = path.join(getAttachmentsRoot(providerId), uiId);  // LINE 18
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    cb(null, sessionDir);
  },
  filename: (_req, file, cb) => {
    const safeName = file.originalname.replace(/[^a-z0-9.]/gi, '_').toLowerCase();  // LINE 23
    cb(null, `${Date.now()}_${safeName}`);  // LINE 24
  }
});

export function handleUpload(req, res) {
  const { uiId } = req.params;
  const files = req.files.map(f => ({
    name: f.originalname,
    path: f.path,
    size: f.size,
    mimeType: f.mimetype  // LINE 36
  }));
  writeLog(`[UPLOAD] ${files.length} file(s) added to session ${uiId}`);
  res.json({ success: true, files });
}
```

Files are stored in a session-specific directory (`{attachments_root}/{sessionId}/`) with a timestamp + sanitized filename. The response includes file metadata (Line 36).

### 8. FileTray Component Displays Attachments
**File:** `frontend/src/components/FileTray.tsx` (Lines 12-50)

```typescript
const FileTray: React.FC<FileTrayProps> = ({ attachments, onRemove }) => {
  const getIcon = (mime: string) => {
    if (mime.startsWith('image/')) return <FileImage size={14} />;  // LINE 14
    if (mime.includes('javascript') || mime.includes('typescript') || mime.includes('json') || mime.includes('sql')) return <FileCode size={14} />;
    return <FileText size={14} />;
  };

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  if (attachments.length === 0) return null;

  return (
    <div className="file-chips-wrapper">
      <AnimatePresence>
        {attachments.map((file, idx) => (
          <motion.div 
            key={`${file.name}-${idx}`}
            initial={{ opacity: 0, scale: 0.8, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.8, y: 10 }}
            className="file-chip"
          >
            <span className="file-chip-icon">{getIcon(file.mimeType || '')}</span>  // LINE 38
            <div className="file-chip-info">
              <span className="file-chip-name">{file.name}</span>  // LINE 40
              <span className="file-chip-size">{formatSize(file.size)}</span>  // LINE 41
            </div>
            <button className="file-chip-remove" onClick={() => onRemove(idx)}>
              <X size={12} />
            </button>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
};
```

Each attachment renders as an animated chip (motion.div) with icon (Line 38), name (Line 40), size (Line 41), and remove button.

### 9. User Clicks Send Button
**File:** `frontend/src/components/ChatInput/ChatInput.tsx` (Lines 193-198)

```typescript
<form
  onSubmit={(e) => {
    e.preventDefault();
    if (activeSession?.isTyping) handleCancel(socket);  // LINE 196
    else handleSubmit(socket);  // LINE 197
  }}
  className="input-form"
>
```

Form submission calls `handleSubmit` from `useChatStore`, which emits the `prompt` socket event.

### 10. handleSubmit Emits Socket Event with Attachments
**File:** `frontend/src/store/useChatStore.ts` (referenced via handleSubmit)

The `prompt` event includes attachments array:
```typescript
socket.emit('prompt', {
  providerId,
  uiId: sessionId,
  sessionId: acpSessionId,
  prompt,
  model,
  attachments  // From useInputStore
});
```

### 11. Backend promptHandlers Compresses Images
**File:** `backend/sockets/promptHandlers.js` (Lines 58-93)

```javascript
const acpPromptParts = [];

if (attachments && attachments.length > 0) {
  for (const file of attachments) {
    const isImage = (file.mimeType || '').startsWith('image/');  // LINE 60
    if (isImage) {
      const data = file.data || (file.path ? fs.readFileSync(file.path).toString('base64') : null);
      if (data) {
        try {
          const buf = Buffer.from(data, 'base64');
          const maxDim = runtime.provider.config.branding?.maxImageDimension || 1568;  // LINE 66
          const compressed = await sharp(buf)
            .resize({ width: maxDim, height: maxDim, fit: 'inside', withoutEnlargement: true })  // LINE 68
            .jpeg({ quality: 85 })  // LINE 69
            .toBuffer();  // LINE 70
          const origKB = Math.round(buf.length / 1024);
          const newKB = Math.round(compressed.length / 1024);
          writeLog(`[IMAGE] Compressed ${origKB}KB → ${newKB}KB`);
          acpPromptParts.push({ type: 'image', mimeType: 'image/jpeg', data: compressed.toString('base64') });  // LINE 74
        } catch (err) {
          writeLog(`[IMAGE] Compression failed, sending original: ${err.message}`);
          acpPromptParts.push({ type: 'image', mimeType: file.mimeType, data });
        }
      }
    } else if (file.data) {
      // Drag/drop file — decode base64 and include as text
      const text = Buffer.from(file.data, 'base64').toString('utf8');  // LINE 82
      acpPromptParts.push({ type: 'text', text: `--- File: ${file.name} ---\n${text}\n--- End File ---` });  // LINE 83
    } else if (file.path) {
      acpPromptParts.push({
        type: 'resource_link',
        uri: `file:///${file.path.replace(/\\/g, '/')}`,  // LINE 87
        name: file.name,
        mimeType: file.mimeType  // LINE 89
      });
    }
  }
}
```

For images (Line 60):
- Reads base64 data from attachment or disk (Line 62)
- Resizes to max dimension (default 1568px) using `inside` fit (Lines 66-68)
- Compresses to JPEG with quality 85 (Line 69)
- Logs compression ratio (Line 73)
- Sends compressed image to ACP (Line 74)

For text files with base64 data (Line 80):
- Decodes base64 and wraps in markdown (Lines 82-83)

For files with disk paths (Line 84):
- Sends as resource_link (Lines 87-89)

### 12. ACP Receives and Processes Multi-Part Prompt
**File:** `backend/sockets/promptHandlers.js` (Lines 112-115)

```javascript
const response = await acpClient.transport.sendRequest('session/prompt', {
  sessionId: sessionId,
  prompt: acpPromptParts  // Array of { type, mimeType, data/text/uri }
});
```

The ACP daemon receives the structured prompt parts and processes them according to its protocol.

### 13. ModelSelector Footer Updates on Model Change
**File:** `frontend/src/components/ChatInput/ModelSelector.tsx` (Lines 42-90)

```typescript
if (!activeSession) return null;
const modelName = getModelLabel(activeSession, brandingModels);  // LINE 43
const label = isCompacting ? `${modelName} (Compacting...)` : contextPct !== undefined ? `${modelName} (${Math.round(contextPct)}%)` : modelName;  // LINE 44
const modelChoices = getFooterModelChoices(activeSession, brandingModels);  // LINE 45
const hasQuickAccessModels = modelChoices.length > 0;  // LINE 46
const canOpenModelDropdown = !disabled && hasQuickAccessModels;  // LINE 47

return (
  <div className="model-indicator" ref={modelDropdownRef}>
    {onOpenSettings && (
      <button
        type="button"
        className="model-settings-btn"
        onClick={onOpenSettings}
        title="Open chat config"
        aria-label="Open chat config"
      >
        <Settings size={12} />
      </button>
    )}
    <span>Using </span>
    <button 
      type="button"
      onClick={() => canOpenModelDropdown && setIsModelDropdownOpen(!isModelDropdownOpen)}
      className={`model-indicator-btn ${!hasQuickAccessModels ? 'static' : ''}`}  // LINE 66
      disabled={disabled || !hasQuickAccessModels}
    >
      {label}  // LINE 69
    </button>

    {isModelDropdownOpen && hasQuickAccessModels && (
      <div className="model-dropdown-menu">
        {modelChoices.map(choice => (
          <button
            key={choice.selection}
            type="button"
            className={`model-dropdown-item ${isModelChoiceActive(activeSession, choice, brandingModels) ? 'active' : ''}`}  // LINE 78
            onClick={() => { onModelSelect(choice.selection); setIsModelDropdownOpen(false); }}  // LINE 79
            title={choice.description}
          >
            <span className="model-dropdown-item-name">{choice.name}</span>
            {choice.description && <span className="model-dropdown-item-desc">{choice.description}</span>}
          </button>
        ))}
      </div>
    )}
  </div>
);
```

The model selector displays:
- Current model name with context usage % (Line 44)
- Settings button to open advanced config (Lines 51-60)
- Dropdown toggle with quick-access models (Lines 63-70)
- Active state styling (Line 78)
- Selection triggers `onModelSelect` callback (Line 79)

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           Frontend: Chat Input                               │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                               │
│  ┌─ User Types "/" ──────────────────────────────────────────────────────┐ │
│  │  Textarea detects "/" prefix in input                                │ │
│  │  ↓                                                                    │ │
│  │  SlashDropdown filters commands (slashCommands array)                │ │
│  │  ↓                                                                    │ │
│  │  User navigates with arrow keys (slashIndex state)                   │ │
│  │  ↓                                                                    │ │
│  │  User presses Tab/Enter → selectSlashCommand() → setInput + maybe    │ │
│  │  auto-submit if no args needed                                       │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─ User Pastes/Uploads Image/File ─────────────────────────────────────┐ │
│  │  handlePaste() detects clipboard files                               │ │
│  │  OR fileInputRef.click() → file picker                               │ │
│  │  ↓                                                                    │ │
│  │  handleFileUpload(files) → fetch POST /upload/{sessionId}            │ │
│  │  ↓                                                                    │ │
│  │  Backend (multer) stores files on disk                               │ │
│  │  Returns: { files: [{name, path, size, mimeType}] }                │ │
│  │  ↓                                                                    │ │
│  │  Frontend reads base64 for images → FileTray displays chips          │ │
│  │  ↓                                                                    │ │
│  │  setAttachments(sessionId, [...]) → Zustand store                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─ User Selects Model from Footer ──────────────────────────────────────┐ │
│  │  ModelSelector shows current model + context %                       │ │
│  │  Click → isModelDropdownOpen = true                                  │ │
│  │  ↓                                                                    │ │
│  │  modelChoices = getFooterModelChoices(session, brandingModels)       │ │
│  │  ↓                                                                    │ │
│  │  User clicks choice → onModelSelect(modelId)                         │ │
│  │  ↓                                                                    │ │
│  │  handleActiveSessionModelChange(socket, modelId)                     │ │
│  │  → socket.emit('set_session_model', {model: modelId})               │ │
│  │  → Backend updates session.model + persists to DB                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
│  ┌─ User Clicks Send ────────────────────────────────────────────────────┐ │
│  │  Form submit → handleSubmit(socket)                                  │ │
│  │  ↓                                                                    │ │
│  │  socket.emit('prompt', {                                            │ │
│  │    providerId, sessionId, acpSessionId,                             │ │
│  │    prompt: input,                                                    │ │
│  │    model: session.model,                                             │ │
│  │    attachments: [...]  ← from useInputStore                         │ │
│  │  })                                                                   │ │
│  │  ↓                                                                    │ │
│  │  Clear input: setInput(sessionId, '')                                │ │
│  │  Clear attachments: setAttachments(sessionId, [])                    │ │
│  └────────────────────────────────────────────────────────────────────────┘ │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
                                  │
                                  │ socket.emit('prompt')
                                  ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Backend: promptHandlers.js                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│  1. Validate provider and session                                            │
│  2. For each attachment:                                                     │
│     - If image: sharp.resize() + jpeg(quality:85) → compress               │
│     - If text file: decode base64 + wrap in markdown                        │
│     - If path: create resource_link                                         │
│  3. Build acpPromptParts array (mixed type content)                         │
│  4. sendRequest('session/prompt', { prompt: acpPromptParts })              │
│  5. Router updates per-session streaming, emits 'token' events to UI        │
│                                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## The Critical Contract: Prompt Submission Structure

The `prompt` socket event must include structured data that the backend can route, compress, and send to the ACP daemon:

```typescript
interface PromptEvent {
  providerId: string;           // Required: identifies the provider/runtime
  uiId: string;                 // UI session ID (used for display/DB)
  sessionId: string;            // ACP session ID (used for routing to daemon)
  prompt: string | ContentBlock[];  // User input (string or pre-structured)
  model?: string;               // Optional model override
  attachments?: Attachment[];   // Optional: files to include
}

interface Attachment {
  name: string;                 // Original filename
  path?: string;                // Disk path (for resource_link)
  size: number;                 // File size in bytes
  mimeType?: string;            // MIME type (e.g., 'image/jpeg')
  type?: string;                // Legacy compat field
  data?: string;                // Base64-encoded file content
}
```

### Backend Processing Contract

The backend must:
1. **Validate provider** — throw error if providerId invalid
2. **Validate session** — check session exists in provider's acpClient.sessionMetadata
3. **Process attachments**:
   - **Images**: Extract base64 data, resize with sharp, convert to JPEG quality 85, re-encode to base64
   - **Text files**: Extract base64 data, decode to UTF-8, wrap in `--- File: name ---\n...\n--- End File ---`
   - **Paths**: Create resource_link with file:// URI
4. **Build acpPromptParts** — array of { type, mimeType, data/text/uri }
5. **Send to ACP** — `sendRequest('session/prompt', { sessionId, prompt: acpPromptParts })`
6. **Stream response** — emit 'token' events per stream chunk

### Image Compression Specifics

```
Input: Any image format (PNG, JPG, WebP, etc.)
Max Dimension: provider.config.branding?.maxImageDimension || 1568px
Resize Mode: { fit: 'inside', withoutEnlargement: true }
  → Fits image within max dimension without upscaling
Output Format: JPEG
Output Quality: 85 (balanced: high quality, reasonable file size)
Output Encoding: Base64 (for JSON transmission)
Log: '[IMAGE] Compressed {origKB}KB → {newKB}KB'
```

---

## Configuration / Provider Support

This feature requires **no provider-specific configuration** beyond standard branding:

1. **`provider.json`**:
   - `branding.maxImageDimension` (optional, default 1568) — max image dimension for compression

2. **`branding.json`**:
   - `models.quickAccess` (optional array) — quick-access model list shown in footer
   - `models.default` (optional string) — default model ID on session creation

3. **`user.json`**:
   - `attachmentDir` (optional, recommended) — where uploaded files are stored per session

### Example branding.json:
```json
{
  "models": {
    "default": "provider-model-standard",
    "quickAccess": [
      { "id": "provider-model-fast", "name": "Fast", "description": "Fast, cheap" },
      { "id": "provider-model-standard", "name": "Standard", "description": "Balanced" },
      { "id": "provider-model-capable", "name": "Capable", "description": "Powerful" }
    ]
  }
}
```

---

## Data Flow / Rendering Pipeline

### File Upload Pipeline

```
User pastes/drops image.png (2MB)
  │
  ▼
handleFileUpload(files)
  │
  ├─ FormData.append('files', file)
  ├─ fetch POST /upload/{sessionId}
  │
  ▼ (Backend: multer disk storage)
  │
  ├─ Validate sessionId
  ├─ Mkdir {attachmentsRoot}/{sessionId}/
  ├─ Save as {timestamp}_{sanitized_name}.png
  │
  ▼ Response: { success: true, files: [{name, path, size, mimeType}] }
  │
  ├─ For each file:
  │  └─ If mime=image/*:
  │     └─ FileReader.readAsDataURL() → base64
  │
  ▼ setAttachments(sessionId, [...prev, {...file, data: base64}])
  │
  ▼ Zustand: useInputStore.attachmentsMap[sessionId] = [...]
  │
  ▼ FileTray renders:
   └─ <file-chip name="image.png" size="1.8 MB" icon={FileImage} />
```

### Prompt Submission + Image Compression Pipeline

```
User types "Analyze this" + 1 attachment (image.png)
User clicks Send
  │
  ▼ handleSubmit(socket)
  │
  ├─ socket.emit('prompt', {
  │    providerId, sessionId, attachments: [{
  │      name: 'image.png',
  │      path: '{attachmentsRoot}/sess-123/1234567_image.png',
  │      size: 1843200,
  │      mimeType: 'image/png',
  │      data: 'iVBORw0KGg...'  // base64 from FileReader
  │    }]
  │  })
  │
  ▼ (Backend: promptHandlers.js, Line 58-79)
  │
  ├─ for (file of attachments):
  │    isImage = file.mimeType.startsWith('image/')
  │    │
  │    ├─ Read file.data (base64) → Buffer
  │    │
  │    ├─ sharp(buf)
  │    │   .resize(1568, 1568, { fit: 'inside', withoutEnlargement: true })
  │    │   .jpeg({ quality: 85 })
  │    │   .toBuffer()
  │    │
  │    └─ Log: '[IMAGE] Compressed 1843KB → 156KB'
  │       → compressed.toString('base64')
  │
  ▼ acpPromptParts.push({
      type: 'image',
      mimeType: 'image/jpeg',
      data: 'FFD8FF...'  // compressed base64
    })
  │
  ▼ acpPromptParts.push({
      type: 'text',
      text: 'Analyze this'
    })
  │
  ▼ acpClient.sendRequest('session/prompt', {
      sessionId: acp-123,
      prompt: [{type: 'image', ...}, {type: 'text', ...}]
    })
  │
  ▼ ACP daemon receives multi-part prompt, processes image
```

### Model Selection Pipeline

```
User clicks footer dropdown (currently shows "Using Sonnet (62%)")
  │
  ▼ setIsModelDropdownOpen(true)
  │
  ▼ ModelSelector re-renders:
  │
  ├─ getFooterModelChoices(session, brandingModels)
  │   → filters provider.branding.models.quickAccess
  │
  ├─ Renders list:
  │   [x] Model Fast  ← active
  │   [ ] Model Standard
  │   [ ] Model Capable
  │
  ▼ User clicks "Model Capable"
  │
  ├─ onModelSelect('provider-model-capable')
  │
  ├─ handleActiveSessionModelChange(socket, modelId)
  │
  ├─ socket.emit('set_session_model', {
  │    uiId: 'sess-123',
  │    acpSessionId: 'acp-123',
  │    model: 'provider-model-capable'
  │  })
  │
  ▼ (Backend: sessionHandlers.js)
  │
  ├─ session.model = 'provider-model-capable'
  ├─ Persist to SQLite
  ├─ Emit 'session_model_options' to UI
  │
  ▼ Frontend:
  │
  └─ ModelSelector re-renders:
     "Using Opus (62%)" ← updated label
```

---

## Component Reference

### Frontend Components

| File | Component/Function | Lines | Purpose |
|------|-------------------|-------|---------|
| `frontend/src/components/ChatInput/ChatInput.tsx` | `ChatInput` | 18-373 | Main footer input component; manages form, attachments, keyboard handlers |
| `frontend/src/components/ChatInput/ChatInput.tsx` | `handleKeyDown` | 152-163 | Slash command navigation; Enter to send; Shift+Enter for newline |
| `frontend/src/components/ChatInput/ChatInput.tsx` | `selectSlashCommand` | 130-137 | Insert command into textarea; auto-submit if no args |
| `frontend/src/components/ChatInput/ChatInput.tsx` | `handleMergeFork` | 86-102 | Emit merge_fork socket event |
| `frontend/src/components/ChatInput/ModelSelector.tsx` | `ModelSelector` | 19-92 | Footer model selector; dropdown menu; context % display |
| `frontend/src/components/ChatInput/SlashDropdown.tsx` | `SlashDropdown` | 11-30 | Dropdown menu for slash command autocomplete |
| `frontend/src/components/FileTray.tsx` | `FileTray` | 12-50 | Animated file chips; remove buttons; file icons & size |
| `frontend/src/hooks/useFileUpload.ts` | `useFileUpload` | 5-92 | File upload via HTTP POST; paste handler; base64 reading for images |
| `frontend/src/utils/modelOptions.ts` | `getModelLabel` | 45-54 | Get current model display name |
| `frontend/src/utils/modelOptions.ts` | `getFooterModelChoices` | 74-77 | Extract quick-access models from branding |
| `frontend/src/utils/modelOptions.ts` | `isModelChoiceActive` | 104-108 | Check if a model choice is currently selected |
| `frontend/src/store/useInputStore.ts` | `setInput` | N/A | Zustand action: update textarea input for a session |
| `frontend/src/store/useInputStore.ts` | `setAttachments` | N/A | Zustand action: update attachments array for a session |

### Backend Handlers

| File | Handler/Function | Lines | Purpose |
|------|------------------|-------|---------|
| `backend/sockets/promptHandlers.js` | `prompt` socket handler | 12-150 | Main prompt handler; image compression; ACP routing |
| `backend/sockets/promptHandlers.js` | Image compression logic | 60-79 | Resize with sharp; JPEG encode; log ratio |
| `backend/routes/upload.js` | `POST /upload/:uiId` | 6 | Express route; delegates to multer + handleUpload |
| `backend/services/attachmentVault.js` | `storage` (multer) | 14-26 | Disk storage configuration; sanitizes filenames |
| `backend/services/attachmentVault.js` | `handleUpload` | 30-40 | Returns file metadata; logs upload |

### Zustand Stores (Modified)

| Store | State | Purpose |
|-------|-------|---------|
| `useInputStore` | `inputs` | Textarea content per session |
| `useInputStore` | `attachmentsMap` | Attachments per session |
| `useUIStore` | `isModelDropdownOpen` | Footer model dropdown visibility |
| `useSystemStore` | `slashCommandsByProviderId` | Provider-specific slash commands |
| `useSystemStore` | `slashCommands` | Global slash commands |
| `useSystemStore` | `contextUsageBySession` | Token % per session (for display) |
| `useSessionLifecycleStore` | `sessions[].currentModelId` | Selected model per session |
| `useSessionLifecycleStore` | `sessions[].model` | Session's model ID (persisted) |

---

## Gotchas & Important Notes

### 1. **Textarea Auto-Height Relies on scrollHeight**
- **Problem:** Height calculation happens on every keystroke; can cause jank on fast typing.
- **Why:** `scrollHeight` is a computed property; accessing it triggers layout recalc.
- **Mitigation:** useEffect debounces height calculation (Line 145-150). Acceptable trade-off for simplicity.

### 2. **Image Compression Happens at Prompt Time, Not Upload Time**
- **Problem:** If image upload shows "original" size, but compressed size is sent to ACP, there's a mismatch.
- **Why:** Frontend doesn't know the max dimension from branding until send time; backend is source of truth.
- **Fine because:** File tray shows uploaded size; backend logs compression ratio; agent sees compressed image.

### 3. **Base64 Images in Memory Doubled During Compression**
- **Problem:** Backend loads base64, decodes to buffer, compresses, re-encodes—3x memory usage.
- **Why:** Sharp library expects Buffer; JSON-RPC requires base64 for transmission.
- **Mitigation:** Compression happens per-file in loop (not all at once); typical image << 5MB so negligible.

### 4. **Paste Handler Blocks Default Paste Behavior**
- **Problem:** If clipboard has mixed text + files, only files are uploaded; text is lost.
- **Why:** `handlePaste` calls `e.preventDefault()` if files are detected (Line 74, useFileUpload.ts).
- **Acceptable because:** User can paste text separately; files take precedence (expected UX).

### 5. **Slash Command State Resets on Any Input Change**
- **Problem:** `useEffect` on Line 114 sets `slashIndex = -1` whenever input changes.
- **Why:** Prevents stale index from persisting across deletions/edits.
- **Fine because:** User can immediately re-navigate with arrow keys; expected behavior.

### 6. **Model Dropdown Doesn't Close on Outside Click (Click Capture Used)**
- **File:** `ChatInput.tsx` (Lines 117-128)
- **Problem:** `pointerdown` listener closes dropdown on any click outside ref.
- **Why:** Needed because model button is inside ref; click on button would close instantly.
- **Result:** Click model button → opens. Click item → closes + selects. Click outside → closes.

### 7. **Disabled State Prevents Both Input and Submission**
- **Problem:** When engine warms up or session types, textarea is disabled and focused impossible.
- **Why:** `isDisabled` flag (Line 81) is true when `isEngineReady = false` or `activeSession.isTyping = true`.
- **Expected:** User sees placeholder text (e.g., "Engine warming up...") and can't interact until ready.

### 8. **Context Usage % May Not Exist for All Providers**
- **Problem:** `contextUsageBySession` is undefined if provider doesn't emit context updates.
- **Why:** Context reporting is optional per provider.
- **Fallback:** ModelSelector doesn't show % if undefined (Line 44, ModelSelector.tsx).

### 9. **Paste Handler Requires Clipboard API (Not Supported in Older Browsers)**
- **Problem:** ClipboardEvent.items or .files may be undefined in IE/old Safari.
- **Why:** Clipboard API added in later specs; fallback is missing.
- **Fine because:** App targets modern browsers (Windows 11, modern Electron); IE not supported.

### 10. **Attachments Cleared After Submit But Not on Cancel**
- **Problem:** If user clicks cancel during agent response, attachments stay in tray.
- **Why:** `handleCancel` cancels agent, not prompt submission (different control flow).
- **Expected behavior:** User can re-submit with same attachments, or manually clear them.

---

## Unit Tests

### Frontend Tests

| Test File | Test Names | Location | Coverage |
|-----------|-----------|----------|----------|
| `frontend/src/test/ChatInput.test.tsx` | `renders textarea` | ? | Basic rendering |
| `frontend/src/test/ChatInput.test.tsx` | `sends prompt on Enter` | ? | Keyboard submission |
| `frontend/src/test/ChatInput.test.tsx` | `cancels on cancel button` | ? | Cancel flow |
| `frontend/src/test/ChatInputExtended.test.tsx` | Slash command tests | ? | Autocomplete logic |
| `frontend/src/test/ChatInputExtended.test.tsx` | Model selector tests | ? | Model selection |
| `frontend/src/test/useInputStore.test.ts` | `setInput` | ? | Textarea state |
| `frontend/src/test/useInputStore.test.ts` | `setAttachments` | ? | Attachment state |

### Backend Tests

| Test File | Test Names | Location | Coverage |
|-----------|-----------|----------|----------|
| `backend/test/promptHandlers.test.js` | Image compression tests | ? | Sharp integration |
| `backend/test/promptHandlers.test.js` | Attachment inclusion tests | ? | Multi-part prompt |
| `backend/test/attachmentVault.test.js` | File upload tests | ? | Multer disk storage |
| `backend/test/attachmentVault.test.js` | Filename sanitization | ? | Path safety |

---

## How to Use This Guide

### For Implementing / Extending This Feature

1. **Understand attachment flow** — Read Steps 5-11 to grasp upload → compression → prompt pipeline.
2. **Add new input capability** — Modify ChatInput.tsx around the form (Lines 193-277). Follow existing patterns: check `isDisabled`, emit socket event.
3. **Support new file types** — Update promptHandlers.js (Lines 58-93) to handle new MIME types.
4. **Customize model selector** — Edit `provider.json` `branding.models.quickAccess` array to customize quick choices.
5. **Add custom slash commands** — Load from `configuration/commands.json`; they auto-appear in dropdown.
6. **Adjust image compression** — Set `branding.maxImageDimension` per provider; tweak quality in promptHandlers.js Line 69.

### For Debugging Issues with This Feature

1. **Textarea not focusing** — Check `isDisabled` condition (Line 81). Engine ready? Session warming up?
2. **Attachments not uploading** — Check browser console for fetch error. Verify `POST /upload/{sessionId}` endpoint. Check disk permissions on attachments directory.
3. **Images look blurry** — Quality 85 is default (Line 69, promptHandlers.js). Increase if needed; accept larger file size.
4. **Slash dropdown not appearing** — Check that filtered commands exist (Line 112). Hidden commands excluded (Line 109)?
5. **Model dropdown doesn't close** — Check pointerdown listener (Lines 117-128). Click outside? Click on model-dropdown-item?
6. **Context % not showing** — Verify provider emits context updates. Check `contextUsageBySession[acpSessionId]` in SystemStore.

---

## Summary

The **Chat Input and Prompt Area** is a unified footer component for composing and sending messages with attachments, model selection, and contextual feedback. Key points:

1. **Textarea input** with auto-height, keyboard shortcuts (Enter, Shift+Enter), focus management.
2. **Slash command autocomplete** (arrow keys, Tab/Enter to select) with hidden/visible filtering.
3. **File attachment system**: paste/drag → HTTP POST to backend → multer disk storage → base64 reading for images.
4. **Image compression**: sharp.resize(maxDim, fit:'inside') + JPEG quality 85 → ~90% size reduction.
5. **Model quick-select footer** dropdown from `branding.models.quickAccess`, shows context usage %, disabled when loading.
6. **Reasoning effort selector** (animated) for models supporting tuning.
7. **Canvas/Terminal toggles** and merge-fork button (contextual).

**Critical Contract:** Prompt submission includes structured attachments array; backend must handle image compression before sending to ACP. Model selection is session-scoped and persisted to DB.

**Provider Agnostic:** Feature requires only optional `branding.maxImageDimension` config. Slash commands and model choices come from provider config.

This feature enables fast, keyboard-driven multi-modal interaction while maintaining compatibility across all ACP providers.
