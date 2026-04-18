# AI Developer Bootstrapping Protocol: AcpUI

This document is a machine-readable context injector. When starting a new session, the Agent should read this file first to understand the architecture, standards, and testing requirements of the repository.

## 0. Immediate Context Loading
After reading this file, the agent **must** load and parse the following files to establish a complete understanding of the system:
- `README.md` (Root) — High-level overview.
- `PROVIDERS.md` — The fundamental protocol and interface contract.
- `backend/README.md` — Backend architecture and service map.
- `frontend/README.md` — Frontend architecture and store map.

## 1. Core Architectural Mental Model
AcpUI is a **provider-agnostic** bridge between a web UI and AI agents communicating via the **Agent Client Protocol (ACP)**.

### The Three-Tier Flow:
1.  **Frontend (React/Vite/Zustand)**: A high-fidelity interface that consumes a "Unified Timeline." It has **zero** knowledge of specific AI models or providers; it only knows how to render normalized data and branding provided by the backend.
2.  **Backend (Node.js/Socket.io/SQLite)**: The orchestrator. It manages the lifecycle of ACP daemons, handles session persistence in SQLite, and routes messages. It uses `AsyncLocalStorage` to maintain strict provider isolation.
3.  **Provider (The Logic Layer)**: A directory-based module (e.g., `providers/my-provider/`) that implements a specific interface contract (`index.js`). It translates raw JSON-RPC daemon output into the AcpUI standard.

### Provider-Specific Development
When working on changes related to a specific provider, you **must** read that provider's individual documentation (usually a `README.md` within its directory) to understand its unique capabilities, constraints, and setup requirements.

### Critical Concept: The Unified Timeline
Everything in the UI—thoughts, tool calls, text, and permissions—is treated as a chronological sequence of "steps" in a timeline. Never bypass this normalization.

## 2. Engineering Standards & Patterns

### Data Flow & Normalization
- **Never hardcode provider identity.** If a feature requires a string or icon, it must be sourced from the backend's dynamic branding/config.
- **Strict Abstraction (Zero Leakage)**: All code, including unit tests, must use generalized terminology. Never use specific provider names (e.g., 'Claude', 'Gemini', etc) or specific model IDs in logic or test assertions. Use generic placeholders like `test-provider`, `mock-model-id`, etc., to ensure the entire stack remains decoupled and clean from top to bottom.
- **Tool Outputs**: Always implement "Sticky Metadata" (ensuring tool outputs are linked to the correct file/context) and real-time streaming in the `extractToolOutput` lifecycle.

### State Management
- **Frontend**: Use the specialized Zustand stores in `frontend/src/store/`. Do not introduce global component state for data that should be in a store.
- **Backend**: All session, folder, and workspace metadata must be persisted via `backend/database.js`.

### Error Handling
- Errors must flow through the Socket.IO layer to the UI to ensure they appear in the Unified Timeline or appropriate error overlays (e.g., `SSLErrorOverlay`).

## 4. Testing & Quality Assurance Standards

**No code is considered complete until it is verified by unit tests with high coverage and all relevant documentation is updated.**

### Git & Commit Protocol
- **Strict No-Commit Policy**: Do **NOT** attempt to perform `git commit` or any version control actions unless explicitly commanded to do so (e.g., "Commit these changes"). 
- **Preparation is allowed**: You are encouraged to prepare code, stage files (`git add`), and organize work in anticipation of a commit, but you must never execute the actual commit command without an explicit instruction.
- **Linting Standard**: Before declaring any task complete or proposing a change, you **must** run linting for both backend and frontend. The standard is **zero errors and zero warnings**.
  - **Backend Lint**: `cd backend && npm run lint`
  - **Frontend Lint**: `cd frontend && npm run lint`
- **Frontend Build Validation**: After all unit tests pass and linting is clean, you **must** run `npm run build` in the `frontend` directory to ensure that TypeScript/Vite bundling succeeds and no runtime type issues were introduced.
- **Documentation Requirement**: A task is only "done" when the documentation matches the code. If your changes alter architecture, services, stores, or protocols, you **must** update the relevant README (`README.md` at root, `backend/README.md`, or `frontend/README.md`) to reflect the current reality of the codebase.

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

## 4. Debugging Context
- **Logs**: Check `LOG_FILE_PATH` in `.env`.
- **Database**: SQLite database is located at `./persistence.db`.
- **Provider Isolation**: If a bug is provider-specific, check the provider's `index.js` implementation of the contract defined in `PROVIDERS.md`.