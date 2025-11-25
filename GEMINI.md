# GEMINI.md

This file provides guidance when working with the code in this repository.

## Project Overview

Meridian is a file management system for creative writers, starting with fiction writers who manage 100+ chapter web serials.

**Current Status:**
- ✅ Backend (Go + net/http + PostgreSQL): File system complete, Auth complete (JWT/JWKS), Chat/LLM in progress (Anthropic provider working, streaming complete)
- ✅ Frontend (Next.js + TipTap): Document editor complete, Chat UI complete

For product details, see `_docs/high-level/1-overview.md`.

## Guiding Principles for Development

ALWAYS FOLLOW SOLID PRINCIPLES.

Then, these principles can also help you make architectural decisions and other development tasks:

1. **Start Simple, Stay Simple**
   - Write the simplest thing that could work
   - Add complexity only when necessary
   - Regularly refactor to remove unnecessary complexity

2. **Make Correctness Obvious**
   - Code should make bugs impossible or obvious
   - Use types to prevent invalid states
   - Fail fast and loudly (don't swallow errors)

3. **One Thing At A Time**
   - Don't optimize and add features simultaneously
   - Test each change before moving on
   - Small, incremental changes are easier to debug

4. **Explicit Over Implicit**
   - `hasUserEdit` flag > trying to detect user edits
   - `content !== undefined` > `content` (falsy check)
   - Direct sync > background queue

5. **Design for Debuggability**
   - Clear console logs at key decision points
   - Helper functions to inspect state (`getRetryQueueState()`)
   - Predictable, deterministic behavior

6. **Guard Against Races**
   - Add locks/flags to prevent concurrent execution
   - Use intent flags to coordinate subsystems
   - Cancel stale operations proactively

7. **Treat Empty as Valid**
   - Empty string `""` is valid data
   - Empty array `[]` is valid data
   - Only `undefined`/`null` means "absent"

8. **Comment the "Weird" and the "WHY"**
   - anything that is not obvious, comment why.
   - If it needs a guard, comment why
   - If it prevents a race, explain the race
   - If you had to debug it, future you will too
   - etc.

9. **Prefer Local-First, But Don't Over-Engineer**
    - IndexedDB for instant loads ✅
    - Optimistic updates ✅
    - Persistent operation queues ❌ (usually overkill)

10. **Extensible** - Design for extensibility.

11. **Keep Documentation Up-to-Date** - Update documentation AFTER finalizing changes. See "Feature Documentation Sync Rule" for feature documentation workflow.

12. **Keep the code clean** - keep the code clean and readable, as the code grows, it will become more difficult to understand, its easier to refactor now than later (make sure to delete dead code as well).

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend**: `frontend/CLAUDE.md` - Caching patterns, store architecture, TipTap conventions

### Documentation

- **Features**: `_docs/features/` - Feature status, implementation guides by stack (f-/b-/fb- prefixes)
  - **Overview**: `_docs/features/README.md` - Complete feature inventory with status
  - **Authentication**: `_docs/features/fb-authentication/` - JWT validation, Supabase integration
  - **Document Editor**: `_docs/features/f-document-editor/` - TipTap, auto-save, caching
  - **Chat/LLM**: `_docs/features/fb-chat-llm/` - Turn branching, providers, streaming
  - **File System**: `_docs/features/fb-file-system/` - CRUD operations, tree structure
- **Product/high-level**: `_docs/high-level/` - Product vision, MVP specs, user stories
- **Technical details**: `_docs/technical/` - Deep-dive architecture, implementation specifics
  - **Backend**: `_docs/technical/backend/` - Go backend architecture, API design
  - **Frontend**: `_docs/technical/frontend/` - Next.js frontend architecture, patterns
  - **Authentication**: `_docs/technical/auth-overview.md` - Cross-stack auth flow (Supabase)
  - **Streaming/SSE**: `_docs/technical/llm/streaming/` - Real-time LLM responses, block types
- **Documentation structure**: `_docs/README.md` - How docs are organized

**Always check `_docs/features/` first for feature status, then `_docs/technical/` for implementation details.**

## Documentation Philosophy

Documentation is organized in three tiers:

1. **Features** (`_docs/features/`) - **Start here**
   - What features exist and their status (✅/🟡/❌)
   - Stack-prefixed folders show frontend-only (f-), backend-only (b-), or both (fb-)
   - Concise implementation guides with links to technical details

2. **High-Level** (`_docs/high-level/`)
   - Product vision, user stories, MVP specifications
   - Non-technical stakeholder documentation

3. **Technical** (`_docs/technical/`)
   - Deep-dive architecture documents
   - Detailed implementation patterns and edge cases
   - Referenced from feature docs when needed

### Feature Documentation Sync Rule

**IMPORTANT: When adding or significantly updating a feature, you MUST update the corresponding feature documentation.**

This applies to both Claude and human developers:

✅ **Update feature docs when:**
- Implementing a new feature
- Significantly changing existing feature behavior
- Changing feature status (e.g., from 🟡 partial to ✅ complete)
- Adding/removing major functionality
- Changing stack requirements (e.g., backend-only → full-stack)

**Workflow:**
1. Implement the feature/update
2. Update `_docs/features/<feature-name>/` with changes
3. Update status in `_docs/features/README.md` if needed
4. Commit code + docs together

## Repository Structure

```
backend/
├── cmd/                    # Entry points (server, seed)
├── internal/
│   ├── domain/             # Interfaces + models (Clean Architecture)
│   ├── service/            # Business logic
│   ├── repository/         # Data access
│   ├── handler/            # HTTP handlers
│   ├── middleware/         # Auth, error handling
│   └── config/             # Configuration
├── scripts/                # Shell scripts (seeding)
├── tests/                  # Test artifacts
└── schema.sql              # Database schema

_docs/
├── features/               # Feature documentation (stack-prefixed)
│   ├── README.md           # Feature inventory and status
│   ├── fb-authentication/  # Both stacks
│   ├── f-document-editor/  # Frontend only
│   ├── fb-file-system/     # Both stacks
│   ├── fb-chat-llm/        # Both stacks
│   └── ...                 # Other features
├── high-level/             # Product docs
└── technical/              # Deep-dive technical docs
    ├── backend/            # Backend architecture
    ├── frontend/           # Frontend architecture
    └── llm/                # LLM integration details
```

## Documentation Writing Rules

**Default: MINIMUM content unless otherwise stated.**

### Core Principles

1. **Diagrams > Words** - A picture is easier to understand than paragraphs
   - Prefer Mermaid diagrams to explain flows, architecture, relationships
   - Use tables for comparisons or lists of issues
   - Keep text minimal - just enough to connect the diagrams

2. **Minimize words** - Every sentence should earn its place
   - Can a diagram replace 3 paragraphs? Use the diagram
   - Can a table replace verbose lists? Use the table
   - Cut ruthlessly; too much text hurts comprehension

3. **Reference, don't duplicate** - Point to code, don't copy it
   - ✅ "See `internal/service/document.go:29-33`"
   - ❌ Pasting 50 lines of existing code

4. **Split by purpose, not size** - Each doc should have a single, clear purpose
   - If covering multiple distinct topics → split into separate docs
   - Organize related docs into folders (e.g., `features/fb-authentication/`, `technical/backend/`)
   - Update index/README to maintain discoverability
   - Guideline: If someone asks "where's the X doc?" and you can't point to one file, structure is wrong

5. **Use frontmatter** for detail level:
   ```yaml
   ---
   detail: minimal | standard | comprehensive
   audience: developer | architect | claude
   ---
   ```

6. **Code examples sparingly** - Only when:
   - Showing a pattern that doesn't exist yet
   - Demonstrating a specific fix/workaround
   - Concept can't be found in existing code

7. **Focus on WHY and WHAT, not HOW** - let the implementation show the how. How can always change. Some How details are important to note (like specific implementation details to ensure effiency, compliance, etc.), but not always.

8. **Mermaid diagrams** - Use dark mode compatible colors:
   - Use darker, saturated colors (e.g., `#2d7d2d` not `#90EE90`)
   - Avoid light pastels that disappear on dark backgrounds
   - Test: colors should be visible on both light AND dark backgrounds

### Mermaid Quick Rules

- Quote labels with spaces/punctuation: `Node["Label"]`, `A -->|"edge"| B`
- Use ASCII operators (`>=`, `<=`) not unicode
- Fix parse errors by adding quotes, not restructuring diagrams

### Example

```markdown
# Database Connections

## Problem
PgBouncer conflicts with prepared statements.

## Solution
Add `?pgbouncer=true` for dev (port 6543).

## Implementation
See `internal/repository/postgres/connection.go`
```

## General Conventions

### Server Management

- User manages dev server (starts/stops/restarts)
- Claude suggests commands but doesn't run them
- Claude CAN run curl commands to test APIs

### Git Commits

- Only commit when user explicitly requests
- Follow repository's commit message style
- See general Git conventions in main CLAUDE.md guidelines

### Testing

- User runs tests manually or via CI/CD
- Claude can suggest test commands
- Claude can help write/fix tests

### Frontend

- use `pnpm` instead of `npm` for faster compile times
- run `pnpm run lint` to run ESLint after making changes
- run `pnpm run build` after finishing changes to ensure the build is working

## Deployment

- **Backend**: Railway
- **Database**: Supabase (PostgreSQL)
- **Frontend** (future): Vercel

See `backend/CLAUDE.md` for backend deployment details.
