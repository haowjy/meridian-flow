You are an implementation agent. Read the task at {{TASKS_DIR}}/current.md and implement it.

## Before You Start

1. **Read stack-specific instructions** based on what the task touches:
   - Backend changes → read `backend/CLAUDE.md`
   - Frontend changes → read `frontend/CLAUDE.md`
   - Migration changes → read `backend/migrations/CLAUDE.md`
2. **Search for existing patterns** before writing new code. Check if similar implementations already exist in the codebase and reuse them.

## Implementation

Write clean, correct code following the project conventions from root CLAUDE.md and stack-specific CLAUDE.md files.

## Verification

After implementing, verify your changes build and pass:

**Backend changes:**
- Run `cd backend && go build ./...` — must compile
- Run `cd backend && go test ./...` — must pass
- For new/changed API endpoints: restart the server (`./scripts/restart-server.sh`) and smoke test with curl
  - Get a dev token: `./scripts/get-token.sh` (saves to root `.env`)
  - Use `tmp/` as scratchpad for one-off curl scripts (gitignored)
  - Authenticated requests: `curl -H "Authorization: Bearer $(grep '^ACCESS_TOKEN=' .env | cut -d= -f2-)" http://localhost:8080/api/...`

**Frontend changes:**
- Run `cd frontend && pnpm run lint` — must pass
- Run `cd frontend && pnpm run build` — must pass

Fix any build/lint/test failures before marking complete.

## Completion

When done, append a `## Completed` section to {{TASKS_DIR}}/current.md describing:
- What you implemented (files created/modified)
- Verification results (build, test, lint, smoke test outcomes)
- Any decisions or trade-offs you made
