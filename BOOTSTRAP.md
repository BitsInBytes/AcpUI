# AI Developer Bootstrapping Protocol: AcpUI

This document is a machine-readable context injector. When starting a new session, the Agent should read this file first to understand the architecture, standards, and testing requirements of the repository.

## 0. Immediate Context Loading

### Step 1: Read This File
You are reading it now. This file defines rules, standards, and the documentation index.

### Step 2: Load Core Architecture Docs
After reading this file, the agent **must** load and parse the following files to establish a complete understanding of the system:
- `README.md` (Root) — High-level overview.
- `documents/[Feature Doc] - Backend Architecture.md` — Backend architecture and service map.
- `documents/[Feature Doc] - Frontend Architecture.md` — Frontend architecture and store map.

### Step 3: Load Relevant Feature Docs
Based on the task at hand, load the appropriate Feature Docs from `documents/[Feature Doc] - *.md` using the index in Section 5 of this document.

## 1. Core Architectural Mental Model
AcpUI is a **provider-agnostic** bridge between a web UI and AI agents communicating via the **Agent Client Protocol (ACP)**.

### The Three-Tier Flow:
1.  **Frontend (React/Vite/Zustand)**: A high-fidelity interface that consumes a "Unified Timeline." It has **zero** knowledge of specific AI models or providers; it only knows how to render normalized data and branding provided by the backend.
2.  **Backend (Node.js/Socket.io/SQLite)**: The orchestrator. It manages the lifecycle of ACP daemons, handles session persistence in SQLite, and routes messages. It uses `AsyncLocalStorage` to maintain strict provider isolation.
3.  **Provider (The Logic Layer)**: A directory-based module (e.g., `providers/my-provider/`) that implements a specific interface contract (`index.js`). It translates raw JSON-RPC daemon output into the AcpUI standard.

### Provider-Specific Development
When working on changes related to a specific provider, you **must** load and read the following in order:

1. **`documents/[Feature Doc] - Provider System.md`** — The generic provider contract and architecture. Understand how ALL providers work.
2. **`documents/[Feature Doc] - <Provider> Provider.md`** — The provider-specific supplement. Shows line numbers, gotchas, and implementation details for that provider (e.g., `[Feature Doc] - Claude Provider.md`, `[Feature Doc] - Kiro Provider.md`).
3. **All `.md` files in `providers/<provider>/`** — Read every markdown file in the provider's directory:
   - **`README.md`** — Installation, configuration, and operational guide
   - **`provider.json`** — Configuration schema, tool patterns, branding, and protocol prefix
   - **Any other `.md` files** — May include `SESSION_META_DATA.md`, `ACP_PROTOCOL_SAMPLES.md`, or other references specific to that provider. Read these when referenced by the Feature Doc.

Load these **in order** and **use them alongside the code** when implementing provider features. The Feature Docs contain exact line numbers that point directly to relevant code sections.

### Critical Concept: The Unified Timeline
Everything in the UI—thoughts, tool calls, text, and permissions—is treated as a chronological sequence of "steps" in a timeline. Never bypass this normalization.

## 2. Feature Documentation Index

All system features are documented in **Feature Docs** under `documents/[Feature Doc] - *.md`. These are the authoritative sources for understanding specific systems. Load them based on the task.

**Before exploring a new code area, check if a Feature Doc exists for it.** If you're working on a task and discover you need to understand or modify code outside the scope of your already-loaded Feature Docs, load the relevant Feature Doc for that area **before** diving into code exploration. This prevents wasted time re-reading and re-understanding code that's already documented. The Feature Doc will contain exact line numbers, architecture diagrams, and gotchas you need to know, so you can jump directly to the relevant code instead of exploring blindly.

### Architecture Overview Docs

Start with these when beginning any backend or frontend work. They provide the foundational architecture understanding, exact line numbers, and end-to-end flows.

- **[Feature Doc] - Backend Architecture.md** — Full backend layer: server bootstrap, ACP client lifecycle, socket handlers, session management, MCP tool system, and SQLite persistence. **Load this when starting any backend work.**
- **[Feature Doc] - Frontend Architecture.md** — Full frontend layer: Zustand store split, Socket.IO singleton, streaming/typewriter pipeline, session switching, model state management, and branding system. **Load this when starting any frontend work.**

### Frontend UI Component Docs

- **[Feature Doc] - Sidebar Rendering.md** — How the sidebar renders its hierarchical session/folder UI: component tree, state management, CSS animations, real-time updates. Load this when debugging sidebar display, adding session indicators, or optimizing sidebar performance. Focus is on rendering, not feature logic (forking/archiving are separate).
- **[Feature Doc] - Provider Status Panel.md** — Real-time status display for AI provider metrics (quota, spend, rate limits). Covers the backend cache mechanism, frontend routing pipeline, type contract, and component rendering (compact summary + details modal). Load this when implementing provider status emission, debugging status not appearing, or extending status metrics.
- **[Feature Doc] - Message Bubble UI & Typewriter System.md** — Streaming pipeline + message rendering. Covers socket event queuing per session, three-phase processBuffer (events → thoughts → tokens), adaptive typewriter algorithm, Unified Timeline step types, collapse management, MemoizedMarkdown splitting, and priority tool output rendering. Load this when implementing streaming optimizations, debugging render issues, or enhancing output formatting.
- **[Feature Doc] - Canvas System.md** — File artifact management and split-screen editor. Covers artifact lifecycle, deduplication, git integration, file persistence to SQLite, and session scoping. Load this when implementing canvas features, debugging artifact sync, or extending the editor (new view modes, tool output handling).
- **[Feature Doc] - Terminal in Canvas.md** — PTY-backed terminal tabs inside the canvas pane. Covers session-scoped shell spawning, input/output streaming, resize handling, and spawn-once guarantee. Load this when adding terminal features, debugging shell issues, or extending multi-terminal support.
- **[Feature Doc] - Session Archiving.md** — Soft-delete system moving inactive sessions to archive while preserving complete state. Covers cascade deletion of descendants, archive folder structure, session.json metadata, provider-specific archiving methods, merge-only restore (new IDs, never replace), and permanent deletion. Load this when implementing retention policies, debugging restore issues, or extending archive behavior.
- **[Feature Doc] - Session Forking.md** — Full fork and merge lifecycle: fork creation flow, ACP session cloning, DB schema, sidebar hierarchy rendering, merge-back flow (summary capture, parent injection), cascade deletion, and title generation. Load this when implementing fork features, debugging fork/merge issues, or extending fork behavior.
- **[Feature Doc] - Pop Out Chat.md** — Detached window feature for side-by-side chat viewing. Covers BroadcastChannel-based session ownership coordination, window initialization, session state isolation, and cleanup on close. Load this when implementing pop-out features, debugging window synchronization issues, or extending multi-window support.
- **[Feature Doc] - Chat Header.md** — Top-level chat status and control bar. Covers provider/session title resolution, connection indicator rendering, pop-out mode control gating, and UI store toggles for sidebar/explorer/settings. Load this when implementing header controls, debugging missing/incorrect header titles, or investigating pop-out header behavior.
- **[Feature Doc] - Auto-scroll System.md** — Chat viewport stickiness and manual override behavior. Covers `useScroll` lifecycle, `isAutoScrollDisabled` persistence, `ResizeObserver` pinning, back-to-bottom controls, and stream-driven scroll triggers. Load this when debugging scroll regressions, changing auto-scroll UX, or extending message viewport behavior.
- **[Feature Doc] - Chat Input and Prompt Area.md** — Footer input component with file attachments, image compression, model quick-select, and slash command autocomplete. Covers textarea auto-height, clipboard paste handling, HTTP file upload with multer, sharp image compression (JPEG quality 85), model selection UI, and context usage display. Load this when implementing input features, debugging attachments/uploads, or extending model selection.
- **[Feature Doc] - File Explorer.md** — Full-screen file browser modal triggered from the ChatHeader. Covers tree lazy-loading, Monaco editor with syntax highlighting, markdown preview toggle, auto-save with debounce, dirty state tracking, and backend safePath security validation. Load this when implementing file browser features, debugging explorer issues, or extending the code editor.
- **[Feature Doc] - System Settings Modal.md** — Five-tab configuration hub for audio devices, environment variables, workspace definitions, custom commands, and provider-specific settings. Covers socket-callback pattern, dual JSON validation, immediate runtime updates via `process.env`, and multi-provider config isolation. Load this when adding new config tabs, debugging config persistence, or extending the Monaco editor integration.
- **[Feature Doc] - Voice-to-Text System.md** — Speech-to-text via whisper.cpp (ggml-small.bin model, local inference). Covers Web Audio API microphone capture, WAV encoding (16kHz downsampling), whisper-server spawning, and text insertion into Chat Input. Load this when implementing voice features, debugging audio capture/transcription, or extending STT functionality.
- **[Feature Doc] - Session Settings Modal.md** — Per-session configuration hub: 5-tab modal for system info, model selection, provider options, JSONL rehydration, export, and delete. Covers the full rehydration pipeline, optimistic model change flow, dynamic config options, and context usage display. Load this when working on session configuration, debugging model switching, or implementing rehydration.

### Generic Feature Docs (All Providers)
- **[Feature Doc] - Provider System.md** — The pluggable adapter architecture. Load this when understanding how providers work, implementing a new provider, or debugging provider-related issues. **Start here for provider work.**
- **[Feature Doc] - ux_invoke_shell.md** — Custom UI MCP tool for executing shell commands. Load this when implementing shell execution, streaming output, or debugging shell-related features.
- **[Feature Doc] - ux_invoke_subagents.md** — Custom UI MCP tool for spawning parallel agents. Load this for agent orchestration, parallel execution, or subagent communication features.
- **[Feature Doc] - MCP Server System.md** — How AcpUI's MCP server works. Load this when adding new MCP tools or debugging MCP protocol issues.
- **[Feature Doc] - Auto Chat Title Generation.md** — Background title generation for new and forked sessions. Covers ephemeral session creation, statsCaptures buffering, model selection, rename conditions, and socket emission. Load this when implementing title generation, debugging missing/wrong titles, or extending title logic.
- **[Feature Doc] - JSONL Rehydration & Session Persistence.md** — Full session persistence lifecycle: DB-first architecture, JSONL as provider ground truth, three rehydration paths (lazy sync, forced rehydration, ACP drain), periodic streaming saves, and provider interface contract. Load this when implementing session recovery, debugging stale/missing messages, extending persistence, or implementing rehydration for a new provider.
- **[Feature Doc] - Notification System.md** — Multi-modal notifications (desktop toasts, audio, .env config) for background session completion. Covers active session suppression, sub-agent exclusion, workspace-aware notification bodies, environment variable defaults, browser permission flow, and audio fallback patterns. Load this when extending notifications to new events, debugging silent notification failures, or implementing notification preferences.

### Provider-Specific Feature Docs (Supplements)
These are **sidecar supplements** to the Provider System doc. Load them **alongside** the main Provider System doc when working on a specific provider. They show provider-specific implementations, gotchas, and line numbers.

- **[Feature Doc] - Claude Provider.md** — Claude-specific implementation details. Load this when working on Claude provider features: quota proxy, tool aliasing, project-scoped sessions, spawn-time agents, etc. **Shows the reference implementation.**
- **[Feature Doc] - Codex Provider.md** — Codex-specific implementation details. Load this when working on Codex provider features: `codex-acp` auth, dynamic models/config options, recursive rollout JSONL files, slash commands, and MCP tool normalization.
- **[Feature Doc] - Gemini Provider.md** — Gemini-specific implementation details. Load this when working on Gemini provider features: context tracking, OAuth quota fetching, argument caching, missing tool outputs, history rewinds, etc.
- **[Feature Doc] - Kiro Provider.md** — Kiro-specific implementation details. Load this when working on Kiro provider features: post-creation agent switching, flat session layout, PascalCase normalization, per-agent hooks, etc.

## 3. Documentation Rules & Regulations

**These are non-negotiable rules for keeping the codebase maintainable.**

### Rule 1: Documentation Keeps Code Valid
A task is **only complete when**:
- Code is written and tested
- **All affected documentation is updated** (README files, Feature Docs, etc.)
- The documentation **matches the current state** of the code

**The Documentation Review Process:**
When code changes are made, you **must** review all documentation in the `/documents/` folder to ensure they are still accurate. This is done by:
1. Identifying which files changed (in `frontend/`, `backend/`, or `providers/`).
2. Searching for those filenames within the `/documents/` directory.
3. Updating any documents that reference the changed files to ensure code blocks, line numbers, and descriptions are still accurate.

**If you change a system's behavior, you MUST update its documentation. Outdated documentation is treated as a bug.**

### Rule 2: Every System Gets a Feature Doc

When you **create or significantly modify** a system (new feature, major architecture change, new tool, new service):

1. **Create a Feature Doc** if one doesn't exist. Use the template: `documents/[Feature Doc] - <feature name>.md`
2. **Link to the template:** `documents/FEATURE_DOC_TEMPLATE.md` — This document shows the required structure (end-to-end flow, architecture diagram, critical contract, gotchas, etc.)
3. **Include in this index** — Add a description and link in Section 2 of this BOOTSTRAP file so future agents know to load it.
4. **The Feature Doc is the source of truth** — If there's a conflict between Feature Doc and code, assume the Feature Doc is outdated and update it during your work.

### Rule 3: Outdated Documentation Must Be Updated

If you discover that a Feature Doc is **out of sync with the code**:

1. **Update the Feature Doc as part of your current task** — Don't defer it
2. **Update line numbers and code snippets** to match the current implementation
3. **Add or remove sections** if architecture has changed
4. **Update the gotchas** if workarounds are no longer needed or new ones have appeared
5. **Leave a note** in the gotchas section if the discrepancy was due to recent changes

### Rule 4: Generic Docs vs Provider Docs

- **Generic Feature Docs** (in `documents/`) explain patterns and contracts that apply across all providers. They contain **no provider-specific examples** (no "Claude does X, Kiro does Y").
- **Provider-Specific Feature Docs** (same location, named `[Feature Doc] - <Provider> Provider.md`) fill in provider-specific details, gotchas, line numbers, and implementation quirks.
- Load both docs together when working on a provider feature.

### Rule 5: Documentation Style

All Feature Docs must follow `documents/FEATURE_DOC_TEMPLATE.md`:
- **Exact line numbers** in every code snippet
- **Architecture diagrams** for complex systems
- **The Critical Contract** — Explicitly state what contracts/interfaces must be followed
- **Gotchas section** — List 5-10 things that commonly break or confuse
- **Component reference table** with file paths and exact line numbers
- **No provider-specific examples in generic docs** — Use pattern language: "A provider must...", not "Claude does..."

### Rule 6: Document Present State Only

**Feature Docs are living documents that describe the system AS IT EXISTS TODAY. They are NOT historical documents.**

When updating Feature Docs:
- **Never mention how the system "used to work"** — Remove references to older implementations, previous architecture, or deprecated patterns
- **Never use past tense to describe implementation** — Say "The system does X" not "The system used to do X"
- **Always describe the current implementation** — If the system changed, describe the new behavior only
- **Update line numbers and code snippets** when code shifts — This keeps the documentation accurate and current
- **If a section describes an old pattern**, delete it or replace it with the current pattern. Don't keep both.
- **Example of what to AVOID**: "Previously, sessions were stored flat. Now they are stored in project-scoped subdirectories..."

**Why this matters**: Agents (and humans) rely on Feature Docs as the source of truth for how the system works TODAY. Outdated information embedded in historical context is more confusing than no information at all. A Feature Doc that mentions "X used to happen" creates ambiguity about what actually happens NOW.

---

## 4. Engineering Standards & Patterns

### Data Flow & Normalization
- **Never hardcode provider identity.** If a feature requires a string or icon, it must be sourced from the backend's dynamic branding/config.
- **Strict Abstraction (Zero Leakage)**: All code, including unit tests, must use generalized terminology. Never use specific provider names (e.g., 'Claude', 'Gemini', etc) or specific model IDs in logic or test assertions. Use generic placeholders like `test-provider`, `mock-model-id`, etc., to ensure the entire stack remains decoupled and clean from top to bottom.
- **Tool Outputs**: Always implement "Sticky Metadata" (ensuring tool outputs are linked to the correct file/context) and real-time streaming in the `extractToolOutput` lifecycle.

### State Management
- **Frontend**: Use the specialized Zustand stores in `frontend/src/store/`. Do not introduce global component state for data that should be in a store.
- **Backend**: All session, folder, and workspace metadata must be persisted via `backend/database.js`.

### Error Handling
- Errors must flow through the Socket.IO layer to the UI to ensure they appear in the Unified Timeline or appropriate error overlays (e.g., `SSLErrorOverlay`).

## 5. Testing & Quality Assurance Standards

**No code is considered complete until it is verified by unit tests with high coverage and all relevant documentation is updated.**

### Git & Commit Protocol
- **Strict No-Commit Policy**: Do **NOT** attempt to perform `git commit` or any version control actions unless explicitly commanded to do so (e.g., "Commit these changes"). 
- **Preparation is allowed**: You are encouraged to prepare code, stage files (`git add`), and organize work in anticipation of a commit, but you must never execute the actual commit command without an explicit instruction.
- **Linting Standard**: Before declaring any task complete or proposing a change, you **must** run linting for both backend and frontend. The standard is **zero errors and zero warnings**.
  - **Backend Lint**: `cd backend && npm run lint`
  - **Frontend Lint**: `cd frontend && npm run lint`
- **Frontend Build Validation**: After all unit tests pass and linting is clean, you **must** run `npm run build` in the `frontend` directory to ensure that TypeScript/Vite bundling succeeds and no runtime type issues were introduced.
- **Documentation Requirement**: A task is only "done" when the documentation matches the code. If your changes alter architecture, services, stores, or protocols, you **must** update the relevant README (`README.md` at root, `backend/README.md`, or `frontend/README.md`) to reflect the current reality of the codebase.
- **Final Pre-Commit Documentation Check**: Immediately before executing a commit (when explicitly asked to do so), you **must** perform a final, comprehensive review of ALL documentation in the `/documents/` folder one last time. This "last check" ensures that no documentation was missed during the development phase and that all line numbers and code snippets accurately reflect the final state of the staged changes.

### Backend Testing

- **Framework**: Vitest.
- **Command**: `cd backend && npx vitest run`
- **Coverage Requirement**: Adhere to the thresholds defined in `backend/vitest.config.js`.

### Frontend Testing
- **Framework**: Vitest.
- **Command**: `cd frontend && npx vitest run`
- **Coverage Requirement**: Adhere to the thresholds defined in `frontend/vite.config.ts`.

### Verification Workflow for Agents:
1.  Propose code change.
2.  **Identify** which existing test files need updates.
3.  **Generate/Update** tests as part of the PR.
4.  **Run** the coverage command to prove compliance before declaring task "done."

## 6. Debugging Context
- **Logs**: Check `LOG_FILE_PATH` in `.env`.
- **Database**: SQLite database is located at `./persistence.db`.
- **Provider Isolation**: If a bug is provider-specific, check the provider's `index.js` implementation of the contract defined in `documents/[Feature Doc] - Provider System.md`.

## 7. Agent Behavior Rules & Development Workflow

### 7.1 Before Starting Work

1. **Read this BOOTSTRAP.md** — You are reading it now.
2. **Load the Feature Doc** — Based on the task, load the relevant Feature Doc from Section 2 using the index.
   - If working on a provider: Load `[Feature Doc] - Provider System.md` AND the provider-specific doc (e.g., `[Feature Doc] - Claude Provider.md`)
   - If working on a generic feature: Load the generic Feature Doc (e.g., `[Feature Doc] - ux_invoke_shell.md`)
3. **Check for outdated docs** — If the Feature Doc seems inconsistent with code, ask yourself: "Is the doc outdated?" If yes, update it as part of your work (Rule 3 in Section 3).

### 7.2 During Implementation

1. **Reference exact line numbers** — Use the Feature Doc as your guide. It contains line numbers that point directly to code you need to understand or modify.
2. **Follow the gotchas** — The Feature Doc lists common mistakes. Check the gotchas before implementing something you think is straightforward.
3. **Update code AND documentation together** — Never defer documentation updates to "later." Update as you code.
4. **Create tests alongside code** — Tests are part of development, not an afterthought. Use TDD or write tests immediately after implementation.

### 7.3 When Finished

1. **Run linting** — `cd backend && npm run lint` and `cd frontend && npm run lint`. Zero errors, zero warnings.
2. **Run tests** — Backend: `cd backend && npx vitest run`. Frontend: `cd frontend && npx vitest run`.
   - **If tests fail or coverage is below threshold**, immediately report this to the user. Do NOT attempt to commit or bypass checks.
3. **Run frontend build** — `cd frontend && npm run build`. Must succeed with no errors.
4. **Update documentation** — Every code change must have a corresponding documentation update (Section 3, Rule 1).
5. **Update BOOTSTRAP.md if needed** — If you created a new system, add it to Section 2 with a description and link.
6. **Commit Policy** — Only commit when explicitly instructed to do so. Preparation (staging files) is allowed; actual commits are not.
   - **Never use `--no-verify`** — This flag bypasses pre-commit hooks. It must never be used unless the user explicitly instructs you to do so.
   - **Do not force commits** — If unit tests are failing or coverage is below the configured threshold, do NOT attempt to commit. Instead, report the failures to the user immediately.

### 7.4 Handling Tasks with Conflicting Instructions

If a user instruction conflicts with the rules in this BOOTSTRAP:
- **User instructions take precedence** — But note the conflict and warn the user.
- **Example**: If asked to "skip tests," you may comply, but you must note: "Tests were skipped per instruction, but BOOTSTRAP rule 5 requires coverage compliance. Tests should be run before merging."

### 7.5 Using Feature Docs Effectively

- **Feature Docs are source-of-truth** — If a Feature Doc says "Line 45 in file X contains the handler," trust it. If it's wrong, update it.
- **Feature Docs expire** — Code changes but docs may not. If you suspect a Feature Doc is outdated, verify against the code and update it.
- **Cross-reference Feature Docs** — Generic docs reference provider docs and vice versa. Load both when working on provider code.
- **Gotchas are lessons learned** — The gotchas in a Feature Doc represent real bugs or confusion from previous work. Read them carefully.

---

## 8. Summary of Key Rules

| Rule | What to Do | When to Do It |
|------|-----------|--------------|
| **Load Feature Docs** | Use Section 2 to find the right Feature Doc(s) | Before starting any task |
| **Update Docs** | Update Feature Docs, READMEs, and BOOTSTRAP when code changes | As part of implementation, not later |
| **Create Feature Docs** | Create a Feature Doc for every new system using the template | When creating a new feature or major architecture change |
| **Test Everything** | Write tests, run linting, build frontend | Before declaring task complete |
| **Follow Gotchas** | Read the Feature Doc's gotchas section before implementing | When implementing a feature for the first time |
| **No Git Commits** | Prepare code and stage files, but do NOT commit without instruction. Never use `--no-verify`. Report test failures before committing. | Anytime you finish work |
| **Provider Isolation** | Load provider-specific docs when working on providers | When working on provider code |
| **Documentation Matches Code** | If code and docs conflict, update the docs | Every task |

---

## References

- **[FEATURE_DOC_TEMPLATE.md](documents/FEATURE_DOC_TEMPLATE.md)** — Template for all Feature Docs. Link this when creating new docs.
- **[Feature Doc Index](documents/)** — Directory of all Feature Docs. Browse here to find docs.
