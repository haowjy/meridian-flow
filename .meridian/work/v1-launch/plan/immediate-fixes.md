# Immediate Fixes — Pre-Round 0

Three critical code fixes and one design decision, all blocking before backend implementation can start safely.

## Fix 1: Autoapply Enforcement in Proposal Acceptance

**Severity:** CRITICAL
**Found by:** R5 security review (p130)
**Problem:** `ProposalService.CreateProposal` auto-accepts proposals based on "owner tabs present" — completely ignores the folder's `autoapply` flag. An agent writing to `.agents/skills/foo/SKILL.md` gets its changes silently applied when no editor tab is open for that document.

**Current path:** `CreateProposal` → check `hasOwnerTabs` → if no tabs, call `backendFallbackAccept` → applies Yjs update immediately.

**Fix:** Before auto-accepting, resolve the effective `autoapply` for the target document:

```
document.autoapply → folder.autoapply → parent_folder.autoapply → ... → project.autoapply
```

If the resolved value is `false`, force proposals to remain `pending` — never backend-fallback-accept. System folders override document-level values.

**Files to modify:**
- `backend/internal/service/collab/proposal_service.go` — add autoapply resolution before accept decision
- Need a utility: `ResolveEffectiveAutoapply(ctx, documentID) bool` that walks folder→parent→project

**Scope:** ~50 lines of new code + tests.

---

## Fix 2: CreateProposal Ownership Check

**Severity:** CRITICAL
**Found by:** R5 security review (p130)
**Problem:** `CreateProposal` accepts a `DocumentID` and persists/applies updates without verifying the caller can access that document. Any upstream bug that lets an attacker influence `DocumentID` becomes a cross-project write.

**Fix:** Add ownership verification inside `CreateProposal`:

```go
func (s *proposalService) CreateProposal(ctx, req) (*Proposal, error) {
    // Verify caller can access the document
    if err := s.authorizer.CanAccessDocument(ctx, req.CreatedByUserID, req.DocumentID); err != nil {
        return nil, err
    }
    // ... existing logic
}
```

**Files to modify:**
- `backend/internal/service/collab/proposal_service.go` — add auth check
- `backend/internal/service/collab/proposal_service_test.go` — add test for unauthorized proposal

**Scope:** ~10 lines + test.

---

## Fix 3: Import/Replace Must Skip System Folders

**Severity:** CRITICAL
**Found by:** R2 backend review (p127)
**Problem:** `POST /api/import/replace` calls `DeleteAllByProject`, which soft-deletes every document in the project — including `.agents/` skills and `.meridian/work/` artifacts once those folders have content.

**Fix:** `DeleteAllByProject` should skip documents inside system folders:

```sql
UPDATE documents SET deleted_at = NOW()
WHERE project_id = $1 AND deleted_at IS NULL
  AND folder_id NOT IN (
    SELECT id FROM folders WHERE is_system = true AND project_id = $1
  )
  AND folder_id NOT IN (
    -- Also skip descendants of system folders
    SELECT f.id FROM folders f
    JOIN folders parent ON f.parent_id = parent.id
    WHERE parent.is_system = true AND f.project_id = $1
  )
```

Or simpler: add `AND (folder_id IS NULL OR folder_id NOT IN (SELECT id FROM folders WHERE is_system = true ...))`.

Also: the replace import should not create/overwrite documents inside system folder paths.

**Files to modify:**
- `backend/internal/repository/postgres/docsystem/document.go` — update `DeleteAllByProject` query
- `backend/internal/service/docsystem/import.go` — skip system folder paths during import

**Scope:** ~20 lines.

---

## Fix 4: JWT Expiry Fails Open

**Severity:** HIGH
**Found by:** R5 security review (p130)
**Problem:** If JWT `exp` claim is missing, `jwtExpiry` is zero, and the heartbeat loop skips the expiry check (`!jwtExpiry.IsZero()`). Socket lives forever.

**Fix:** Either:
a) Require `exp` at JWT verification time (reject tokens without expiry), or
b) Treat zero expiry as "expire after N minutes" (defensive timeout)

Option (a) is simpler and correct — Supabase always includes `exp`.

**Files to modify:**
- `backend/internal/auth/jwt_verifier.go` — reject claims without `exp`

**Scope:** ~5 lines.

---

## Fix 5: Skill Service Bypasses Immutability

**Severity:** HIGH
**Found by:** R3 service review (p123), R5 security review (p130)
**Problem:** Skill service calls `folderRepo.Update/Delete` directly, bypassing the `folderService` immutability guards. After the migration backfills `.meridian/skills` subfolders, these become mutable via skill CRUD even though they're children of a system folder.

**Fix:** Two options:
a) Route skill folder mutations through `folderService` (which has guards), or
b) Don't mark `.meridian/skills/` subfolders as `is_system` (current migration already does this correctly — only root `.meridian` and `.agents` are `is_system`)

Option (b) is already the case after the migration fix. The remaining issue is that skill service should still respect the parent system folder's policy. For now: document that `.meridian/skills/*` subfolders are NOT immutable (skills can be renamed/deleted), and verify the migration doesn't mark them as system.

**Files to modify:**
- Verify `backend/migrations/00029_folder_document_metadata.sql` only sets `is_system` on root folders (already done)
- Add a comment in `backend/internal/service/skill/project_skill.go` noting that skill subfolders are intentionally mutable

**Scope:** Verification + comment only.

---

## Execution Order

1. **Fix 2** (CreateProposal auth) — smallest, most surgical, eliminates a trust boundary gap
2. **Fix 4** (JWT expiry) — 5 lines, closes a fail-open
3. **Fix 3** (Import skip system) — protects system folder content
4. **Fix 1** (Autoapply enforcement) — largest, requires new utility + integration with proposal service
5. **Fix 5** (Skill service) — verification only

Fixes 1-4 can be done by a single coder in one session. Fix 5 is a verification pass.
