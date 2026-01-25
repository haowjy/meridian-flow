---
detail: standard
audience: developer
---
# Remove Document Slugs (Move to Exact Path Addressing)

**Status:** In planning  
**Priority:** Medium (cleanup after path routing is stable)  
**Estimated effort:** 0.5–2 days (full-stack, breaking-risk if rushed)

## Problem Statement (WHY)

Meridian’s document “slug” has accumulated multiple meanings over time:
- originally project-scoped name slug
- later “path-based slug” by *slugifying* folder/name segments (lowercase, spaces→hyphens, strip special chars)

We now want a writer-first model:
- document URLs are **project-relative paths** (splat) with **exact decode**
- paths reflect **actual folder and file names**, including spaces/case/special chars (URL-encoded)

In that world, `documents.slug` becomes redundant and actively confusing.

## Goals / Non-goals

**Goals**
- Stop using document slugs for routing, linking, or lookup.
- Remove `documents.slug` column + indexes once unused.
- Keep project slugs (still valuable).

**Non-goals**
- Changing primary key type (UUID stays).
- Introducing public_id in this plan (separate decision).

## Prerequisites (must be true before dropping slug)

- Tree API returns an **exact `path`** for every document (folder path + `filename`).
- Frontend navigation uses `Document.path` exclusively for `/projects/<projectSlug>/documents/*path`.
- Backend supports resolving a document by exact path reliably:
  - `GetDocumentByPath` uses folder/doc names (already exists).
- Any remaining “document by identifier” code paths use UUID only (or add `/api/projects/{project}/documents/by-path` if needed).

## Migration Strategy (safe, incremental)

### Phase 1: Dual-read (no breaking) (0.5–1 day)
- Add `path` to tree DTO and plumb it to frontend `Document`.
- Switch frontend routing + deep link resolution from `doc.slug` → `doc.path`.
- Keep accepting old URLs as best-effort if needed (optional):
  - If splat has no extension, try `.md`.
  - If splat matches an old slugified form, optionally attempt a server-side mapping (only if you still have `slug`).

### Phase 2: Stop writing slug (optional) (0.25–0.5 day)
- Stop updating `documents.slug` on create/rename/move.
- Remove any “slug exists” constraints used at runtime.

### Phase 3: Drop slug column (breaking only for internal code) (0.25–0.5 day)
- Remove from:
  - DB schema: drop `documents.slug` and any indexes (`idx_documents_project_slug`).
  - Backend: delete `GetBySlug`, `SlugExists`, `UpdateSlug`, slug cascade logic.
  - Identifier resolver: remove document slug resolution paths.
  - Frontend: remove `Document.slug` field and any slug-based helpers.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Old deep links break after rename/move | Add optional `/docs/<id>` canonical link later, or keep a path-history table if needed |
| Percent-decoding mismatches between FE/BE | Centralize encode/decode helpers; “decode exactly once” invariant |
| Ambiguous no-extension links | Canonicalize to “always include extension”; `.md` fallback only if exact match exists |

## Success Criteria

- [ ] Document routing works with exact decoded paths including spaces/special chars.
- [ ] No code path depends on `documents.slug`.
- [ ] `documents.slug` and related DB/index/repo code removed cleanly.

## Related Documentation

- `_docs/plans/fb-project-skills-v1-and-artifact-foundations.md`
