---
title: API Testing (curl)
description: Minimal curl examples for Meridian backend
created_at: 2025-11-12
updated_at: 2025-11-12
author: Meridian
category: technical
tracked: true
detail: minimal
audience: developer
---

# API Testing (curl)

Minimal, copy-pasteable commands to verify the backend locally.

## Base

- Base URL: `http://localhost:8080`
- Auth: JWT validation; user ID is extracted from validated JWT claims
- All requests require `Authorization: Bearer <JWT>` header (except `/health`)
- Project-scoped endpoints use a path param: `/api/projects/<PROJECT_ID>/...`

## Health

```bash
curl http://localhost:8080/health
```

## Projects

```bash
# List projects
curl http://localhost:8080/api/projects

# Create a project
curl -X POST http://localhost:8080/api/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"My Writing Project"}'
```

## Project Tree

```bash
PROJECT_ID="00000000-0000-0000-0000-000000000001"  # from .env (TEST_PROJECT_ID)
curl http://localhost:8080/api/projects/$PROJECT_ID/tree
```

## Documents

```bash
# Create (auto-create folders via folder_path)
curl -X POST http://localhost:8080/api/projects/$PROJECT_ID/documents \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Hero",
    "content": "# Hero\n\nThe hero of our story...",
    "folder_path": "Characters"
  }'

# Update content
DOC_ID="<document-uuid>"
curl -X PATCH http://localhost:8080/api/documents/$DOC_ID \
  -H "Content-Type: application/json" \
  -d '{"content":"# Hero\n\nRevised content..."}'

# Move to root (empty string is explicit root move)
curl -X PATCH http://localhost:8080/api/documents/$DOC_ID \
  -H "Content-Type: application/json" \
  -d '{"folder_id":""}'
```

## Import

```bash
# Merge (upsert)
curl -X POST http://localhost:8080/api/import \
  -F "files=@my-docs.zip"

# Replace (delete-all, then import) — DANGEROUS
curl -X POST http://localhost:8080/api/import/replace \
  -F "files=@my-docs.zip"
```

## Notes

- All endpoints (except `/health`) require `Authorization: Bearer <JWT>` header with valid JWT token from Supabase Auth
- For tree/document creation under a specific project, use the project-scoped routes with the path param.

## References

- API Overview: `_docs/technical/backend/api/overview.md`
- API Contracts: `_docs/technical/backend/api/contracts.md`
