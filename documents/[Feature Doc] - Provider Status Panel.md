# Feature Doc — Provider Status Panel

**The ProviderStatusPanel is a real-time status display that renders provider metrics (quota, spend, health indicators) emitted by AI provider daemons. It has two surfaces: a compact summary card shown at the bottom of each provider stack in the sidebar, and a full-screen details modal for exploring all metrics. The system includes a sophisticated backend caching mechanism that stores the latest status per provider and replays it to any new browser client on connection, ensuring no status is lost even if the provider goes offline mid-session.**

This doc covers the complete data flow: how providers emit status, how the backend caches and broadcasts it, how the frontend routes and stores it, and how components render both summary and detail views. It does NOT cover sidebar hierarchy (see Sidebar Rendering doc for that) or provider-specific implementations (separate provider docs handle those).

---

## Overview

### What It Does

The ProviderStatusPanel system:

- **Receives status from providers**: Providers emit `provider_extension` events with a `provider/status` payload containing metrics like quota usage, spend amount, rate limits, and health status
- **Caches on the backend**: `providerStatusMemory.js` stores the latest status per provider in memory. New client connections immediately replay the cached status instead of waiting for the provider to emit again
- **Routes through the frontend**: Socket events pass through `useSocket.ts` → `extensionRouter.ts` → `useSystemStore` → components
- **Renders two views**: Compact summary (in sidebar) shows 1-2 key metrics; details modal shows all sections with progress bars, tones, and detail labels
- **Updates in real-time**: When a provider emits a new status, the panel updates instantly without page refresh
- **Multi-provider aware**: Each provider has its own status. The panel renders one card per provider that has emitted status

### Why This Matters

- **No status loss**: The backend cache ensures status survives provider reconnections and browser refreshes
- **Responsive feedback**: Users see quota/rate limits without leaving the chat interface
- **Low-latency rendering**: Cached status is replayed on connect, so status appears before the user opens a chat
- **Provider decoupling**: Status structure is generic (sections, items, tones) — any provider can emit any metrics they have

---

## How It Works — End-to-End Flow

### 1. Provider Emits Status (ACP Daemon)
**File:** (Provider-specific, e.g., Claude CLI daemon)

The ACP provider daemon sends a `provider_extension` notification:

```json
{
  "method": "claude-protocol://provider/status",
  "params": {
    "status": {
      "title": "Claude API",
      "subtitle": "Usage this month",
      "updatedAt": "2026-05-01T14:32:00Z",
      "sections": [
        {
          "id": "tokens",
          "title": "Token Usage",
          "items": [
            { "id": "prompt", "label": "Prompt Tokens", "value": "1.2M / 10M", "progress": { "value": 0.12 } },
            { "id": "completion", "label": "Completion Tokens", "value": "456K / 5M", "progress": { "value": 0.091 } }
          ]
        }
      ],
      "summary": {
        "title": "Usage",
        "items": [
          { "id": "total", "label": "Total Spend", "value": "$45.32" }
        ]
      }
    }
  }
}
```

---

### 2. Backend Receives Extension Event
**File:** `backend/services/acpClient.js` (Lines 225-252)

The `handleAcpMessage()` method routes all ACP notifications:

```javascript
// FILE: backend/services/acpClient.js (Lines 225-252)
handleAcpMessage(message) {
  if (message.method === 'provider_extension') {
    const payload = message.params;  // Contains { status: {...} }
    this.handleProviderExtension(payload);
  }
}
```

---

### 3. Backend Caches Status
**File:** `backend/services/acpClient.js` (Lines 284-355)

The `handleProviderExtension()` method processes the status:

```javascript
// FILE: backend/services/acpClient.js (Lines 284-355)
handleProviderExtension(payload) {
  // ... other extension types ...
  
  // Line 336: Cache the status for replay on new connections
  rememberProviderStatusExtension(payload, this.providerId);
  
  // Lines 338-342: Broadcast to all connected clients
  this.io.emit('provider_extension', {
    providerId: this.providerId,
    method: payload.method,
    params: { ...payload.params, providerId: this.providerId }
  });
}
```

---

### 4. Backend Cache Storage
**File:** `backend/services/providerStatusMemory.js` (Lines 1-58)

The cache is a simple in-memory Map:

```javascript
// FILE: backend/services/providerStatusMemory.js (Lines 1-5)
const latestProviderStatusExtensions = new Map();  // By providerId
let latestProviderStatusExtension = null;           // Global latest (for active provider)

export function rememberProviderStatusExtension(payload, providerId) {
  // Lines 4-29: Store by providerId, update global
  latestProviderStatusExtensions.set(providerId, {
    providerId,
    method: payload.method,
    params: payload.params
  });
  latestProviderStatusExtension = { providerId, ...payload };
}
```

**Critical:** The cache is keyed by `providerId`, not global. Each provider's latest status is stored separately.

---

### 5. On-Connect Hydration
**File:** `backend/sockets/index.js` (Lines 84-94)

When a new client connects, the backend immediately replays all cached statuses:

```javascript
// FILE: backend/sockets/index.js (Lines 84-94)
io.on('connection', (socket) => {
  // ... other events ...
  
  // Hydrate client with cached provider statuses
  const providerStatusExtensions = getLatestProviderStatusExtensions();
  for (const ext of providerStatusExtensions) {
    socket.emit('provider_extension', ext);
  }
});
```

No delay, no wait for provider to emit again — the new client gets status instantly.

---

### 6. Frontend Receives Socket Event
**File:** `frontend/src/hooks/useSocket.ts` (Lines 87-103)

The frontend socket listener receives the `provider_extension` event:

```typescript
// FILE: frontend/src/hooks/useSocket.ts (Lines 87-103)
socket.on('provider_extension', (data) => {
  const providerId = data.providerId || extractProviderId(data);
  const result = routeExtension(data.method, /* ... params ... */);
  
  if (result.type === 'provider_status') {
    // Line 103: Store status in Zustand
    useSystemStore.getState().setProviderStatus(result.status, providerId);
  }
});
```

The event is routed through `extensionRouter` to be typed and validated.

---

### 7. Extension Routing & Type Guard
**File:** `frontend/src/utils/extensionRouter.ts` (Lines 40-70)

The pure router function matches provider/status and validates the shape:

```typescript
// FILE: frontend/src/utils/extensionRouter.ts (Lines 40-70)
export function routeExtension(method: string, payload: any) {
  // Lines 40-42: Match provider/status
  if (method === 'provider/status' || method === 'provider_status') {
    if (isProviderStatus(payload.status)) {
      return { type: 'provider_status', status: payload.status };
    }
  }
  // ... other routes ...
}

// Lines 66-70: Type guard
function isProviderStatus(value: unknown): value is ProviderStatus {
  if (!value || typeof value !== 'object') return false;
  const status = value as Partial<ProviderStatus>;
  return Array.isArray(status.sections);  // REQUIRED field
}
```

**Critical:** `sections` must be an array. If missing, `isProviderStatus()` returns false and nothing renders.

---

### 8. Store Status Update
**File:** `frontend/src/store/useSystemStore.ts` (Lines 160-172)

The `setProviderStatus` action stores status by provider:

```typescript
// FILE: frontend/src/store/useSystemStore.ts (Lines 160-172)
setProviderStatus: (status, providerId) => set(state => {
  const resolvedProviderId = providerId || status?.providerId || state.activeProviderId || state.defaultProviderId;
  if (!resolvedProviderId) return { providerStatus: status };
  
  const providerStatusByProviderId = { ...state.providerStatusByProviderId };
  if (status) {
    providerStatusByProviderId[resolvedProviderId] = { ...status, providerId: resolvedProviderId };
  } else {
    delete providerStatusByProviderId[resolvedProviderId];
  }
  
  // Update both keyed + active provider's singular
  const isActiveProvider = !providerId || resolvedProviderId === state.activeProviderId;
  return {
    providerStatusByProviderId,
    providerStatus: isActiveProvider ? status : state.providerStatus
  };
}),
```

**Multi-provider scoping:** Status is stored in `providerStatusByProviderId[id]`. The singular `providerStatus` is updated only if this is the active provider.

---

### 9. Component Renders Compact Summary
**File:** `frontend/src/components/ProviderStatusPanel.tsx` (Lines 7-70)

The component reads from store and renders summary:

```typescript
// FILE: frontend/src/components/ProviderStatusPanel.tsx (Lines 7-23)
function ProviderStatusPanels({ providerId }) {
  const statusByProvider = useSystemStore(s => s.providerStatusByProviderId);
  
  // Filter providers with status
  const providersWithStatus = Object.values(statusByProvider).filter(
    s => s && s.sections?.some(sec => sec.items?.length > 0)
  );
  
  return (
    <div className="provider-status-container">
      {providersWithStatus.map(status => (
        <ProviderStatusPanelSingle key={status.providerId} status={status} />
      ))}
    </div>
  );
}

// Lines 25-70: Single provider panel
function ProviderStatusPanelSingle({ status }) {
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  const summaryItems = getSummaryItems(status);  // Line 140-144
  
  return (
    <div className="provider-status-panel">
      <div className="provider-status-header">{status.title}</div>
      <div className="provider-status-summary">
        {summaryItems.map(item => (
          <ProviderStatusRow key={item.id} item={item} compact={true} />
        ))}
      </div>
      <button onClick={() => setIsDetailsOpen(true)}>Details ↓</button>
      {isDetailsOpen && (
        <ProviderStatusModal status={status} onClose={() => setIsDetailsOpen(false)} />
      )}
    </div>
  );
}
```

The `getSummaryItems()` helper (Lines 140-144) extracts display items:

```typescript
const summaryItems = status.summary?.items || status.sections[0]?.items?.slice(0, 2) || [];
```

If status has an explicit `summary`, use it. Else use first 2 items from the first section.

---

### 10. User Opens Details Modal
**File:** `frontend/src/components/ProviderStatusPanel.tsx` (Lines 72-138)

When the user clicks "Details", the modal shows all sections:

```typescript
// FILE: frontend/src/components/ProviderStatusPanel.tsx (Lines 72-105)
function ProviderStatusModal({ status, onClose }) {
  return (
    <div className="provider-status-modal-overlay" onClick={onClose}>
      <div className="provider-status-modal">
        <h2>{status.title}</h2>
        {status.sections.map(section => (
          <section key={section.id}>
            <h3>{section.title}</h3>
            {section.items.map(item => (
              <ProviderStatusRow key={item.id} item={item} compact={false} />
            ))}
          </section>
        ))}
        <div className="provider-status-modal-footer">
          {status.updatedAt && <span>Updated: {formatUpdatedAt(status.updatedAt)}</span>}
        </div>
      </div>
    </div>
  );
}

// Lines 107-138: Row renderer
function ProviderStatusRow({ item, compact }) {
  const progressValue = clampProgress(item.progress?.value ?? 1);  // Line 146-149
  const toneClass = `tone-${item.tone ?? 'neutral'}`;
  
  return (
    <div className={`status-row ${toneClass}`}>
      <span className="status-label">{item.label}</span>
      <span className="status-value">{item.value}</span>
      {item.progress && (
        <div className="progress-bar">
          <div style={{ width: `${progressValue * 100}%` }} />
        </div>
      )}
      {!compact && item.detail && (
        <span className="status-detail">{item.detail}</span>
      )}
    </div>
  );
}
```

Tone-based CSS classes (`.tone-success`, `.tone-warning`, etc.) are applied to color the row. Progress bars are filled based on `clampProgress()` (0-1).

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         AI Provider Daemon                              │
│                                                                         │
│  Emits: { method: 'protocol://provider/status', params: { status } }  │
└────────────────┬────────────────────────────────────────────────────────┘
                 │ JSON-RPC notification (stdin)
┌────────────────▼────────────────────────────────────────────────────────┐
│                         Backend (Node.js)                               │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ acpClient.js (Lines 227-344)                                    │   │
│  │ ├─ handleAcpMessage() → handleProviderExtension()              │   │
│  │ ├─ Line 336: rememberProviderStatusExtension()                 │   │
│  │ └─ Line 338-342: io.emit('provider_extension')                 │   │
│  └────────────────┬──────────────────────────────────────────────┘   │
│                   │                                                     │
│  ┌────────────────▼──────────────────────────────────────────────┐   │
│  │ providerStatusMemory.js (Cache)                               │   │
│  │ ├─ Map<providerId, { method, params }>                        │   │
│  │ ├─ rememberProviderStatusExtension() — stores by providerId   │   │
│  │ └─ getLatestProviderStatusExtensions() — returns all cached   │   │
│  └────────────────┬──────────────────────────────────────────────┘   │
│                   │                                                     │
│  ┌────────────────▼──────────────────────────────────────────────┐   │
│  │ sockets/index.js (On-Connect Hydration, Lines 84-94)          │   │
│  │ └─ For each cached status, emit to new socket client          │   │
│  └────────────────┬──────────────────────────────────────────────┘   │
└────────────────────┼──────────────────────────────────────────────────┘
                     │ Socket.IO: provider_extension event
┌────────────────────▼──────────────────────────────────────────────────┐
│                         Frontend (React)                               │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ useSocket.ts (Lines 87-103)                                  │    │
│  │ └─ socket.on('provider_extension') → routeExtension()        │    │
│  └──────────────────────┬─────────────────────────────────────┘     │
│                         │                                             │
│  ┌──────────────────────▼─────────────────────────────────────┐     │
│  │ extensionRouter.ts (Lines 40-70)                            │     │
│  │ ├─ Match provider/status or provider_status                 │     │
│  │ ├─ isProviderStatus() type guard (Lines 66-70)              │     │
│  │ └─ Return { type: 'provider_status', status }               │     │
│  └──────────────────────┬─────────────────────────────────────┘     │
│                         │                                             │
│  ┌──────────────────────▼─────────────────────────────────────┐     │
│  │ useSystemStore.setProviderStatus() (Lines 160-172)          │     │
│  │ └─ Store in providerStatusByProviderId[providerId]          │     │
│  └──────────────────────┬─────────────────────────────────────┘     │
│                         │                                             │
│  ┌──────────────────────▼─────────────────────────────────────┐     │
│  │ ProviderStatusPanel.tsx                                     │     │
│  │ ├─ Read providerStatusByProviderId from store               │     │
│  │ ├─ ProviderStatusPanels (wrapper)                           │     │
│  │ │   └─ ProviderStatusPanelSingle × N                        │     │
│  │ │       ├─ Compact summary view + Details button            │     │
│  │ │       └─ ProviderStatusModal (on click)                   │     │
│  │ │           ├─ All sections + items                         │     │
│  │ │           └─ ProviderStatusRow × N                        │     │
│  │ └─ CSS: tone-based coloring + progress bars                 │     │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                        │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │ ProviderStatusPanel.css (354 lines)                          │    │
│  │ ├─ .tone-success/warning/danger/info (Lines 152-166)         │    │
│  │ ├─ Progress bar fill (Lines 138-166)                         │    │
│  │ ├─ Modal overlay + positioning (Lines 225-235)               │    │
│  │ └─ @keyframes providerStatusEnter (Lines 344-353)            │    │
│  └──────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
```

**Data Flow:**
1. Backend: Provider emits → cache in memory → broadcast to sockets
2. On-connect: Cache replayed immediately to new browser clients
3. Frontend: Socket event → route → type guard → store → components → render

---

## The Critical Contract: ProviderStatus Shape

Every status emitted by a provider must conform to this type (Lines 101-136 in `frontend/src/types.ts`):

```typescript
type ProviderStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

interface ProviderStatusProgress {
  value: number;          // REQUIRED: 0-1 float (NOT 0-100)
  label?: string;         // Optional label shown in progress bar
}

interface ProviderStatusItem {
  id: string;             // Unique ID within section
  label: string;          // Display label: "Prompt Tokens"
  value: string;          // Display value: "1.2M / 10M"
  detail?: string;        // Detail label shown only in expanded view
  tone?: ProviderStatusTone;
  progress?: ProviderStatusProgress;
}

interface ProviderStatusSection {
  id: string;             // Unique ID within status
  title: string;          // Section heading: "Token Usage"
  items: ProviderStatusItem[];   // REQUIRED: must have items
}

interface ProviderStatusSummary {
  title: string;          // Summary heading
  items: ProviderStatusItem[];   // 1-2 items shown in compact view
}

interface ProviderStatus {
  providerId?: string;    // Inferred from route; can be explicit
  title?: string;         // "Claude API"
  subtitle?: string;      // "Usage this month"
  updatedAt?: string;     // ISO 8601 timestamp
  summary?: ProviderStatusSummary;
  sections: ProviderStatusSection[];   // REQUIRED: type guard checks this
}
```

### Breaking the Contract

1. **Missing `sections`** → `isProviderStatus()` returns false → component never renders
2. **`progress.value` > 1 or < 0** → `clampProgress()` squashes to [0, 1] but backend should send correct values
3. **`tone` not in enum** → CSS class `.tone-${tone}` is invalid → row is unstyled
4. **Empty `items` in a section** → Section still renders, just with empty content
5. **No `summary`** → Fallback to first section's first 2 items (automatic)

---

## Data Flow Example: Claude Provider Emitting Quota Status

### 1. Provider Emits

```json
{
  "method": "claude-protocol://provider/status",
  "params": {
    "status": {
      "providerId": "claude",
      "title": "Claude API",
      "subtitle": "Usage this billing period",
      "updatedAt": "2026-05-01T14:32:15Z",
      "sections": [
        {
          "id": "tokens",
          "title": "Token Usage",
          "items": [
            {
              "id": "input",
              "label": "Input Tokens",
              "value": "2.5M / 10M",
              "detail": "Prompt tokens processed",
              "tone": "success",
              "progress": { "value": 0.25 }
            },
            {
              "id": "output",
              "label": "Output Tokens",
              "value": "500K / 5M",
              "detail": "Completion tokens generated",
              "tone": "success",
              "progress": { "value": 0.1 }
            }
          ]
        },
        {
          "id": "rate",
          "title": "Rate Limits",
          "items": [
            {
              "id": "rpm",
              "label": "Requests Per Minute",
              "value": "45 / 300",
              "tone": "info",
              "progress": { "value": 0.15 }
            }
          ]
        }
      ],
      "summary": {
        "title": "At a Glance",
        "items": [
          {
            "id": "summary-tokens",
            "label": "Total Usage",
            "value": "3M / 15M tokens",
            "tone": "success",
            "progress": { "value": 0.2 }
          }
        ]
      }
    }
  }
}
```

### 2. Compact Summary Renders (in Sidebar)

```
╔════════════════════════════╗
║  Claude API               ║
║  Usage this billing peri…  ║
╟────────────────────────────╢
║ Total Usage: 3M / 15M tokens │
║ ████░░░░░░░░░░░░░░ 20%    ║
╟────────────────────────────╢
║ Details ↓    Updated: 2:32 PM ║
╚════════════════════════════╝
```

Only the summary item is shown (1 item). Progress bar filled to 20%. Tone: green (success).

### 3. Details Modal Renders (on click)

```
╔════════════════════════════════════════╗
║  Claude API                            ║
║  Usage this billing period        [✕] ║
╟────────────────────────────────────────╢
║                                        ║
║  Token Usage                           ║
║  ├─ Input Tokens: 2.5M / 10M           ║
║  │  ████░░░░░░░░░░░░░░ 25%             ║
║  │  (Prompt tokens processed)           ║
║  └─ Output Tokens: 500K / 5M           ║
║     ██░░░░░░░░░░░░░░░░░ 10%            ║
║     (Completion tokens generated)       ║
║                                        ║
║  Rate Limits                           ║
║  └─ Requests Per Minute: 45 / 300      ║
║     ███░░░░░░░░░░░░░░░░░░░░░ 15%       ║
║                                        ║
╟────────────────────────────────────────╢
║ Updated: 2:32 PM                       ║
╚════════════════════════════════════════╝
```

All sections shown. Detail labels visible. All progress bars with tone-based colors.

---

## Component Reference

### Frontend Components

| Component | File | Lines | Props | State | Purpose |
|-----------|------|-------|-------|-------|---------|
| **ProviderStatusPanels** | `ProviderStatusPanel.tsx` | 7-23 | `providerId?` | None | Root wrapper; reads `providerStatusByProviderId` from store; filters and renders one `ProviderStatusPanelSingle` per provider with status |
| **ProviderStatusPanelSingle** | `ProviderStatusPanel.tsx` | 25-70 | `status: ProviderStatus` | `isDetailsOpen` | Single provider panel; renders compact summary + Details button; opens modal on click |
| **ProviderStatusModal** | `ProviderStatusPanel.tsx` | 72-105 | `status: ProviderStatus`, `onClose: () => void` | None | Full-screen details overlay; renders all sections with all items |
| **ProviderStatusRow** | `ProviderStatusPanel.tsx` | 107-138 | `item: ProviderStatusItem`, `compact: boolean` | None | Single status item row; compact hides detail label; progress bar uses tone-based color |

### Store Actions

| Store | Field/Action | Lines | Purpose |
|-------|-------------|-------|---------|
| `useSystemStore` | `providerStatusByProviderId: Record<string, ProviderStatus>` | 27, 89 | Stores status by providerId key |
| `useSystemStore` | `setProviderStatus(status, providerId)` | 160-172 | Updates store; resolves providerId; updates singular `providerStatus` if active provider |

### Utilities & Helpers

| Helper | File | Lines | Purpose |
|--------|------|-------|---------|
| `getSummaryItems()` | `ProviderStatusPanel.tsx` | 140-144 | Returns summary items if available; else first 2 from first section |
| `clampProgress()` | `ProviderStatusPanel.tsx` | 146-149 | Clamps value to [0, 1] range |
| `formatUpdatedAt()` | `ProviderStatusPanel.tsx` | 151-155 | Converts ISO timestamp to local time string |
| `isProviderStatus()` | `extensionRouter.ts` | 66-70 | Type guard: validates `sections` is array |
| `routeExtension()` | `extensionRouter.ts` | 17-64 | Pure router: matches method → returns typed action |

### Backend Services

| Service | File | Lines | Purpose |
|---------|------|-------|---------|
| `rememberProviderStatusExtension()` | `providerStatusMemory.js` | 4-29 | Cache status in Map by providerId |
| `getLatestProviderStatusExtensions()` | `providerStatusMemory.js` | 39-41 | Return all cached statuses for on-connect replay |
| `handleProviderExtension()` | `acpClient.js` | 284-355 | Route provider extensions; cache status; broadcast to sockets |

### CSS

| File | Lines | Purpose |
|------|-------|---------|
| `ProviderStatusPanel.css` | 1-354 | Panel styling, progress bars, tone colors (success/warning/danger/info), modal overlay, animations |

### Type Definitions

| Type | File | Lines | Purpose |
|------|------|-------|---------|
| `ProviderStatus` | `frontend/src/types.ts` | 129-136 | Root status type with sections, summary, metadata |
| `ProviderStatusSection` | `frontend/src/types.ts` | 118-122 | Section with id, title, items |
| `ProviderStatusItem` | `frontend/src/types.ts` | 109-116 | Item with label, value, detail, tone, progress |
| `ProviderStatusProgress` | `frontend/src/types.ts` | 103-107 | Progress with value 0-1, optional label |
| `ProviderStatusTone` | `frontend/src/types.ts` | 101 | Enum: neutral, info, success, warning, danger |

---

## Backend Cache Mechanism

### Cache Storage

**File:** `backend/services/providerStatusMemory.js` (Lines 1-2)

```javascript
const latestProviderStatusExtensions = new Map();  // By providerId
let latestProviderStatusExtension = null;           // Global latest
```

The Map keyed by `providerId` ensures each provider's latest status is available independently.

### Storing Status

**File:** `backend/services/providerStatusMemory.js` (Lines 4-29)

When `handleProviderExtension()` receives a status (Line 336 in `acpClient.js`):

```javascript
rememberProviderStatusExtension(payload, providerId) {
  latestProviderStatusExtensions.set(providerId, {
    providerId,
    method: payload.method,
    params: payload.params
  });
  latestProviderStatusExtension = { providerId, ...payload };
}
```

Both the keyed cache and global latest are updated (global for fallback/logging).

### Retrieving Cached Status

**File:** `backend/services/providerStatusMemory.js` (Lines 39-41)

```javascript
export function getLatestProviderStatusExtensions() {
  return Array.from(latestProviderStatusExtensions.values());
}
```

Returns all cached statuses as an array.

### On-Connect Replay

**File:** `backend/sockets/index.js` (Lines 84-94)

When a new client connects:

```javascript
const providerStatusExtensions = getLatestProviderStatusExtensions();
for (const ext of providerStatusExtensions) {
  socket.emit('provider_extension', ext);
}
```

All cached statuses are emitted to the new socket immediately, before any user interaction.

---

## Gotchas & Important Notes

### 1. Type Guard Requires sections Array
**What breaks:** Provider emits status without `sections` field → component never renders.

**Why:** The `isProviderStatus()` type guard (Lines 66-70) requires `Array.isArray(status.sections)`. If missing, routing fails.

**How to verify:** Check that your status payload has a non-empty `sections` array:
```javascript
status: {
  sections: [{ id: "...", title: "...", items: [...] }]
}
```

---

### 2. Progress Values Must Be 0-1, Not 0-100
**What breaks:** Progress bar shows as 99% when you meant 0.99.

**Why:** The `clampProgress()` function (Lines 146-149) treats values as 0-1 floats. A value of 50 is clamped to 1.0 (100%).

**How to fix:** Divide by 100 before sending:
```javascript
progress: { value: usedTokens / maxTokens }  // 0-1
progress: { value: 0.5 }                     // 50%
```

---

### 3. Cache Is In-Memory, Not Persisted
**What breaks:** Status disappears if backend restarts.

**Why:** The cache is a JavaScript Map in memory. No database persistence.

**How to handle:** This is intentional — backend crashes should clear stale status. Providers will re-emit on reconnect. For critical status, providers should emit frequently or on-demand.

---

### 4. Tone Values Must Match CSS Classes
**What breaks:** Row renders unstyled if tone is "critical" but CSS only has "danger".

**Why:** The CSS class `.tone-${tone}` is constructed dynamically (Line 113). Invalid tones produce invalid class names.

**How to verify:** Only use: `neutral`, `info`, `success`, `warning`, `danger`.

---

### 5. Only One Status Per Provider
**What breaks:** Multiple statuses from the same provider; last one wins.

**Why:** Cache is keyed by `providerId` (Line 4 in `providerStatusMemory.js`). New status overwrites the old one.

**How to handle:** If you need multiple status views per provider, emit a single status with multiple sections.

---

### 6. Summary Is Optional but Compact View Needs Items
**What breaks:** `ProviderStatusPanelSingle` renders with no items shown.

**Why:** If `summary` is missing, fallback to first section's first 2 items (Line 140-144). If the section is empty or missing, no items render.

**How to fix:** Either include `summary` with items, or ensure the first section has at least 1 item.

---

### 7. Empty Sections Still Render
**What breaks:** Section appears with no items; looks broken.

**Why:** The modal renders all sections regardless of item count.

**How to prevent:** Only include sections with items. The type definition allows `items: []`, but rendering an empty section is poor UX.

---

### 8. Active Provider Distinction in setProviderStatus
**What breaks:** Status updates for a background provider don't update the singular `providerStatus` field.

**Why:** Lines 167-170 in `useSystemStore.ts` only update `providerStatus` if the provider is active or if providerId wasn't explicitly passed.

**How to understand:** This is intentional — the singular field tracks the active provider's status for global UI. The keyed field tracks all providers.

---

### 9. Modal Close Button Requires onClose Handler
**What breaks:** Modal doesn't close when user clicks the X button.

**Why:** `ProviderStatusModal` prop `onClose` is called on click, but parent must handle it.

**How to verify:** `ProviderStatusPanelSingle` passes `onClose={() => setIsDetailsOpen(false)}` to modal (Line 67).

---

### 10. formatUpdatedAt Assumes ISO 8601
**What breaks:** Timestamp renders as "Invalid Date".

**Why:** The helper (Lines 151-155) uses `new Date(isoString)` and `.toLocaleString()`. Non-ISO strings fail.

**How to fix:** Provider should emit ISO 8601 format: `"2026-05-01T14:32:15Z"`.

---

## Unit Tests

### Test File

| File | Lines | Test Coverage |
|------|-------|--------------|
| `frontend/src/test/ProviderStatusPanel.test.tsx` | 135 | Null render, compact+modal workflow, fallback summary, detail text, progress clamping |

### Key Test Cases

1. **No status renders null** (Lines 15-18): Verify component returns null when `providerStatusByProviderId` is empty
2. **Compact summary + modal details** (Lines 20-63): Full workflow — renders compact view, clicks Details, modal appears with all sections
3. **Fallback to first 2 items** (Lines 65-86): When `summary` is missing, summary rows use first section's first 2 items
4. **Detail text renders in expanded** (Lines 88-108): When `compact={false}`, detail label is shown
5. **Progress clamping** (Lines 110-133): Values -1 and 2 are clamped to 0% and 100%

### Run Tests

```bash
cd frontend
npx vitest run ProviderStatusPanel.test.tsx
npx vitest run --coverage                           # Coverage report
```

---

## How to Use This Guide

### For Implementing Provider Status Emission

1. **Understand the contract:** Read "The Critical Contract" section — your status must have `sections: ProviderStatusItem[]`
2. **Shape your data:**
   - Decide what metrics to expose (token usage, rate limits, health, etc.)
   - Group into sections (e.g., "Token Usage", "Rate Limits")
   - Each item should have `label`, `value`, optional `detail`, optional `progress`
3. **Emit on demand or on-change:**
   - Send via ACP `provider_extension` notification with method `provider/status` or `protocol://provider/status`
   - Backend will cache it and replay to all clients
4. **Test with the mock:** Create a test provider that emits known payloads, verify rendering

### For Debugging Status Not Appearing

1. **Check backend logs:** Look for `io.emit('provider_extension')` on line 338 of `acpClient.js`
2. **Check frontend console:** Open DevTools Network tab, look for `provider_extension` socket messages
3. **Check type guard:** Verify `isProviderStatus()` is not rejecting your payload — add `sections: []` if missing
4. **Check cache:** Debug backend to confirm `rememberProviderStatusExtension()` was called
5. **Check on-connect:** Manually refresh browser; status should appear instantly from cache (not wait for provider)

### For Extending with New Metrics

1. **Add new section:** Include a new object in `sections: []` with `id`, `title`, `items`
2. **Add new item:** Include in items array with `id`, `label`, `value`, and optional `progress`, `tone`, `detail`
3. **Use tones:** Assign `tone: 'success'` for healthy, `tone: 'warning'` for degraded, `tone: 'danger'` for critical
4. **Test in modal:** Verify the Details modal shows all sections and items with correct colors and progress bars

---

## Summary

The ProviderStatusPanel system is a **real-time, cached, multi-provider status display** that:

1. **Receives status from providers** via ACP `provider_extension` events
2. **Caches on the backend** in a Map keyed by providerId; replays to new clients on connect
3. **Routes on the frontend** through `extensionRouter` with type guard validation
4. **Stores per-provider** in `useSystemStore.providerStatusByProviderId`
5. **Renders two views**: Compact summary (sidebar) and full details modal
6. **Uses tone-based styling** for visual feedback (success → green, warning → yellow, danger → red)
7. **Supports flexible metrics** via generic ProviderStatus type (sections, items, progress)

**The critical contract is the `ProviderStatus` type shape**: Must have `sections` array (for type guard), progress values must be 0-1 (not 0-100), tone must be one of the enum values.

Agents should be able to:
- ✅ Emit status from a provider daemon
- ✅ Debug why status doesn't appear (type guard, cache, routing)
- ✅ Understand on-connect hydration (cached status replayed immediately)
- ✅ Add new metrics/sections without modifying code (data-driven)
- ✅ Customize tone colors and styling via CSS
- ✅ Understand the singular `providerStatus` vs keyed `providerStatusByProviderId` distinction
