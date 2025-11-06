# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Meridian is a document management system for creative writers, starting with fiction writers who manage 100+ chapter web serials.

**Current Status:**
- ✅ Backend (Go + Fiber + PostgreSQL): Fully implemented
- 🚧 Frontend (Next.js + TipTap): In active development

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

8. **Server is Authority**
   - Always use API responses
   - Don't trust local timestamps
   - Sync server state to local, not vice versa

9. **Comment the "Weird"**
   - If it needs a guard, comment why
   - If it prevents a race, explain the race
   - If you had to debug it, future you will too

10. **Prefer Local-First, But Don't Over-Engineer**
    - IndexedDB for instant loads ✅
    - Optimistic updates ✅
    - Persistent operation queues ❌ (usually overkill)

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend**: `frontend/CLAUDE.md` - Caching patterns, store architecture, TipTap conventions

### Documentation

- **Product/high-level**: `_docs/high-level/` - Product vision, MVP specs, user stories
- **Technical details**: `_docs/technical/backend/` - Architecture decisions, setup guides
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

1. **Keep it lean** - As short as possible while still useful
2. **Reference, don't duplicate** - Point to code, don't copy it
   - ✅ "See `internal/service/document.go:29-33`"
   - ❌ Pasting 50 lines of existing code
3. **Use frontmatter** for detail level:
   ```yaml
   ---
   detail: minimal | standard | comprehensive
   audience: developer | architect | claude
   ---
   ```
4. **Code examples sparingly** - Only when:
   - Showing a pattern that doesn't exist yet
   - Demonstrating a specific fix/workaround
   - Concept can't be found in existing code
5. **Focus on WHY, not WHAT** - Code shows WHAT; explain WHY
6. **Mermaid diagrams** - Use dark mode compatible colors:
   - Use darker, saturated colors (e.g., `#2d7d2d` not `#90EE90`)
   - Avoid light pastels that disappear on dark backgrounds
   - Test: colors should be visible on both light AND dark backgrounds

### Mermaid Quick Rules

- **Quote labels with spaces, parentheses, punctuation, or HTML**
  - Nodes: `Node["Label"]`, Edges: `A -->|"edge"| B`, Subgraphs: `subgraph "Title (X)"` … `end`
- **Put `<br/>` only inside quoted labels**
- **Use ASCII operators** in labels (`>=`, `<=`) instead of unicode
- **Don't change diagram types or structure** - Fix parse errors by adding quotes, not refactors
- **Leave `class` directives as-authored** - Move prose into labels only if asked
- **If asked to revert, restore the exact previous lines**
- **Before saving: quick scan for unbalanced quotes**

### Examples

**Good (minimal):**
```markdown
# Database Connections

## Problem
PgBouncer conflicts with prepared statements.

## Solution
Add `?pgbouncer=true` for dev (port 6543).

## Implementation
See `internal/repository/postgres/connection.go`
```

**Bad (verbose):**
```markdown
# Database Connections

PostgreSQL is a powerful database...
[3 paragraphs of history]

Here's the connection code:
[50 lines copied from connection.go]

Here's how to query:
[30 more lines]
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

## Deployment

- **Backend**: Railway
- **Database**: Supabase (PostgreSQL)
- **Frontend** (future): Vercel

See `backend/CLAUDE.md` for backend deployment details.