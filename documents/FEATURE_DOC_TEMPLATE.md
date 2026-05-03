# Feature Documentation Template & Guidelines

**This document describes how to create AcpUI Feature Docs — AI agent programming guides that bootstrap agents to instantly understand and work on specific features without exploring the codebase.**

---

## Purpose

Feature Docs are written for **AI agents**, not humans. They serve as self-contained technical guides that allow an agent to:
- Understand a feature completely without reading multiple files
- Know where code is located (with exact line numbers)
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
- `[Feature Doc] - permission system.md`

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
- Brief mention of architectural role (backend, frontend, both, provider-specific?)

### 3. **How It Works — End-to-End Flow** (The Core)
- Numbered steps (usually 8-12) that trace the complete data flow
- Each step should:
  - Have a clear title
  - Reference the exact file with line numbers
  - Include **key code snippets** (not full functions, just the critical lines)
  - Explain what happens and why
  - Connect to the next step

**Critical:** Narrate the actual execution path. An agent should be able to follow this flow with a debugger and understand every event.

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
- For ux_invoke_shell: The exact shape of `system_event` that the UI hooks on
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
  - Key functions (just names, not full signatures)
  - Exact line numbers
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
- **Always include line numbers** in comments (e.g., `// LINE 45`)
- Provide context (1-2 lines before/after) so the snippet is understandable
- Format as: File path comment + code block with language tag

✅ Example:
```javascript
// FILE: backend/services/sessionManager.js (Lines 18-32)
export function getMcpServers(providerId) {
  const name = getProvider(providerId).config.mcpName;  // LINE 18
  if (!name) return [];
  const proxyPath = path.resolve(__dirname, '..', 'mcp', 'stdio-proxy.js');  // LINE 20
  // ... rest of snippet
}
```

❌ **DON'T:**
- Include entire files or huge functions
- Show code without line numbers
- Show provider-specific implementations (e.g., "Kiro does X")
- Include boilerplate or unrelated code

### Data Structures / Interfaces

✅ **DO:**
- Show the shape of key objects/events
- Use TypeScript interfaces or JSON schema
- Include field descriptions inline
- Mark required vs optional fields

✅ Example:
```typescript
interface SystemEvent {
  providerId: string;           // Required
  sessionId: string;            // Required
  type: 'tool_start' | 'tool_update' | 'tool_end';
  id: string;                   // Unique identifier
  output?: string;              // Optional
}
```

### Line Numbers

✅ **DO:**
- Always reference exact line numbers: `(Lines 45-67)`, `(Line 120)`, `(Lines 25-38)`
- Format as: `// FILE: path/to/file.js (Lines X-Y)` or `**File:** path/to/file.js (Lines X-Y)`
- This lets agents quickly find and load surrounding code if needed

❌ **DON'T:**
- Say "around line 45" or "near line 50"
- Omit line numbers entirely

### Diagrams

✅ **DO:**
- Use Mermaid for complex multi-component flows
- Use ASCII for simple flows or when Mermaid would be overkill
- Label arrows with what data/events flow (Socket.IO, function call, async event, etc.)
- Use subgraph containers for logical areas (Frontend, Backend, Provider, Database)
- Include a caption explaining what the diagram shows

✅ Example caption:
```
Data flow from ACP daemon → backend processing → Socket.IO event → frontend rendering
```

❌ **DON'T:**
- Create diagrams that are hard to parse
- Skip labeling what flows between components
- Include implementation details in the diagram (let the text explain those)

---

## What NOT to Include

### Don't Include:

❌ **Provider-specific examples**
- Don't say "Kiro does X" or "Claude implements Y"
- Don't show actual code from specific providers
- Instead: "A provider must..." or "If a provider sends X..."

❌ **Obvious/boilerplate code**
- Imports, requires, basic loops
- Configuration file examples that are already documented elsewhere
- Function signatures without purpose

❌ **Implementation variants**
- "Provider A could do X, Provider B could do Y"
- Instead, explain the pattern/contract and let each provider implement their way

❌ **Historical context**
- "We originally did it this way but changed it because..."
- Just explain what it does now

❌ **Unrelated features**
- Keep the scope focused
- If another feature is needed for context, reference it (link to its doc) but don't explain it

❌ **The entire file contents**
- Show key functions with line numbers, not the whole file
- Agents can load the file if they need more context

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

- Be as specific as possible with line numbers and file paths
- "Around line 100" is useless; "Lines 98-103" is useful
- "The backend emits an event" is vague; "The backend emits `tool_output_stream` via `io.emit()` at line 92" is useful

### Generality (For Providers)

- "A provider must implement X" ✅
- "Here's how Kiro implements X" ❌
- "If a provider sends JSON as {x, y, z}, the backend normalizes it to {a, b, c}" ✅
- "Kiro sends {bash_output, error}, Claude sends {stdout, stderr}" ❌

---

## Length & Scope

- **Target length:** 5,000-10,000 words (roughly 30-50 minutes of reading for a human, much faster for an agent skimming)
- **Scope:** One feature, not multiple related features
  - ✅ "Session forking"
  - ✅ "Permission system"
  - ❌ "Sessions, forking, and history" (too broad)
- **Depth:** Deep enough that an agent can implement a provider's support or debug an issue, without exploring the codebase

---

## Common Pitfalls

### ❌ Pitfall 1: Over-explaining the obvious
- Don't explain JavaScript/TypeScript syntax
- Don't explain what Socket.IO is in detail
- Assume the agent knows the basics

### ❌ Pitfall 2: Conflating concepts
- "The provider implements X" vs "Providers implement X" — be consistent
- "The UI renders..." vs "The UI may render..." — be precise

### ❌ Pitfall 3: Forgetting the "critical contract"
- Every feature has a contract (a shape, a protocol, an interface)
- If you don't make this explicit, agents will miss it
- This is often the #1 source of confusion for new implementations

### ❌ Pitfall 4: Missing line numbers
- "See the file backend/services/foo.js for the handler"
- Should be: "See `backend/services/foo.js:45-67` for the handler" (exact lines)

### ❌ Pitfall 5: Too many provider examples
- Tempting to show "here's how Kiro does it, here's how Claude does it"
- Instead, explain the pattern once and let agents study real providers

---

## Checklist Before Submitting

- [ ] Title and overview explain what the feature is
- [ ] "How It Works" section traces a complete end-to-end flow with line numbers
- [ ] Architecture diagram shows data flow clearly
- [ ] Critical contract/shape is explicitly stated
- [ ] Configuration section is generic (not provider-specific)
- [ ] Component reference table has file paths, function names, and line numbers
- [ ] 5-10 gotchas are listed with explanations
- [ ] Unit test locations are provided
- [ ] Code snippets include line numbers and context
- [ ] No provider-specific implementations shown (use "A provider must..." language instead)
- [ ] No boilerplate or unrelated code
- [ ] Reading the doc, an agent could start implementing without exploring other files
- [ ] All file paths are relative to the project root (e.g., `backend/services/foo.js`)
- [ ] All code blocks have language tags (javascript, typescript, json, bash, etc.)

---

## Example Structure (Outline)

```
# Feature Doc — [Feature Name]

## Overview
- What It Does
- Why This Matters

## How It Works — End-to-End Flow
1. [Step 1: What happens, file:line, key snippet]
2. [Step 2: Next action, file:line, key snippet]
... (8-12 steps)

## Architecture Diagram
[Mermaid or ASCII]

## The Critical Contract: [Contract Name]
[What shape/protocol/interface must be followed, why, what breaks if ignored]

## Configuration / Provider Support (if applicable)
[What a provider must do, generic patterns, example configurations]

## Data Flow Example (if applicable)
[Raw input → Normalized → Rendered, with examples at each stage]

## Component Reference
[Tables: Backend Files, Frontend Files, Database, Provider (if applicable)]

## Gotchas & Important Notes
[5-10 numbered gotchas with explanations]

## Unit Tests
[Test file locations and relevant test names]

## How to Use This Guide
- For implementing/extending
- For debugging

## Summary
[Key takeaways and critical contract restatement]
```

---

## Tools & Techniques

### Line Number Accuracy

When referencing code:
1. Open the file
2. Find the exact lines you're discussing
3. Comment them in the snippet with `// LINE X`
4. Provide file:line reference before the code block

### Creating Architecture Diagrams

Use **Mermaid** for:
- Multi-step flows
- Complex component interactions
- Async/event-driven systems

Use **ASCII** for:
- Simple linear flows
- When Mermaid is overkill

Both should be readable in plain text (no fancy formatting).

### Testing Your Doc

Ask yourself:
- Could an agent implement support for this feature using only this doc? (Maybe 80% confidence)
- If an agent encounters a bug, could they debug it using this doc? (Yes, with the gotchas section)
- Is every file path and line number correct? (Verify them)
- Did I explain the critical contract? (Yes, explicitly)

---

## Final Words

The goal is **instant comprehension**. An agent should:
1. Skim the overview (30 seconds)
2. Read the How It Works flow (5 minutes)
3. Look at the architecture diagram (1 minute)
4. Find the critical contract (1 minute)
5. Reference the component table for specific code (as needed)

If an agent needs more than 20 minutes to understand the feature at a high level, the doc isn't specific enough.

**Quality over length.** A focused 5,000-word guide is better than a 15,000-word guide that meanders.
