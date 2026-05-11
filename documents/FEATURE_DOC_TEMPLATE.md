# Feature Documentation Template & Guidelines

**This document describes how to create AcpUI Feature Docs — AI agent programming guides that bootstrap agents to instantly understand and work on specific features without exploring the codebase.**

---

## Purpose

Feature Docs are written for **AI agents**, not humans. They serve as self-contained technical guides that allow an agent to:
- Understand a feature completely without reading multiple files
- Know where code is located (via Function Names and exact Line Numbers)
- Understand data flow and architecture
- Know what "contracts" or "shapes" the feature depends on
- Start implementing or debugging without context bloat
- Reference unit tests immediately

A good Feature Doc means an agent can load it and within seconds have a complete mental model of the system.

---

## File Naming Convention

```
[Feature Doc] - <feature name>.md
```

Examples:
- `[Feature Doc] - ux_invoke_shell.md`
- `[Feature Doc] - session forking.md`
- `[Feature Doc] - Backend Architecture.md`

**Note:** Use hyphens in the filename, not underscores or spaces.

---

## Required Sections

Every Feature Doc must include these sections in this order:

### 1. **Title & Overview (Start)**
- Feature name as H1 heading
- 1-2 sentence description of what the feature does
- Statement of why it matters or common sources of confusion

### 2. **Overview Section**
- **What It Does** — Bullet list of 4-6 concrete actions the feature performs
- **Why This Matters** — 3-5 bullet points on importance/impact
- Brief mention of architectural role (backend, frontend, दोनों, provider-specific?)

### 3. **How It Works — End-to-End Flow** (The Core)
- Numbered steps (usually 8-12) that trace the complete data flow
- Each step should:
  - Have a clear title
  - Reference the exact file with **Function/Method name** and **Line numbers**: `File: path/to/file.js (Function: methodName, Lines 10-20)`
  - Include **key code snippets** (not full functions, just the critical lines)
  - Explain what happens and why
  - Connect to the next step

**Critical:** Narrate the actual execution path. An agent should be able to follow this flow with a debugger and understand every event. Using function names alongside line numbers ensures resilience to code shifts.

### 4. **Architecture Diagram**
- Mermaid or ASCII diagram showing:
  - Major components (backend, frontend, provider, etc.)
  - Data flow between them (solid arrows for normal flow, dashed for async/events)
  - How events/data are passed (Socket.IO, function calls, etc.)
- Must be readable at a glance
- Mermaid is preferred for complex flows; ASCII for simple ones

### 5. **The Critical Contract / Key Concept** (Most Important)
- What is the "contract" or "shape" that this feature depends on?
- If a component fails to follow this contract, what breaks?
- This section should make it crystal clear what could trip up a new implementation

Examples:
- For tools: **Tool System V2** integration via `toolRegistry`, `toolCallState`, and `toolInvocationResolver`.
- For sessions: The shape of the JSONL structure
- For permissions: The request/response format and what "selected" vs "cancelled" means

### 6. **Configuration / Provider-Specific Behavior** (If Applicable)
- What does a provider need to do to support this feature?
- What configuration files/functions are involved?
- **Be generic** — don't show specific provider implementations, show the pattern
- Use language like "A provider must...", "if a provider sends X...", "look for..."
- Show example patterns, not actual provider code
- Explain placeholder values like `{mcpName}` vs real values

### 7. **Data Flow / Rendering Pipeline** (If Applicable)
- Show the transformation of data as it moves through the system
- Include raw examples (what daemon sends) → normalized (what backend processes) → rendered (what UI shows)
- Use code blocks showing the data at each stage

### 8. **Component Reference**
- Table(s) listing all files involved, with:
  - File path
  - Key functions/methods (names with line anchors: `methodName (Line: X)`)
  - One-line purpose
- Separate tables for backend, frontend, database, provider (if applicable)

### 9. **Gotchas & Important Notes**
- List 5-10 "gotchas" — things that commonly break or confuse
- Each should be numbered and have a clear title
- Include:
  - What goes wrong
  - Why it happens
  - How to avoid it or detect it

### 10. **Unit Tests**
- List test files and their locations
- Group by backend/frontend/integration
- Include specific test names if they're particularly relevant

### 11. **How to Use This Guide**
- Subsection: "For implementing/extending this feature"
- Subsection: "For debugging issues with this feature"
- Provide a checklist or step-by-step guidance

### 12. **Summary**
- Recap the feature in 5-8 points
- Reiterate the critical contract
- One sentence on why agents should care

---

## What to Include

### Code Snippets

✅ **DO:**
- Show key lines only (not full function bodies)
- **Always include function names and line numbers** in headers
- Format as: `// FILE: path/to/file.js (Function: name, Lines X-Y)`
- Provide context (1-2 lines before/after) so the snippet is understandable

✅ Example:
```javascript
// FILE: backend/services/sessionManager.js (Function: getMcpServers, Lines 28-35)
export function getMcpServers(providerId) {
  const name = getProvider(providerId).config.mcpName;  // LINE 28
  if (!name) return [];
  // ... rest of snippet
}
```

❌ **DON'T:**
- Include entire files or huge functions
- Show code without line numbers or function context
- Show provider-specific implementations (e.g., "Kiro does X")

### Pattern-Based Referencing

✅ **DO:**
- Use the standard pattern: `File: path/to/file.js (Function: methodName, Lines X-Y)`
- This is the **Primary Key** for AI agents to find code. Even if lines shift, the function name allows them to locate the logic via search.

### Line Numbers

✅ **DO:**
- Always reference exact line numbers: `(Lines 45-67)`, `(Line 120)`
- These must be verified at the time of writing to match the current codebase.

---

## Structure & Flow

### Narrative Flow

The **How It Works** section should read like a continuous narrative:
- Step 1 happens
- Which triggers Step 2
- Which causes Step 3
- etc.

An agent should be able to follow the flow with a debugger breakpoint and understand every line they encounter.

### Specificity

- Be as specific as possible with line numbers, function names, and file paths.
- "The backend emits an event" is vague; "The backend emits `token_done` via `io.emit()` in `registerPromptHandlers` (Line 127)" is useful.

---

## Checklist Before Submitting

- [ ] Title and overview explain what the feature is
- [ ] "How It Works" section traces a complete end-to-end flow with function names and line numbers
- [ ] Architecture diagram shows data flow clearly
- [ ] Critical contract/shape is explicitly stated
- [ ] Tool System V2 integration is documented for tools
- [ ] Component reference table has function names and line anchors
- [ ] 5-10 gotchas are listed with explanations
- [ ] Unit test locations are provided
- [ ] All file paths are relative to the project root (e.g., `backend/services/foo.js`)

---

## Example Structure (Outline)

```
# Feature Doc — [Feature Name]

## Overview
- What It Does
- Why This Matters

## How It Works — End-to-End Flow
1. [Step 1: Title, File (Function, Lines), key snippet]
2. [Step 2: Title, File (Function, Lines), key snippet]
... (8-12 steps)

## Architecture Diagram
[Mermaid or ASCII]

## The Critical Contract: [Contract Name]
[What shape/protocol/interface must be followed, why, what breaks if ignored]

## Configuration / Provider Support (if applicable)
[What a provider must do, generic patterns, example configurations]

## Component Reference
[Tables: Backend Files, Frontend Files, Database, Provider (if applicable)]

## Gotchas & Important Notes
[5-10 numbered gotchas with explanations]

## Unit Tests
[Test file locations and relevant test names]

## Summary
[Key takeaways and critical contract restatement]
```
