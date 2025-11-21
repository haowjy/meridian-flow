# CLAUDE.md

This file provides guidance when working with the code in this repository.

## Project Overview

Meridian is a file management system for creative writers, starting with fiction writers who manage 100+ chapter web serials.

**Current Status:**
- ✅ Backend (Go + net/http + PostgreSQL): File system complete, Chat/LLM in progress (Anthropic provider working, streaming complete)
- 🚧 Frontend (Next.js + TipTap): Document editor complete, chat UI pending

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

9. **Prefer Local-First, But Don't Over-Engineer**
    - IndexedDB for instant loads ✅
    - Optimistic updates ✅
    - Persistent operation queues ❌ (usually overkill)

10. **Extensible** - Design for extensibility.

11. **Keep Documentation Up-to-Date** - Update documentation AFTER finalizing changes.

12. **Keep the code clean** - keep the code clean and readable, as the code grows, it will become more difficult to understand, its easier to refactor now than later (make sure to delete dead code as well).

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend**: `frontend/CLAUDE.md` - Caching patterns, store architecture, TipTap conventions

### Documentation

- **Product/high-level**: `_docs/high-level/` - Product vision, MVP specs, user stories
- **Technical details**: `_docs/technical/` - Architecture, implementation guides
  - **Backend**: `_docs/technical/backend/` - Go backend architecture, API design
  - **Frontend**: `_docs/technical/frontend/` - Next.js frontend architecture, patterns
  - **Authentication**: `_docs/technical/auth-overview.md` - Cross-stack auth flow (Supabase)
  - **Streaming/SSE**: `_docs/technical/llm/streaming/` - Real-time LLM responses, block types
- **Documentation structure**: `_docs/README.md` - How docs are organized

**Always check `_docs/technical/` first before creating new documentation.**

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
├── high-level/             # Product docs
└── technical/              # Technical docs
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
   - Organize related docs into folders (e.g., `architecture/`, `features/`)
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

## Deployment

- **Backend**: Railway
- **Database**: Supabase (PostgreSQL)
- **Frontend** (future): Vercel

See `backend/CLAUDE.md` for backend deployment details.
