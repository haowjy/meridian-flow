---
detail: standard
audience: developer
---

# Debugging Guide

Common issues, solutions, and troubleshooting tips for Meridian backend development.

## Database Issues

### Prepared Statement Already Exists

**Error:**
```
prepared statement "stmtcache_xxx" already exists
```

**Cause:** Using PgBouncer (port 6543) with prepared statements enabled.

**Solution:**
1. Ensure using port 6543 in `SUPABASE_DB_URL`
2. Auto-configuration should detect port 6543 and disable prepared statements
3. If error persists, restart Supabase project in dashboard

**Verification:**
```go
// Check internal/repository/postgres/connection.go
// Should auto-detect port 6543 and set QueryExecModeSimpleProtocol
```

See [database/connections.md](../database/connections.md) for details.

### JSONB Encoding Errors

**Error:**
```
cannot encode type X to JSONB
```

**Cause:** Using wrong query execution mode with PgBouncer.

**Solution:** Ensure using simple protocol (port 6543 auto-configures this).

### Table Does Not Exist

**Error:**
```
relation "documents" does not exist
```

**Cause:** Using hardcoded table name instead of dynamic table names.

**Solution:**
```go
// ❌ Wrong
query := "SELECT * FROM documents WHERE id = $1"

// ✅ Correct
query := fmt.Sprintf("SELECT * FROM %s WHERE id = $1", db.Tables.Documents)
```

**Check:**
- Environment variable `ENVIRONMENT` is set (dev/test/prod)
- Tables created with correct prefix (e.g., `dev_documents`)

## Seeding Issues

### Seed Fails with FK Constraint Error

**Error:**
```
violates foreign key constraint
```

**Cause:** Tables not empty, trying to insert with conflicting IDs.

**Solution:**
```bash
# Use seed-fresh to drop and recreate
make seed-fresh
```

**Production safety:** `seed-fresh` and `seed-clear` are blocked when `ENVIRONMENT=prod`.

### Seed Data Not Appearing

**Check:**
1. Correct environment: `echo $ENVIRONMENT`
2. Correct database: Check `SUPABASE_DB_URL`
3. Correct table prefix: Run seed script with logging
4. Verify project ID matches `TEST_PROJECT_ID` in `.env`

## Server Issues

### Port Already in Use

**Error:**
```
bind: address already in use
```

**Solution:**
```bash
# Find process using port 8080
lsof -i :8080

# Kill the process
kill -9 <PID>

# Or use different port
PORT=8081 make run
```

### Environment Variables Not Loaded

**Symptoms:** Connection errors, missing config

**Check:**
```bash
# Verify .env exists
ls -la .env

# Check environment loading in config.go
# Should use godotenv.Load()
```

**Solution:**
1. Copy `.env.example` to `.env`
2. Fill in all required variables
3. Restart server

## API Issues

### 401 Unauthorized

**Phase 1 (Auth Stub):**

**Cause:** Missing or invalid `TEST_USER_ID` or `TEST_PROJECT_ID`.

**Check `.env`:**
```env
TEST_USER_ID=00000000-0000-0000-0000-000000000001
TEST_PROJECT_ID=00000000-0000-0000-0000-000000000002
```

**Verify test project exists:**
```sql
SELECT * FROM dev_projects WHERE id = '00000000-0000-0000-0000-000000000002';
```

### 409 Conflict - Duplicate Document/Folder

**Error response:**
```json
{
  "error": "document 'Chapter 1' already exists in this location",
  "conflict": {
    "type": "duplicate",
    "resource_type": "document",
    "resource_id": "uuid-of-existing",
    "location": "/api/documents/uuid-of-existing"
  }
}
```

**Cause:** Unique constraint on `(project_id, folder_id, name)`.

**Solution:**
- Use different name
- Or update existing document (PATCH)
- Or delete existing first

### 400 Validation Error - Folder Name Contains Slash

**Error:**
```json
{
  "error": "folder name cannot contain '/'"
}
```

**Cause:** Folder names used in paths, slashes would create ambiguity.

**Solution:** Remove slashes from folder name.

**Note:** Document names CAN contain slashes (e.g., "Hero/Villain").

## Import Issues

### Zip File Rejected

**Error:**
```json
{
  "file": "backup.txt",
  "error": "file is not a zip file"
}
```

**Cause:** Wrong Content-Type or file is not a zip.

**Solution:**
- Ensure file has `.zip` extension
- Upload as `application/zip` or `application/x-zip-compressed`

### Import Creates Wrong Folder Structure

**Check:**
- Frontmatter `folder:` field (if using)
- Zip file structure (folders map to paths)
- Leading/trailing slashes in paths

**Example frontmatter:**
```markdown
---
folder: Characters/Heroes
name: Aria
---

Content here...
```

## Build/Compilation Issues

### Module Not Found

**Error:**
```
cannot find module
```

**Solution:**
```bash
go mod download
go mod tidy
```

### Import Cycle

**Error:**
```
import cycle not allowed
```

**Cause:** Violating layer dependency rules.

**Check:**
- Handler imports Service? ✅
- Service imports Repository? ✅
- Repository imports Service? ❌ (cycle!)

**Solution:** Move shared code to `domain/` layer.

## Testing Issues

### Test Database Not Isolated

**Problem:** Tests affecting each other.

**Solution:**
1. Set `ENVIRONMENT=test` for tests
2. Use `test_*` tables
3. Clear test data between runs: `make seed-clear` (in test environment)

### Insomnia Collection Not Working

**Check:**
1. Server running: `make run`
2. Correct base URL: `http://localhost:8080`
3. Project ID matches test project
4. Import latest collection: `tests/insomnia-collection.json`

## Performance Issues

### Slow Tree Endpoint

**Cause:** Large project with many folders/documents.

**Current:** Single query loads all data.

**Future optimization:** Lazy loading, pagination.

**Workaround:** Reduce folder depth, limit documents per folder.

### Slow Import

**Cause:** Processing large zip file synchronously.

**Current:** Processes in single request.

**Future optimization:** Background jobs, chunking.

**Workaround:** Split large imports into smaller zip files.

## Debugging Tips

### Enable SQL Query Logging

**Temporary logging:**
```go
// In repository/postgres/connection.go
// Add before QueryRow/Exec:
log.Println("Query:", query)
log.Println("Args:", args...)
```

### Structured Logging

**Check logs for context:**
```bash
# Server logs show:
# - Request IDs
# - User/Project IDs
# - Operation context
# - Errors with stack traces
```

**Log levels:**
- `INFO` - Normal operations
- `WARN` - Recoverable errors
- `ERROR` - Failed operations

### API Testing with curl

**Quick endpoint test:**
```bash
# Health check
curl http://localhost:8080/health

# Get projects
curl http://localhost:8080/api/projects

# Get tree
curl http://localhost:8080/api/projects/{PROJECT_ID}/tree

# Create document
curl -X POST http://localhost:8080/api/documents \
  -H "Content-Type: application/json" \
  -d '{"project_id":"...","name":"Test","content":"# Hello"}'
```

### Database State Inspection

**View data:**
```sql
-- Projects
SELECT * FROM dev_projects;

-- Folders with hierarchy
SELECT
  f.name,
  f.parent_id,
  p.name as parent_name
FROM dev_folders f
LEFT JOIN dev_folders p ON f.parent_id = p.id
ORDER BY f.project_id, p.name NULLS FIRST, f.name;

-- Documents with paths (requires joining folders)
SELECT
  d.name,
  f.name as folder_name,
  d.word_count,
  d.updated_at
FROM dev_documents d
LEFT JOIN dev_folders f ON d.folder_id = f.id
ORDER BY f.name NULLS FIRST, d.name;
```

## Getting Help

**Steps:**
1. Check this debugging guide
2. Review relevant documentation:
   - [Database Connections](../database/connections.md)
   - [API Contracts](../api-contracts.md)
   - [Architecture Overview](../architecture/overview.md)
3. Check server logs for error details
4. Inspect database state
5. Test with curl to isolate frontend vs backend issues

**Logs location:**
- Development: stdout (console)
- Production: Check Railway/deployment logs

## Common Gotchas

### Root Level Ambiguity

**Problem:** Confusing ways to represent root level.

**Correct representations (all equivalent):**
```json
{"folder_id": null}
{"folder_id": ""}
{/* folder_id omitted */}
```

**Use in updates:** Empty string (`""`) to disambiguate from "no change".

### Word Count Not Updating

**Cause:** Word count computed on create/update, not automatically.

**Trigger update:**
```bash
# PATCH document with content
curl -X PATCH http://localhost:8080/api/documents/{ID} \
  -H "Content-Type: application/json" \
  -d '{"content":"Updated content"}'
```

### Path Changes Not Reflected

**Cause:** Paths are computed, but may be cached on frontend.

**Solution:** Re-fetch tree after folder rename/move.

## References

- Database troubleshooting: [database/connections.md](../database/connections.md)
- API error responses: [api-contracts.md](../api-contracts.md#error-responses)
- Environment setup: `/backend/.ENVIRONMENTS.md`
- Commands: `/backend/CLAUDE.md`
