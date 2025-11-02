# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Meridian is a document management system for creative writers, starting with fiction writers who manage 100+ chapter web serials.

**Current Status:**
- ✅ Backend (Go + Fiber + PostgreSQL): Fully implemented
- 🚧 Frontend (Next.js + TipTap): Not yet started

For product details, see `_docs/high-level/1-overview.md`.

## Where to Find Things

### Code-Specific Instructions

- **Backend**: `backend/CLAUDE.md` - Development commands, architecture, conventions
- **Frontend** (future): `frontend/CLAUDE.md` - When frontend development starts

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
- never `make run` for me... let the user make run