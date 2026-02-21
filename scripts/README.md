# Scripts

Automation scripts for the Meridian project.

---

## `remote-workspace.sh`

**Purpose:** Launches the standalone `remote-workspace/` web app for remote file browsing/upload and Markdown+Mermaid preview.

### Quick Start

```bash
# From repo root
./scripts/remote-workspace.sh

# Recommended (private tailnet URL)
./scripts/remote-workspace.sh --tailscale-serve
```

Default URL: `http://127.0.0.1:18080`

### Common Options

```bash
./scripts/remote-workspace.sh --port 18111
./scripts/remote-workspace.sh --install
./scripts/remote-workspace.sh --tailscale-serve
./scripts/remote-workspace.sh --tailscale-funnel
```

### What It Starts

The script runs a TypeScript Node service in `remote-workspace/` with:

1. Directory/file explorer (repo-root sandboxed)
2. File upload into the current folder
3. Folder creation endpoint
4. Markdown preview with Mermaid rendering

See `remote-workspace/README.md` for details and Tailscale examples.

---

## `check-md-links.sh`

**Purpose:** Validate local markdown links and wiki-links to `.md` files.

### Quick Start

```bash
# From repo root, check all docs (default target)
./scripts/check-md-links.sh

# Check a specific docs subtree
./scripts/check-md-links.sh _docs/hidden/guide

# Disable wiki-link checks (markdown links only)
./scripts/check-md-links.sh _docs --no-wikilinks

# Skip fragment anchor checks
./scripts/check-md-links.sh _docs --no-anchors
```

### What It Checks

1. Scans all `.md` files under the target directory
2. Extracts markdown links like `[text](target.md)` and wiki-links like `[[target]]` / `@[[target|Label]]`
3. Ignores fenced code blocks and external links (`http(s)`, `mailto`, etc.)
4. Handles fragment links (`#section`, `file.md#section`) and checks target heading anchors by default
5. Fails if a referenced local `.md` file does not exist

---

## `update-libraries.sh`

**Purpose:** Updates meridian-llm-go and meridian-stream-go libraries, tags them, and syncs with backend.

### Quick Start

```bash
# From repo root
./scripts/update-libraries.sh "Add JSONDelta support"
```

### What It Does

1. **Detects uncommitted changes** in each library
2. **Auto-increments patch version** (v0.0.1 -> v0.0.2)
3. **Commits and tags** the libraries
4. **Pushes to GitHub** (main + tags)
5. **Updates backend/go.mod** with new versions
6. **Tests builds** (optional: Go build + Docker build)

### Usage

**Basic usage:**
```bash
./scripts/update-libraries.sh
```
Prompts for commit message, uses default "Update libraries"

**With commit message:**
```bash
./scripts/update-libraries.sh "Fix streaming race condition"
```

**Custom version:**
```bash
./scripts/update-libraries.sh "Breaking: Rename all functions"
# When prompted, choose "custom" and enter: v0.1.0
```

### Interactive Prompts

The script will ask:

1. **Commit changes?** (if uncommitted changes exist)
2. **Use auto-incremented version?** (y/n/custom)
   - `y` - Use v0.0.X+1
   - `n` - Skip this library
   - `custom` - Enter your own version (e.g., v0.1.0 for minor bump)
3. **Run build tests?** (optional)
4. **Run Docker tests?** (optional)

### Example Session

```
=== Library Update Script ===
Commit message: Add JSONDelta support

=== Updating meridian-llm-go ===
Found uncommitted changes
M internal/conversion.go
Commit these changes? (y/n): y

Current version: v0.0.1
Next version:    v0.0.2
Use this version? (y/n/custom): y

Creating tag v0.0.2
Pushing to GitHub...
✓ meridian-llm-go updated to v0.0.2

=== Updating meridian-stream-go ===
No uncommitted changes
Tag current commit anyway? (y/n): n
Skipping meridian-stream-go

=== Updating Backend Dependencies ===
Updating: github.com/haowjy/meridian-llm-go@v0.0.2
Running go mod tidy...
✓ Backend dependencies updated

=== Testing Backend Build ===
Run 'go build' test? (y/n): y
Building...
✓ Build successful

=== Update Complete ===
Libraries updated:
  - github.com/haowjy/meridian-llm-go@v0.0.2

Next steps:
1. Review changes: git diff backend/go.mod backend/go.sum
2. Commit backend changes:
   cd backend
   git add go.mod go.sum
   git commit -m 'Update library dependencies'
3. Push to trigger Railway deployment:
   git push origin main
```

### Versioning Strategy

**Auto-increment (recommended for most changes):**
- Bug fixes: Auto-increment patch (v0.0.1 -> v0.0.2)
- Small features: Auto-increment patch

**Manual versioning (for significant changes):**
- Minor version bump: Choose "custom" -> `v0.1.0`
  - New features, backward compatible
- Major version bump: Choose "custom" -> `v1.0.0`
  - Breaking changes, API redesign

### Rollback

If you need to rollback a library update:

```bash
cd backend

# Rollback to previous version
go get github.com/haowjy/meridian-llm-go@v0.0.1
go mod tidy

# Test
go build ./cmd/server

# Commit
git add go.mod go.sum
git commit -m "Rollback meridian-llm-go to v0.0.1"
```

### Current Versions

Check current library versions:

```bash
cd backend
cat go.mod | grep meridian
```

**As of last update:**
- `meridian-llm-go`: v0.0.1
- `meridian-stream-go`: v0.0.4

### Troubleshooting

**Error: "Tag already exists"**
```bash
# List existing tags
cd meridian-llm-go
git tag -l

# Delete local tag
git tag -d v0.0.2

# Delete remote tag (if already pushed)
git push origin :refs/tags/v0.0.2
```

**Error: "go get failed"**
```bash
# Verify library is pushed to GitHub
cd meridian-llm-go
git push origin main
git push origin v0.0.2

# Wait 1-2 minutes for GitHub to index the tag
# Then retry: go get github.com/haowjy/meridian-llm-go@v0.0.2
```

**Error: "Docker build failed"**
```bash
# Clear Docker cache
docker build --no-cache -t meridian-backend .

# If still fails, check go.mod/go.sum are committed
cd backend
git status
```

### Tips

1. **Tag frequently** - Tag whenever backend needs the changes
2. **Test Docker** - Always run Docker test before deploying
3. **Commit message matters** - Use descriptive messages for library commits
4. **Batch related changes** - Make multiple commits in library, tag once
5. **Skip unchanged libraries** - Say "n" when prompted to skip libraries

### Integration with Deployment

After running this script:

1. **Backend changes** are in `backend/go.mod` and `backend/go.sum`
2. **Commit these files** to main repo
3. **Push to `main`** triggers Railway deployment
4. Railway will pull the **new tagged versions** from GitHub

```bash
# After script completes
cd backend
git add go.mod go.sum
git commit -m "Update meridian-llm-go to v0.0.2"
git push origin main  # Triggers Railway deployment
```

---

---

## `migrate-prefix.sh`

**Purpose:** Run schema migration for specific table prefix (test_ or prod_).

**Why Needed:** Goose only tracks one prefix at a time. This script manually applies migrations for additional prefixes in the same database.

### Quick Start

```bash
# Interactive mode (menu + prompts)
./scripts/migrate-prefix.sh

# Direct mode (for automation)
./scripts/migrate-prefix.sh test_
./scripts/migrate-prefix.sh prod_
```

### What It Does

1. **Prompts for prefix** (interactive menu or CLI argument)
2. **Prompts for Supabase DB URL** (safer than reusing .env)
3. **Validates** prefix format and URL format
4. **Checks for existing tables** with that prefix
5. **Optionally drops** existing tables (for fresh migration)
6. **Substitutes** `${TABLE_PREFIX}` in migration SQL with actual prefix
7. **Runs migration** against the provided database
8. **Shows created tables**

### Usage

**Interactive mode (recommended):**
```bash
./scripts/migrate-prefix.sh
# Shows menu -> select 1/2/3 -> enter DB URL -> runs migration
```

**Direct mode (for automation):**
```bash
./scripts/migrate-prefix.sh test_
# Prompts for DB URL -> runs migration

./scripts/migrate-prefix.sh prod_
# Prompts for DB URL -> runs migration
```

### Example Session (Interactive Mode)

```
$ ./scripts/migrate-prefix.sh

=== Meridian Schema Migration ===

Select table prefix to migrate:
  1) test_
  2) prod_
  3) custom (enter manually)

Enter choice (1-3): 1

=== Migrating Schema for Prefix: test_ ===

Enter Supabase DB URL:
Format: postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[HOST]:6543/postgres
> postgresql://postgres.abcdefg:my-password@aws-0-us-west-1.pooler.supabase.com:6543/postgres

✓ Using connection: postgresql://postgres.abcdefg:****@aws-0-us-west-1.pooler.supabase.com:6543/postgres

Checking if tables already exist...
No existing tables found

Running migration...
CREATE EXTENSION
CREATE FUNCTION
CREATE TABLE
CREATE TABLE
...

=== Migration Complete ===
Created tables with prefix: test_

Tables created:
  test_projects
  test_folders
  test_documents
  test_threads
  test_turns
  test_turn_blocks
  test_user_preferences

Note: This migration is NOT tracked by goose
Goose only tracks 'test_' prefix (typically 'dev_')
Manage test/prod prefixes manually or use separate databases
```

### When to Use

**Use this script when:**
- Setting up `test_` tables for Docker testing
- Creating `prod_` tables for production deployment
- Adding a new environment prefix

**Don't use for `dev_`:**
- Dev prefix uses `make seed-fresh` (tracked by goose)

### With RLS Enabled

This script includes the RLS section from the migration, so:
- ✅ RLS enabled on all created tables
- ✅ PostgREST API blocked
- ✅ Backend can still access (postgres superuser)

### Troubleshooting

**Error: "table already exists"**
```bash
# The script will prompt to drop existing tables
# Answer 'y' to drop and recreate
```

**Error: "Invalid PostgreSQL URL format"**
```bash
# Ensure URL starts with postgresql://
# Correct format: postgresql://postgres.[PROJECT-REF]:[PASSWORD]@[HOST]:6543/postgres
# Find in Supabase Dashboard -> Settings -> Database -> Connection Pooling (Session mode, port 6543)
```

**Error: "migration file not found"**
```bash
# Run from repo root or backend directory
cd /path/to/meridian
./scripts/migrate-prefix.sh
```

**Error: "connection refused"**
```bash
# Check that the Supabase DB URL is correct and accessible
# Verify network connectivity to Supabase
# Try connecting with psql manually: psql "<YOUR_URL>"
```

### Important Notes

1. **Not tracked by goose** - These migrations are manual, not in `goose_db_version`
2. **Same database** - Creates tables in same database with different prefix
3. **Idempotent** - Safe to run multiple times (will prompt to drop existing)
4. **One-time setup** - Usually only run once per environment

### Alternative: Separate Databases

For production, consider using separate Supabase projects:
- Dev database: `dev.supabase.co` (use goose normally)
- Prod database: `prod.supabase.co` (use goose normally)

This avoids prefix complexity and provides better isolation.

---

## `llm-post-commit.sh`

**Purpose:** Post-commit hook for `meridian-llm-go` submodule. Automatically bumps the patch version, tags, pushes, and updates `backend/go.mod` after every commit in the submodule.

### What It Does

1. Fetches latest tags from origin
2. Checks if HEAD is already tagged (skips if so — no double-bump)
3. Increments patch version (v0.0.24 -> v0.0.25)
4. Tags current commit
5. Pushes commit + tag to origin
6. Updates `backend/go.mod` with new version (`go get` + `go mod tidy`)

### Installation (One-Time Setup)

The hook is installed via symlink into the submodule's git hooks directory:

```bash
# From repo root
ln -sf ../../../../scripts/llm-post-commit.sh .git/modules/meridian-llm-go/hooks/post-commit
```

This is local to your machine (`.git/` is not committed).

### Uninstalling

```bash
rm .git/modules/meridian-llm-go/hooks/post-commit
```

### Skipping the Hook

```bash
# One-time skip
cd meridian-llm-go
git commit --no-verify -m "message"
```

### Error Handling

- **Network failure**: Prints warning, creates tag locally. Push manually later.
- **HEAD already tagged**: Skips gracefully (idempotent).
- **`go get` fails** (tag not yet indexed by GitHub): Retries once after 5s. If still fails, prints manual command.

### Notes

- Only bumps **patch** version. For minor/major bumps, use `update-libraries.sh` with custom version.
- The hook runs in the submodule context — it resolves the parent repo and backend paths automatically.
- After the hook runs, you still need to commit `backend/go.mod` + `go.sum` in the parent repo.

---

## Orchestration

Orchestration is provided by the [orchestrate plugin](https://github.com/jimmyyao/orchestrate).

Install: `/plugin marketplace add jimmyyao/orchestrate` (Claude Code)

### `cc-orchestrate`

**Purpose:** Launch Claude Code with orchestrator-friendly defaults:
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=60`
- `--dangerously-skip-permissions`
- optional startup prompt for `/orchestrate`

```bash
# Start Claude with defaults
./scripts/cc-orchestrate

# Start and immediately run /orchestrate on a plan
./scripts/cc-orchestrate --plan _docs/plans/my-plan.md

# Pass through any other Claude flags
./scripts/cc-orchestrate --model claude-opus-4-6 --debug api,hooks
```

---

## `dev/setup.sh` — Dev Environment

**Purpose:** Create a tmux dev session with backend + frontend panes.

```bash
scripts/dev/setup.sh
```

Session name and ports are **branch/worktree-aware** (via `dev/lib.sh`):
- Session name = directory basename (e.g. `meridian-collab`)
- Backend port = `8080 + hash(session) % 100` (deterministic per worktree)
- Frontend port = always `3000`

| Worktree | Session | Backend Port |
|----------|---------|-------------|
| meridian | `meridian` | 8140 |
| meridian-agents | `meridian-agents` | 8170 |
| meridian-collab | `meridian-collab` | 8130 |

For manual overrides, create `.dev-ports` (gitignored):
```bash
BACKEND_PORT=8081
FRONTEND_PORT=3001
```

## `dev/restart-backend.sh` — Reliable Backend Restart

**Purpose:** Kill and restart the backend using `tmux respawn-pane -k`. More reliable than sending ctrl+c.

```bash
scripts/dev/restart-backend.sh
```

`scripts/restart-server.sh` delegates to this script.

---

## Future Scripts

- `deploy.sh` - Deploy to Railway + Vercel
- `test-docker.sh` - Quick Docker build test (exists in backend/)
- `seed-prod.sh` - Production data seeding (with safety checks)
