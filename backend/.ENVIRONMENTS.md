# Environment Configuration - Quick Reference

For comprehensive environment setup documentation, see: `../_docs/technical/backend-environment-setup.md`

## Quick Summary

### Table Prefixes

| Environment | Tables |
|-------------|--------|
| `dev` | `dev_projects`, `dev_documents` |
| `test` | `test_projects`, `test_documents` |
| `prod` | `prod_projects`, `prod_documents` |

### Setup

```env
# .env
ENVIRONMENT=dev  # or test, or prod
```

Backend automatically prefixes all tables based on this value.

### Database Connections

| Connection Type | Port | Use Case | Configuration |
|-----------------|------|----------|---------------|
| Pooled (PgBouncer) | 6543 | Development | Auto-detects simple protocol |
| Direct | 5432 | Production | Auto-uses prepared statements |

**Development:**
```env
# Port 6543 auto-configures to avoid prepared statement conflicts
SUPABASE_DB_URL=postgresql://...@...pooler.supabase.com:6543/postgres
```

**Production:**
```env
# Port 5432 uses prepared statements for best performance
SUPABASE_DB_URL=postgresql://...@db.your-project.supabase.co:5432/postgres
```

⚠️ **Important**: Port 6543 is auto-detected and uses simple protocol. For explicit control, add `?default_query_exec_mode=simple_protocol`.

📖 **Full details**: `../_docs/technical/backend/database-connections.md`

### Two Approaches

**Single Database (Phase 1):**
- Run `schema.sql` once
- Switch environments by changing `ENVIRONMENT` variable
- Simple, fast, good for development

**Separate Databases (Production):**
- Create separate Supabase projects per environment
- Complete isolation
- Better for production

### Code Usage

Always use dynamic table names:

```go
// ✅ Correct
query := fmt.Sprintf("SELECT * FROM %s", db.Tables.Documents)

// ❌ Wrong
query := "SELECT * FROM documents"
```

---

**📖 Full documentation**: `../_docs/technical/backend/environment-setup.md`
