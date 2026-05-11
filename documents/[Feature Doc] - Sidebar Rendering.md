# Feature Doc — Sidebar Rendering

**AcpUI's sidebar is a hierarchical, real-time UI panel that displays sessions organized by provider, folder, and fork nesting. It's driven by five Zustand stores, uses localStorage for two persistent state fields (sidebar pinned, folder expanded IDs), and applies CSS state classes in real-time to show typing/unread/permission-awaiting indicators with animated breathing glows. The sidebar does not handle feature logic (forking, archiving, drag-drop semantics) — those are separate docs. This doc focuses purely on how it renders, updates, and animates.**

Understanding the sidebar's rendering architecture is critical for any UI work: debugging display bugs, adding new session indicators, optimizing re-renders, or implementing new sidebar sections.

---

## Overview

### What It Renders

The sidebar displays:

- **Provider Stacks**: Sessions grouped by AI provider, with collapsible accordions. Only one provider at a time shows full content.
- **Folder Tree**: Hierarchical folders with recursive nesting. Folders expand/collapse, with child count badges.
- **Session List**: Chat sessions as rows within folders or at root. Sessions show name, icons (indicating fork/sub-agent/terminal status), pin status, and notes indicator.
- **Session States**: Real-time animations for typing (blue breathe glow), unread responses (bold + solid border), and permission-awaiting (green glow).
- **Fork/Sub-Agent Nesting**: Forked sessions and sub-agents appear indented under their parent session with a fork indicator.
- **Workspace Menu**: Clickable workspaces for creating new chats in specific directories.
- **Archive Browser**: Modal for browsing and restoring archived sessions.
- **Provider Status Panels**: Optional status cards at the bottom of each provider stack (quota, spend, etc.).

### Why This Matters

- **Real-Time Feedback**: Socket events instantly update session flags (typing, unread), triggering CSS animations that give immediate visual feedback.
- **Persistence**: Folder expansion and sidebar pin state are localStorage-backed, so user preferences survive page refreshes.
- **Multi-Provider**: Only one provider's sessions are visible at a time (via `expandedProviderId`), preventing overwhelming UI with many providers.
- **Deep Nesting**: Sessions can be organized into folders and forks, supporting complex project hierarchies.
- **Performance**: Sidebar uses memoization (`filteredSessions`) and localStorage caching to avoid redundant updates.

### Architectural Role

**Sidebar consumes:**
1. State from five Zustand stores (session list, folders, UI state, provider config, canvas terminals)
2. Socket events (typing, unread, session renamed, sub-agent created)
3. localStorage (sidebar pinned, folder expanded IDs)

**Sidebar emits:**
1. Socket events (session select, new chat, archive, rename, etc.)
2. localStorage writes (sidebar width resize, folder expand/collapse)

---

## How It Works — End-to-End Flow

### 1. App Boot & Socket Hydration
**File:** `frontend/src/hooks/useSocket.ts` (Lines 42-56)

When the frontend starts, `useSocket.ts` establishes a Socket.IO connection and receives provider metadata:

```typescript
// FILE: frontend/src/hooks/useSocket.ts (Lines 42-56)
socket.on('providers', (payload) => {
  useSystemStore.getState().setProviders(payload.defaultProviderId || null, payload.providers || []);
});
```

socket.on('branding', (payload) => {
  useSystemStore.setState({ branding: payload });
});

socket.on('workspace_cwds', (payload) => {
  useSystemStore.setState({ workspaceCwds: payload.cwds });
});
```

The sidebar will display provider stacks based on `orderedProviderIds` received here.

---

### 2. Folder Tree Load
**File:** `frontend/src/store/useFolderStore.ts` (Lines 45-50)

The `loadFolders()` action emits a socket event to load the folder tree from the backend:

```typescript
// FILE: frontend/src/store/useFolderStore.ts (Lines 45-50)
loadFolders: async () => {
  const response = await socket.emitAsync('load_folders', { providerId });
  set(state => ({
    folders: response.folders
  }));
}
```

The `expandedFolderIds` are already loaded from localStorage (Lines 21-26) when the store initializes. Now the folder tree structure is ready.

---

### 3. Session List Load
**File:** `frontend/src/store/useSessionLifecycleStore.ts` (Lines 99-104)

The `handleInitialLoad` action populates the session list from the backend:

```typescript
// FILE: frontend/src/store/useSessionLifecycleStore.ts (Lines 99-104)
const response = await socket.emitAsync('load_sessions', { providerId });
set(state => ({
  sessions: response.sessions,
  sessionNotes: buildNoteMap(response.notes)
}));
```

Each session object contains flags like `isPinned`, `folderId`, `forkedFrom`, `isSubAgent` that control its rendering.

---

### 4. Sidebar Component Mount & State Binding
**File:** `frontend/src/components/Sidebar.tsx` (Lines 15-54)

The `Sidebar` component mounts and subscribes to store state:

```typescript
// FILE: frontend/src/components/Sidebar.tsx (Lines 15-54)
function Sidebar() {
  // Read stores
  const sessions = useSessionLifecycleStore(s => s.sessions);
  const activeSessionId = useSessionLifecycleStore(s => s.activeSessionId);
  const { isSidebarOpen, isSidebarPinned, expandedProviderId } = useUIStore();
  const folders = useFolderStore(s => s.folders);
  const expandedFolderIds = useFolderStore(s => s.expandedFolderIds);
  const { orderedProviderIds, providersById } = useSystemStore();
  
  // Local state
  const [searchQuery, setSearchQuery] = useState('');
  const [sidebarWidth, setSidebarWidth] = useState(
    parseInt(localStorage.getItem('sidebarWidth') || '312', 10)
  );
  
  // Memoized derived
  const filteredSessions = useMemo(
    () => sessions.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase())),
    [sessions, searchQuery]
  );
}
```

The sidebar is now bound to all store state. Any update to `sessions[]`, `expandedProviderId`, or `isSidebarOpen` will trigger a re-render.

---

### 5. Provider Stack Rendering (Accordion)
**File:** `frontend/src/components/Sidebar.tsx` (Lines 318-366)

The sidebar loops over `orderedProviderIds` and renders a `provider-stack` for each:

```typescript
// FILE: frontend/src/components/Sidebar.tsx (Lines 318-366)
<div className="sessions-list">
  {effectiveProviders.map(p => {
    const isExpanded = expandedProviderId === p.providerId;
    const pSessions = filteredSessions.filter(s => s.provider === p.providerId && !s.folderId && !s.forkedFrom && !s.isSubAgent);
    const pFolders = folders.filter(f => f.provider === p.providerId && !f.parentId);
    
    return (
      <div key={p.providerId} className={`provider-stack ${isExpanded ? 'expanded' : ''}`}>
        <div className="provider-stack-header" onClick={() => setExpandedProviderId(isExpanded ? null : p.providerId)}>
          {p.label}
        </div>
        
        {isExpanded && (
          <div className="provider-stack-content">
            {/* Root folders */}
            {pFolders.map(f => (
              <FolderItem key={f.id} folder={f} folders={folders} sessions={pSessions} {...otherProps} />
            ))}
            
            {/* Root sessions */}
            {pSessions.map(s => (
              <SessionItem key={s.id} session={s} isActive={activeSessionId === s.id} {...handlers} />
            ))}
            
            {/* Fork tree for each session */}
            {pSessions.map(s => renderChildren(s, 0))}
            
            <ProviderStatusPanel providerId={p.providerId} />
          </div>
        )}
      </div>
    );
  })}
</div>
```

**Key point:** Only one provider stack is expanded at a time (controlled by `expandedProviderId` from `useUIStore`).

---

### 6. Folder Recursion & Expansion
**File:** `frontend/src/components/FolderItem.tsx` (Lines 22-225)

When a folder is clicked, `useFolderStore.toggleFolder()` is called:

```typescript
// FILE: frontend/src/components/FolderItem.tsx (Lines 131-138)
function FolderItem({ folder, folders, sessions, onDropSession, onDropFolder, depth, ...props }) {
  const { expandedFolderIds, toggleFolder } = useFolderStore();
  const isExpanded = expandedFolderIds.has(folder.id);
  
  const handleToggleExpand = () => {
    toggleFolder(folder.id);  // Updates store + localStorage
  };
  
  const childFolders = folders.filter(f => f.parentId === folder.id);
  const childSessions = sessions.filter(s => s.folderId === folder.id && !s.forkedFrom && !s.isSubAgent);
  
  return (
    <div className="folder-tree-item">
      <div className="folder-row" onClick={handleToggleExpand}>
        <ChevronDown style={{ transform: isExpanded ? 'rotate(0deg)' : 'rotate(-90deg)' }} />
        <span className="folder-count">{childFolders.length + childSessions.length}</span>
      </div>
      
      {isExpanded && (
        <div className="folder-children">
          {childFolders.map(cf => (
            <FolderItem key={cf.id} folder={cf} depth={depth + 1} {...props} />
          ))}
          {childSessions.map(cs => (
            <SessionItem key={cs.id} session={cs} {...props} />
          ))}
        </div>
      )}
    </div>
  );
}
```

**Indentation:** Each folder adds `depth * 16px` padding (line 139). Child components get `depth + 1`.

---

### 7. Session Rendering with State Classes
**File:** `frontend/src/components/SessionItem.tsx` (Lines 37-100)

Each session renders as a row with state-based CSS classes:

```typescript
// FILE: frontend/src/components/SessionItem.tsx (Lines 37-100)
function SessionItem({ session, isActive, onSelect, ...props }) {
  const className = `session-item ${isActive ? 'active' : ''} ${session.isPinned ? 'pinned' : ''} ${session.isTyping ? 'typing' : ''} ${session.hasUnreadResponse ? 'unread' : ''} ${session.isWarmingUp ? 'warming' : ''} ${session.isSubAgent ? 'sub-agent' : ''}`;
  
  return (
    <div className={className} onClick={onSelect}>
      {/* Fork indicator */}
      {session.forkedFrom && <span className="fork-arrow">↳</span>}
      
      {/* Icon selection based on session type */}
      {session.isSubAgent ? (
        <Bot size={16} style={{ color: '#10b981' }} />
      ) : session.forkedFrom ? (
        <GitFork size={16} style={{ color: '#3b82f6' }} />
      ) : session.hasTerminal ? (
        <Terminal size={16} style={{ color: '#10b981' }} />
      ) : (
        <MessageSquare size={16} />
      )}
      
      {/* Session name */}
      <span className="session-name">{session.name}</span>
      
      {/* Notes indicator */}
      {sessionNotes[session.id] && <StickyNote size={12} />}
      
      {/* Action buttons (hidden by default, shown on hover via CSS) */}
      <div className="session-actions">
        {/* pin, rename, settings, archive, delete buttons */}
      </div>
    </div>
  );
}
```

**CSS classes applied dynamically:**
- `.active` → highlighted background
- `.typing` → blue breathing glow
- `.pinned` → blue left border
- `.unread` → solid border + bold text
- `.awaiting-permission` → green breathing glow
- `.sub-agent` → green bot icon

---

### 8. Fork & Sub-Agent Nesting
**File:** `frontend/src/components/Sidebar.tsx` (Lines 255-292)

Below each root session, the `renderChildren` function recursively nests forks and sub-agents:

```typescript
// FILE: frontend/src/components/Sidebar.tsx (Lines 255-292)
const renderChildren = (parent, depth) => {
  const forks = getForksOf(parent.id);  // sessions where forkedFrom === parent.id
  const subAgents = getSubAgentsOf(parent.id);  // sessions where parentAcpSessionId === parent.acpId && isSubAgent
  
  return forks.concat(subAgents).map(child => (
    <div key={child.id} style={{ paddingLeft: `${depth * 12}px` }}>
      <SessionItem 
        session={child}
        isActive={activeSessionId === child.id}
        {...handlers}
      />
      {renderChildren(child, depth + 1)}  // Recursive nesting
    </div>
  ));
};
```

Each child gets `depth * 12px` indentation, creating a visual hierarchy.

---

### 9. Search Filtering
**File:** `frontend/src/components/Sidebar.tsx` (Lines 91-93)

When the user types in the search box, `filteredSessions` is recomputed:

```typescript
// FILE: frontend/src/components/Sidebar.tsx (Lines 91-93)
const filteredSessions = useMemo(
  () => sessions.filter(s => s.name.toLowerCase().includes(searchQuery.toLowerCase())),
  [sessions, searchQuery]
);
```

**Critical side effect:** When search is active, folder rendering is skipped (line 386 in Sidebar.tsx):

```typescript
{!searchQuery && pFolders.map(f => <FolderItem ... />)}
{filteredSessions.map(s => <SessionItem ... />)}
```

This flattens the hierarchy during search, showing only matching sessions.

---

### 10. Real-Time State Updates via Socket
**File:** `frontend/src/hooks/useChatManager.ts` (Lines 198-369)

When the user opens a background chat, socket events update the session flags:

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (Lines 198-207)
socket.on('token', (event) => {
  // Session is actively streaming
  useSessionLifecycleStore.setState(state => ({
    sessions: state.sessions.map(s =>
      s.id === event.sessionId ? { ...s, isTyping: true } : s
    )
  }));
});

socket.on('token_done', (event) => {
  // Streaming finished
  useSessionLifecycleStore.setState(state => ({
    sessions: state.sessions.map(s =>
      s.id === event.sessionId ? { ...s, isTyping: false, hasUnreadResponse: true } : s
    )
  }));
});
```

**No re-render per token:** Only the store updates; React re-renders once per token (not per character). CSS animations handle the visual effect.

---

### 11. Sub-Agent Creation (Lazy)
**File:** `frontend/src/hooks/useChatManager.ts` (Lines 176-196)

When sub-agents are spawned, they're created lazily on first token (avoiding ghost empty tabs):

```typescript
// FILE: frontend/src/hooks/useChatManager.ts (Lines 325-359)
socket.on('sub_agent_started', (event) => {
  useSubAgentStore.setState(state => ({
    agents: [...state.agents, event]
  }));
  
  // Lazy: session created here if needed
  // If not, session will be created when sub-agent emits first token
});

// In wrappedOnStreamToken (lines 176-196):
const wrapped_onStreamToken = (event) => {
  if (subAgentRegistry[event.sessionId] && !sessionExists(event.sessionId)) {
    // Lazily create session if not already exist
    createSubAgentSessionSilently(event);
  }
  useStreamStore.onStreamToken(event);
};
```

This prevents empty "warming up" tabs for sub-agents that don't immediately produce output.

---

### 12. User Selection & Unread Clear
**File:** `frontend/src/store/useSessionLifecycleStore.ts` (Lines 205-210)

When the user clicks a session, `handleSessionSelect` clears the unread flag:

```typescript
// FILE: frontend/src/store/useSessionLifecycleStore.ts (Lines 205-210)
handleSessionSelect: (socket, uiId) => {
  set(state => ({
    activeSessionId: uiId,
    sessions: state.sessions.map(s =>
      s.id === uiId ? { ...s, hasUnreadResponse: false } : s
    )
  }));
  socket.emit('watch_session', { sessionId: uiId });
};
```

The `.unread` CSS class is removed from the session, and the session gets `.active` applied instead.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        Browser: React                            │
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Sidebar.tsx (502 lines)                                     ││
│  │ ├─ Local state: searchQuery, sidebarWidth (localStorage)    ││
│  │ ├─ loop: orderedProviderIds → provider-stack               ││
│  │ │   ├─ expandedProviderId controls visibility               ││
│  │ │   └─ pFolders → FolderItem (recursive)                    ││
│  │ │       └─ pSessions → SessionItem                          ││
│  │ │           └─ renderChildren(session, depth) → fork nesting││
│  │ └─ ProviderStatusPanel (if provider has status)             ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Zustand Stores (State Management)                           ││
│  │                                                              ││
│  │ useSessionLifecycleStore (Line 35-62)                       ││
│  │ ├─ sessions[] {id, name, isPinned, isTyping, ...}          ││
│  │ ├─ activeSessionId                                          ││
│  │ ├─ sessionNotes {id: hasNotes}                              ││
│  │ └─ actions: handleSessionSelect (clears unread)             ││
│  │                                                              ││
│  │ useFolderStore (Line 6-17)                                  ││
│  │ ├─ folders[] {id, name, parentId, provider}                ││
│  │ ├─ expandedFolderIds (Set) — localStorage-backed            ││
│  │ └─ toggleFolder(id) — updates localStorage                  ││
│  │                                                              ││
│  │ useUIStore (Line 5-41)                                      ││
│  │ ├─ isSidebarOpen / isSidebarPinned (localStorage)           ││
│  │ ├─ expandedProviderId (null or string)                      ││
│  │ └─ setters for each state                                   ││
│  │                                                              ││
│  │ useSystemStore (Line 12-72)                                 ││
│  │ ├─ orderedProviderIds                                       ││
│  │ ├─ providersById {id: {label, branding}}                   ││
│  │ ├─ workspaceCwds [{label, path, agent}]                    ││
│  │ ├─ branding {name, models, ...}                             ││
│  │ └─ slashCommands, customCommands                            ││
│  │                                                              ││
│  │ useCanvasStore (partial)                                    ││
│  │ └─ terminals[] — used by SessionItem for terminal icon      ││
│  └─────────────────────────────────────────────────────────────┘│
│                                                                   │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ CSS (Sidebar.css, 951 lines)                                ││
│  │ ├─ State classes: .active, .typing, .unread, .pinned        ││
│  │ ├─ Animations: breatheGlow (2s blue), greenBreatheGlow      ││
│  │ ├─ Responsive: mobile overlay vs desktop collapsible        ││
│  │ └─ Drag states: .drag-over                                  ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
             │ Socket.IO
             │
        [BACKEND]
```

**Data Flow:**
- User clicks session → `handleSessionSelect` socket emit → backend replies → `sessions[]` updated locally → `.active` class applied
- Backend emits `token` for background session → `isTyping: true` set → `.typing` class → `breatheGlow` CSS animation
- User expands folder → `toggleFolder()` → localStorage written → `expandedFolderIds` updated → FolderItem children render
- Provider accordion clicked → `expandedProviderId` set → only that provider's content visible

---

## The Critical Contract: Session Flags & Folder State

The sidebar's rendering is entirely driven by these two data shapes:

### Session Flags

Every session object has these runtime flags that control its visual state:

```typescript
interface ChatSession {
  id: string;                      // Unique UI session ID
  name: string;                    // Display name
  provider: string;                // Provider ID
  folderId: string | null;         // null = root; else = parent folder ID
  forkedFrom: string | null;       // null = not fork; else = parent session ID
  isSubAgent: boolean;             // true = shows bot icon, restricted actions
  isPinned: boolean;               // Affects sort order & .pinned CSS class
  isTyping: boolean;               // .typing CSS class → breatheGlow animation
  hasUnreadResponse: boolean;      // .unread CSS class → bold + solid border
  isWarmingUp: boolean;            // Loading state indicator
  parentAcpSessionId: string;      // For sub-agents: parent ACP session ID
  // ... other fields (model, messages, etc.)
}
```

**Critical invariants:**

1. **`folderId` must exist:** If a session has `folderId: "folder-123"`, that folder must exist in `useFolderStore.folders`. If not, the session disappears from sidebar.
2. **`forkedFrom` implies nesting:** If `forkedFrom: "parent-id"`, the session renders as a child of `parent-id` via `renderChildren()`, not as a root session.
3. **`isSubAgent` controls behavior:** Sub-agent sessions have restricted actions (no pin, rename, settings). Icons are always bot (green).
4. **`isPinned` affects sort:** Pinned sessions sort first, then unpinned (controlled in `handleTogglePin`, line 296-302).
5. **`isTyping` triggers animation:** Without this flag set, the `.typing` class never applies, and `breatheGlow` never plays.
6. **`hasUnreadResponse` persists:** Set by backend on `token_done`, cleared by `handleSessionSelect` (line 207).

### Folder Expansion State

```typescript
// useFolderStore
expandedFolderIds: Set<string>;     // Which folder IDs are expanded

// localStorage key: 'acpui-expanded-folders'
// Format: JSON stringified array of folder IDs
```

**Critical invariants:**

1. **Expansion is per-folder, not per-provider:** A folder remains expanded regardless of which provider is active.
2. **localStorage persists across page refreshes:** `expandedFolderIds` are saved/loaded (lines 21-26, 28-30).
3. **Expansion doesn't affect visibility if provider is collapsed:** If provider X's accordion is collapsed (`expandedProviderId !== X`), its folders are hidden regardless of expansion state.

### Provider Accordion State

```typescript
// useUIStore
expandedProviderId: string | null;  // Which provider's accordion is open

// Only one provider at a time can have expandedProviderId === itself
// null = all providers collapsed
```

**Critical invariants:**

1. **Only one provider shows content:** If `expandedProviderId === "my-provider"`, only that provider's sessions/folders render. All others hidden.
2. **Collapsed provider shows unread indicator:** If provider is collapsed but has typing/unread sessions, a small indicator shows (line 331-334).

---

## CSS Architecture & State Classes

All sidebar animations and visual states are driven by CSS classes applied to the session row based on session flags.

### State Classes

| Class | Condition | Visual Effect | CSS |
|-------|-----------|---------------|----|
| `.active` | `isActive === true` | Background highlight, text primary color | `bg-color: var(--user-msg-bg)` |
| `.pinned` | `isPinned === true` | Blue left border 3px, light blue bg | `border-left: 3px var(--accent-color)` |
| `.typing` | `isTyping === true` | Pulsing blue glow around element | `animation: breatheGlow 2s infinite` |
| `.unread` | `hasUnreadResponse === true` | Bold text, solid left border 3px, blue bg | `font-weight: 600; border-left: 3px solid` |
| `.awaiting-permission` | Permission pending | Pulsing green glow, green border | `animation: greenBreatheGlow 1.5s` |
| `.sub-agent` | `isSubAgent === true` | Restricted actions (no pin/rename) | N/A (React logic) |
| `.popped-out` | (external state) | Reduced opacity, faded border | `opacity: 0.5; border-color: faded` |

### Animations

#### breatheGlow (2s loop)
```css
@keyframes breatheGlow {
  0% {
    box-shadow: inset 0 0 5px rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.05);
  }
  50% {
    box-shadow: inset 0 0 15px rgba(59, 130, 246, 0.4);
    background: rgba(59, 130, 246, 0.1);
  }
  100% {
    box-shadow: inset 0 0 5px rgba(59, 130, 246, 0.2);
    background: rgba(59, 130, 246, 0.05);
  }
}
```
Applied to `.session-item.typing` — creates pulsing blue glow effect.

#### greenBreatheGlow (1.5s loop)
```css
@keyframes greenBreatheGlow {
  0% {
    box-shadow: inset 0 0 5px rgba(16, 185, 129, 0.2);
    background: rgba(16, 185, 129, 0.05);
  }
  50% {
    box-shadow: inset 0 0 20px rgba(16, 185, 129, 0.5);
    background: rgba(16, 185, 129, 0.15);
  }
  100% {
    box-shadow: inset 0 0 5px rgba(16, 185, 129, 0.2);
    background: rgba(16, 185, 129, 0.05);
  }
}
```
Applied to `.session-item.awaiting-permission` — creates pulsing green glow effect.

### Responsive Behavior

#### Mobile (≤ 768px)
```css
.sidebar {
  position: fixed;
  left: 0;
  top: 0;
  height: 100%;
  width: 312px;
  transform: translateX(-100%);           /* Off-screen by default */
  transition: transform 300ms ease-out;
  z-index: 1000;                          /* Above content */
}

.sidebar.open {
  transform: translateX(0);               /* Slide in */
}
```

Sidebar slides in from left as an overlay when opened.

#### Desktop (≥ 769px)
```css
.sidebar {
  position: relative;
  width: 312px;
  transition: width 300ms ease-out, opacity 300ms ease-out;
  flex-shrink: 0;                         /* Doesn't compress */
}

.sidebar:not(.open) {
  width: 0;                               /* Collapses to 0 */
  opacity: 0;                             /* Fade out */
  overflow: hidden;                       /* Hide contents */
}
```

Sidebar width toggles 0 ↔ 312px with smooth transitions.

### Indentation & Nesting

```typescript
// FolderItem (Line 139 in FolderItem.tsx)
<div style={{ paddingLeft: `${depth * 16}px` }}>

// SessionItem inside folder (via renderChildren, Line 263 in Sidebar.tsx)
<div style={{ paddingLeft: `${(depth + 1) * 12}px` }}>

// Fork indicator
<span className="fork-arrow">↳</span>  /* Positioned absolutely, blue color */
```

Each nesting level adds indentation: folders at 16px per level, sessions at 12px per level.

---

## Component Reference

### Frontend Components

| Component | File | Lines | Props | Key State | Purpose |
|-----------|------|-------|-------|-----------|---------|
| **Sidebar** | `Sidebar.tsx` | 15-502 | None | `searchQuery`, `sidebarWidth`, `showArchives`, `newFolderName` (localStorage-backed) | Main sidebar container; renders provider stacks, folders, sessions |
| **SessionItem** | `SessionItem.tsx` | 19-100 | `session`, `isActive`, `onSelect`, `onRename`, `onTogglePin`, `onArchive`, `onSettings` | `isEditing`, `editName` | Individual session row; applies state classes based on session flags |
| **FolderItem** | `FolderItem.tsx` | 22-225 | `folder`, `folders`, `sessions`, `depth`, `onSelect`, `onDrop*` | `isEditing`, `editName`, `isDragOver` | Folder node; recursively renders child folders and sessions |
| **WorkspacePickerModal** | `WorkspacePickerModal.tsx` | 13-61 | `workspaces`, `onSelect`, `onClose` | `search` | Modal for selecting workspace CWD when creating new chat |
| **ProviderStatusPanel** | `ProviderStatusPanel.tsx` | 9-158 | `providerId` | `isDetailsOpen` | Renders provider status cards (quota, spend); only visible if provider emits status |

### Store State (Sidebar-Relevant Fields)

| Store | File | Lines | Fields (Sidebar) |
|-------|------|-------|------------------|
| `useSessionLifecycleStore` | `useSessionLifecycleStore.ts` | 35-71 | `sessions[]`, `activeSessionId`, `sessionNotes {id: hasNotes}` |
| `useFolderStore` | `useFolderStore.ts` | 6-17 | `folders[]`, `expandedFolderIds` (localStorage: `acpui-expanded-folders`) |
| `useUIStore` | `useUIStore.ts` | 5-41 | `isSidebarOpen`, `isSidebarPinned` (localStorage: `isSidebarPinned`), `expandedProviderId` |
| `useSystemStore` | `useSystemStore.ts` | 12-72 | `orderedProviderIds`, `providersById`, `workspaceCwds`, `branding`, `slashCommands` |
| `useCanvasStore` | `useCanvasStore.ts` | 5-29 | `terminals[]` (used for terminal icon in SessionItem) |

### CSS

| File | Lines | Key Classes |
|------|-------|------------|
| `Sidebar.css` | 1-951 | `.sidebar`, `.session-item`, `.session-item.active/typing/unread/pinned`, `.folder-row`, `.provider-stack`, `.breatheGlow`, `.greenBreatheGlow`, responsive media queries |

---

## Gotchas & Important Notes

### 1. Session Must Have folderId Set Correctly
**What breaks:** Session disappears from sidebar, even though it exists in the database.

**Why:** The sidebar filters sessions by `folderId`. If a session's `folderId` points to a non-existent folder, it's filtered out during rendering.

**How to avoid:** Always ensure that when a folder is deleted, its sessions have `folderId` cleared to `null`. Backend handles this (cascade delete).

---

### 2. localStorage Keys Must Match Exactly
**What breaks:** Folder expansion state lost after page refresh; sidebar pinned state resets.

**Why:** Two fields are localStorage-backed: `expandedFolderIds` (key: `acpui-expanded-folders`) and `isSidebarPinned` (key: `isSidebarPinned`). If the key name changes in code but not everywhere it's referenced, state diverges.

**How to verify:** Check `useFolderStore.ts` Lines 19, 21, 28 for `acpui-expanded-folders` key. Check `useUIStore.ts` Lines 45-46, 68, 73 for `isSidebarPinned` key. Ensure consistent.

---

### 3. Only One Provider's Accordion Can Be Expanded
**What breaks:** Multiple provider stacks show content simultaneously, UI looks cluttered or performance lags.

**Why:** `expandedProviderId` is singular (string | null), not an array. Only one provider at a time has full content visibility.

**How to enforce:** When a provider stack header is clicked, set `setExpandedProviderId(p.providerId === expandedProviderId ? null : p.providerId)`. This toggle-closes any open provider and opens the clicked one.

---

### 4. Search Suppresses Folder Rendering
**What breaks:** User searches for a session, folder structure disappears, then user expects folders to reappear when search is cleared — but UI is momentarily inconsistent.

**Why:** During search, `searchQuery` is non-empty → line 386 in `Sidebar.tsx` skips folder rendering → only filtered sessions shown flat.

**How to handle:** This is intentional UX. Folders are hidden during search to show only matching sessions. When search is cleared, folders re-appear. No bug here, just unexpected if not documented.

---

### 5. renderChildren Recursion Has No Depth Limit
**What breaks:** Very deeply nested forks cause rendering lag or reach React recursion limit.

**Why:** `renderChildren(session, depth)` recursively calls itself for each fork. No depth limit is enforced.

**How to mitigate:** The depth limit is practical (users rarely fork more than 3-4 levels). If needed, add a check: `if (depth > 10) return null;`.

---

### 6. Lazy Sub-Agent Session Creation
**What breaks:** Sub-agent tab appears and immediately disappears, or empty ghost tab appears.

**Why:** Sub-agents are created on `sub_agent_started` event, but the session is only added to `sessions[]` when the first token arrives (line 176-196 in `useChatManager.ts`).

**How to prevent:** The lazy creation pattern is intentional — it prevents empty "warming up" tabs. If you need sub-agent sessions to appear immediately, modify `wrappedOnStreamToken` to create sessions eagerly.

---

### 7. CSS Animations Won't Play Without CSS Class
**What breaks:** Session is typing, but no blue glow appears.

**Why:** The animation only plays if `.typing` CSS class is applied. If `session.isTyping` is never set to `true`, the class is never added.

**How to debug:** In React DevTools, inspect the session-item element. Check its class list — should include `typing` if actively streaming. If not, check that the `isTyping` flag is being updated by socket event.

---

### 8. Drag & Drop Has Cycle Prevention
**What breaks:** Folder A is moved into folder B, but then folder B is moved into folder A, creating a cycle.

**Why:** `isDescendant()` check (Lines 228-235 in `FolderItem.tsx`) prevents cycles, but only if the check is called before the move.

**How to verify:** When folder drag-drop handler runs (`handleDropFolder`), it calls `isDescendant(targetFolderId, sourceFolderId)`. Only allow drop if false.

---

### 9. Pinned Sessions Re-Sort on handleTogglePin
**What breaks:** Pinned sessions don't move to the top, sort order is wrong.

**Why:** `handleTogglePin` (Line 296-302 in `useSessionLifecycleStore.ts`) mutates the `isPinned` flag and re-sorts `sessions[]`. If this sort logic is missing, pinning has no visual effect on order.

**How to verify:** Check that `handleTogglePin` includes:
```typescript
sessions: state.sessions
  .map(s => s.id === id ? { ...s, isPinned: !s.isPinned } : s)
  .sort((a, b) => (b.isPinned ? 1 : 0) - (a.isPinned ? 1 : 0))
```

---

### 10. Sub-Agent Sessions Must Have isSubAgent Flag
**What breaks:** Sub-agent session shows pin/rename/settings buttons (should be hidden).

**Why:** `SessionItem` checks `session.isSubAgent` to restrict actions (lines 70-75). If flag is not set, actions are shown.

**How to enforce:** When creating a sub-agent session, ensure `isSubAgent: true` is set in the session object. Backend does this via `sub_agent_started` event.

---

## Unit Tests

### Test Files

| File | Lines | Coverage |
|------|-------|----------|
| `frontend/src/test/Sidebar.test.tsx` | 100+ | Session rendering, pinned status, typing indicators, unread states, store integration |
| `frontend/src/test/SidebarExtended.test.tsx` | 73 | Provider stacks, search filtering, new chat handler, sidebar toggle |

### Test Execution

```bash
cd frontend
npx vitest run                           # Run all tests
npx vitest run Sidebar.test.tsx          # Run sidebar tests specifically
npx vitest run --coverage                # With coverage report
```

---

## How to Use This Guide

### For Debugging Sidebar Issues

1. **Session not appearing:** Check `sessions[]` in DevTools. Does it have `folderId` pointing to an existing folder? Is `provider` correct?
2. **No blue glow on typing:** Check if `.typing` class is on the element. If not, check `isTyping` flag. Verify socket event is firing.
3. **Folder won't expand:** Check `expandedFolderIds` in DevTools. Is the folder ID in the set? If not, `toggleFolder()` wasn't called or localStorage failed.
4. **Pinned sessions not moving:** Manually trigger sort. Check `handleTogglePin` in `useSessionLifecycleStore.ts`.
5. **Sub-agent ghost tab:** Check if sub-agent session is being created on `sub_agent_started` or on first token. Expected: lazy creation on first token.

### For Implementing New Sidebar Features

1. **New session indicator (e.g., "archived"):** Add a new CSS class and flag to the session object. Add CSS class to SessionItem className string.
2. **New folder feature:** Add action to FolderItem component and wire to `useFolderStore` action.
3. **New provider status:** Emit status from backend, render in ProviderStatusPanel.
4. **Keyboard shortcuts:** Listen in Sidebar component, call appropriate handler (select, delete, etc.).

### For Optimizing Sidebar Performance

1. **Reduce re-renders:** Use `useMemo` for `filteredSessions`, `rootSessions`, derived lists.
2. **Virtualize long lists:** If 1000+ sessions, use `react-virtual` or `react-window` for scrolling.
3. **Debounce search:** Add 300ms debounce to `searchQuery` state to avoid filtering on every keystroke.
4. **Lazy load folders:** Load child folders only when expanded, not all at once.

---

## Summary

The AcpUI sidebar is a **hierarchical, real-time UI** that:

1. **Renders a multi-layer hierarchy:** Providers → Folders → Sessions → Forks/Sub-agents, with collapsible accordions and recursive nesting
2. **Drives all visuals from session flags:** `isPinned`, `isTyping`, `hasUnreadResponse`, `isWarmingUp` directly control CSS classes and animations
3. **Uses five Zustand stores** to provide state: sessions, folders (with localStorage-backed expansion), UI state (sidebar open/pinned), system config (providers, branding), and canvas terminals
4. **Persists two fields to localStorage:** `isSidebarPinned` (sidebar open/closed) and `acpui-expanded-folders` (folder expansion state)
5. **Animates in real-time via CSS:** `breatheGlow` (blue, 2s) for typing, `greenBreatheGlow` (green, 1.5s) for permissions
6. **Responds to socket events instantly:** Typing, unread, sub-agent creation update session flags → CSS classes apply → animations fire
7. **Supports deep hierarchy:** Sessions can be organized into folders and forks with unlimited nesting depth and indentation

**The critical contract is the session object's flags:** `isPinned`, `isTyping`, `hasUnreadResponse`, `isWarmingUp`, `folderId`, `forkedFrom`, `isSubAgent`. Violate these contracts and sidebar display breaks.

Agents should be able to:
- ✅ Understand why a session doesn't appear (folderId check)
- ✅ Debug missing animations (CSS class check)
- ✅ Add a new session indicator (flag + CSS class + component update)
- ✅ Optimize long session lists (virtualization, debouncing)
- ✅ Understand provider stack accordion logic (only one expanded at a time)
- ✅ Trace a typing animation from socket event to CSS animation
