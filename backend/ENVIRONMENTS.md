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
