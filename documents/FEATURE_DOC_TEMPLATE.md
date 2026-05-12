# Feature Documentation Template & Guidelines

**This document describes how to create AcpUI Feature Docs: AI agent programming guides that bootstrap agents to understand and work on specific features without broad codebase exploration.**

---

## Purpose

Feature Docs are written for **AI agents**, not as general user documentation. They serve as self-contained technical guides that allow an agent to:
- Understand a feature without reading unrelated files
- Know where code is located through stable file paths, function names, component names, exported symbols, event names, config keys, and test names
- Understand data flow and architecture
- Know what contracts or shapes the feature depends on
- Start implementing or debugging with minimal context bloat
- Find unit tests immediately

A good Feature Doc lets an agent load it and quickly build a working mental model of the system.

---

## Critical Principle: Document Present State Only

**Feature Docs are living documents that describe the system as it exists today. They are not historical records.**

This means:
- **Never mention older implementations** - do not say "The system used to X, but now does Y." Only describe how it works now.
- **Never use past-tense implementation history** - say "Sessions are stored in project directories" not "Sessions were stored flat, but are now stored in project directories."
- **Never compare to previous architectures** - if the system changes, document the current architecture only.
- **Update named anchors and code snippets when code changes** - function names, component names, event names, config keys, and snippets must stay accurate.
- **Replace obsolete sections entirely** - do not keep outdated patterns for context.

**Why**: Agents rely on Feature Docs as the source of truth for how the system works today. Mixing old and new information creates ambiguity.

**Example of what to avoid:**
```markdown
Previously, context state was stored in memory. Now we persist it to disk at <location>.
```

**Example of what to do:**
```markdown
Context usage state is persisted to disk at <location> and loaded on startup.
```

---

## Critical Principle: Stable Anchors, Not Line Numbers

Feature Docs use references that survive normal refactors:
- File paths relative to the repository root
- Function, method, class, component, hook, store action, and exported symbol names
- Socket event names, API routes, config keys, database tables, and protocol fields
- Short code snippets with enough surrounding context to search for the logic
- Test file paths and specific test names

Do **not** use line numbers in Feature Docs. Line numbers drift during normal edits and create maintenance work without adding much value. When refreshing an existing Feature Doc, remove line-number anchors from the sections you update.

Preferred reference format:
```markdown
File: `backend/services/sessionManager.js` (Function: `getMcpServers`)
File: `frontend/src/components/ChatInput/ChatInput.tsx` (Component: `ChatInput`, Handler: `handleSubmit`)
File: `backend/sockets/sessionHandlers.js` (Socket event: `fork_session`)
```

Preferred code snippet header:
```javascript
// FILE: backend/services/sessionManager.js (Function: getMcpServers)
export function getMcpServers(providerId) {
  const name = getProvider(providerId).config.mcpName;
  if (!name) return [];
  // ...only include the critical branch or contract shape...
}
```

If a relevant block has no stable function or symbol, name the nearest searchable anchor:
```markdown
File: `backend/server.js` (Startup block: `registerPromptHandlers(io, client)`)
File: `frontend/src/store/useStreamStore.ts` (Store action: `enqueueEvent`, Search token: `processBuffer`)
```

---

## File Naming Convention

```
[Feature Doc] - <Feature Name>.md
```

Examples:
- `[Feature Doc] - ux_invoke_shell.md`
- `[Feature Doc] - Session Forking.md`
- `[Feature Doc] - Backend Architecture.md`

Use the feature name that matches the BOOTSTRAP index so agents can find the document predictably.

---

## Required Sections

Every Feature Doc must include these sections in this order:

### 1. Title & Overview
- Feature name as an H1 heading
- 1-2 sentence description of what the feature does
- Statement of why it matters or what commonly confuses agents

### 2. Overview
- **What It Does** - 4-6 concrete actions the feature performs
- **Why This Matters** - 3-5 bullets on importance and impact
- Brief architectural role: backend, frontend, both, provider-specific, MCP tool, persistence, etc.

### 3. How It Works - End-to-End Flow
- Numbered steps, usually 8-12, tracing the complete data flow
- Each step should:
  - Have a clear title
  - Reference exact file paths plus stable anchors such as function, component, event, route, config key, or store action names
  - Include key code snippets, not full functions
  - Explain what happens and why
  - Connect to the next step

**Critical:** Narrate the actual execution path. An agent should be able to follow this flow with debugger breakpoints or repository search and understand every event.

### 4. Architecture Diagram
- Mermaid or ASCII diagram showing:
  - Major components: backend, frontend, provider, database, MCP layer, etc.
  - Data flow between them
  - How events and data are passed: Socket.IO, function calls, JSON-RPC, filesystem, SQLite, HTTP, etc.
- Mermaid is preferred for complex flows; ASCII is acceptable for simple flows.

### 5. The Critical Contract / Key Concept
- State the core contract or data shape the feature depends on
- Explain what breaks if a component fails to follow it
- Make implementation hazards explicit

Examples:
- For tools: Tool System V2 integration through `toolRegistry`, `toolCallState`, and `toolInvocationResolver`
- For sessions: JSONL structure and persistence ownership
- For permissions: request/response format and how approval state maps to UI behavior

### 6. Configuration / Provider-Specific Behavior (If Applicable)
- What a provider or config file must do to support this feature
- Which configuration files, provider hooks, runtime fields, or feature flags are involved
- Keep generic docs generic: say "A provider must..." rather than naming a specific provider
- Show patterns and placeholder values, not provider-specific implementations

### 7. Data Flow / Rendering Pipeline (If Applicable)
- Show how data transforms as it moves through the system
- Include raw examples, normalized backend shapes, store shapes, and rendered UI expectations
- Use focused code blocks for the data at each stage

### 8. Component Reference
- Table(s) listing all files involved, with:
  - File path
  - Stable anchors: functions, components, hooks, classes, events, routes, store actions, exports, config keys, or tables
  - One-line purpose
- Separate tables for backend, frontend, database, provider, tests, and configuration when useful

Suggested table:
```markdown
| Area | File | Anchors | Purpose |
|---|---|---|---|
| Backend | `backend/services/sessionManager.js` | `getMcpServers`, `loadSession` | Resolves provider MCP config and session state |
```

### 9. Gotchas & Important Notes
- List 5-10 gotchas
- Each should be numbered and have a clear title
- Include:
  - What goes wrong
  - Why it happens
  - How to avoid it or detect it

### 10. Unit Tests
- List test files and their locations
- Group by backend, frontend, integration, or provider when useful
- Include specific test names for important edge cases
- Mention test helpers or mocks that agents should understand before editing tests

### 11. How to Use This Guide
- Subsection: "For implementing/extending this feature"
- Subsection: "For debugging issues with this feature"
- Provide a checklist or step-by-step guidance using file/function anchors

### 12. Summary
- Recap the feature in 5-8 points
- Reiterate the critical contract
- State why agents should care when changing this area

---

## What to Include

### Code Snippets

Do:
- Show key logic only, not full files or full functions
- Include file paths and stable anchors in snippet headers
- Provide enough surrounding context for repository search
- Include the critical branch, event payload, data shape, or state transition

Example:
```javascript
// FILE: backend/services/sessionManager.js (Function: getMcpServers)
export function getMcpServers(providerId) {
  const name = getProvider(providerId).config.mcpName;
  if (!name) return [];
  return [{ name, command: 'node', args: ['mcpServer.js'] }];
}
```

Do not:
- Include entire files or huge functions
- Use line-number anchors in headings, snippets, tables, or prose
- Show code without file path and function/component/event context
- Put provider-specific examples in generic docs

### Pattern-Based Referencing

Use this pattern:
```markdown
File: `path/to/file.js` (Function: `functionName`)
File: `path/to/file.tsx` (Component: `ComponentName`, Hook: `useSomething`)
File: `path/to/file.js` (Socket event: `event_name`)
File: `path/to/config.json` (Config key: `some.key.path`)
```

These references are the primary keys agents use to find code quickly. If a symbol is renamed, update the Feature Doc in the same change.

---

## Structure & Flow

### Narrative Flow

The **How It Works** section should read like a continuous execution path:
- Step 1 happens
- Which triggers Step 2
- Which causes Step 3
- Which emits or persists Step 4

An agent should be able to follow the flow with debugger breakpoints, repository search, and the referenced file/function anchors.

### Specificity

Be as specific as possible with file paths, symbol names, event names, data shapes, and config keys.

Weak:
```markdown
The backend emits an event.
```

Useful:
```markdown
`registerPromptHandlers` in `backend/sockets/promptHandlers.js` emits `token_done` after the stream controller flushes assistant output.
```

---

## Checklist Before Submitting

- [ ] Title and overview explain what the feature is
- [ ] "How It Works" traces a complete end-to-end flow with stable file/function/event anchors
- [ ] Architecture diagram shows data flow clearly
- [ ] Critical contract or data shape is explicit
- [ ] Tool System V2 integration is documented for MCP tools
- [ ] Component reference table uses file paths and stable anchors, not line numbers
- [ ] 5-10 gotchas are listed with explanations
- [ ] Unit test files and important test names are listed
- [ ] All file paths are relative to the project root
- [ ] Generic docs avoid provider-specific examples
- [ ] The document describes the current implementation only

---

## Example Structure

```markdown
# Feature Doc - [Feature Name]

## Overview
- What It Does
- Why This Matters

## How It Works - End-to-End Flow
1. [Step 1: Title, File + Function/Component/Event, key snippet]
2. [Step 2: Title, File + Function/Component/Event, key snippet]
...

## Architecture Diagram
[Mermaid or ASCII]

## The Critical Contract: [Contract Name]
[What shape/protocol/interface must be followed, why, what breaks if ignored]

## Configuration / Provider Support (if applicable)
[What a provider must do, generic patterns, example configurations]

## Data Flow / Rendering Pipeline (if applicable)
[Raw input -> normalized backend shape -> store state -> rendered UI]

## Component Reference
[Tables: Backend, Frontend, Database, Provider, Config, Tests as applicable]

## Gotchas & Important Notes
[5-10 numbered gotchas with explanations]

## Unit Tests
[Test file locations and relevant test names]

## How to Use This Guide
[Implementation and debugging checklists]

## Summary
[Key takeaways and critical contract restatement]
```
