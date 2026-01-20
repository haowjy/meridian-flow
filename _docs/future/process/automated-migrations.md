# Automated Database Migrations

## Current State

Manual migration via shell script:

```bash
./scripts/migrate.sh --prod up
```

Works fine for single developer with infrequent schema changes.

## Future State

Automated migrations triggered on deploy via GitHub Actions or Railway release command.

## When to Implement

- Manual becomes painful (multiple developers, frequent migrations)
- Have actual users (need reliability guarantees)

## Implementation Options

### Option 1: GitHub Actions

```yaml
# .github/workflows/migrate.yml (uncomment when ready)
# name: Database Migration
#
# on:
#   push:
#     branches: [main]
#     paths:
#       - 'backend/migrations/**'
#
# jobs:
#   migrate:
#     runs-on: ubuntu-latest
#     steps:
#       - uses: actions/checkout@v4
#
#       - name: Run migrations
#         env:
#           DATABASE_URL: ${{ secrets.SUPABASE_DB_URL }}
#         run: |
#           cd backend
#           ./scripts/migrate.sh up
```

### Option 2: Railway Release Command

Add to Railway service settings:
```
cd backend && ./scripts/migrate.sh up
```

Requires `DATABASE_URL` environment variable already configured.

## Required Secrets

| Secret | Description |
|--------|-------------|
| `SUPABASE_DB_URL` | Production database connection string |

## Considerations

- **Rollback strategy**: Keep `down` migrations tested
- **Zero-downtime**: Ensure migrations are backwards compatible
- **Dry run**: Add `--dry-run` flag to preview changes before applying
