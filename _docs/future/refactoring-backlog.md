# Refactoring Backlog

Technical debt and refactoring opportunities discovered during development.

## How to Use
- Run `/backlog` to review and update this file
- Items are prioritized: High -> Medium -> Low
- Check off items when completed (⬜ -> ✅)

---

## Backend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| Duplicate error handling | `document.go:54-98`, `folder.go:64-103` | Extract `handleCreateError()` | ⬜ |
| Repeated identifier resolution | `document.go:77-87, 119-135, 209-220, 297-308` | Extract `resolveDocumentID()` | ⬜ |
| Large interfaces (ISP) | `domain/repositories/docsystem/document.go` | Split into Reader/Writer/Metadata | ⬜ |

### Medium Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| Inline orchestration in service methods | Various `service/llm/` methods | Audit for shared logic that should be standalone functions (like `FormatToolResultContent` was extracted from `formatToolResultBlock`) | ⬜ |

### Low Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| No portable log-query abstraction | `.agents/skills/orchestrate/scripts/` | Create `query-log.sh` that abstracts output format differences across Claude/Codex/OpenCode backends, enabling agents to search/slice agent run logs without knowing the format | ⬜ |

---

## Frontend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| SRP violation | `useThreadStore.ts` (1,021 lines) | Split into separate stores | ⬜ |
| SRP violation | `DocumentTreeContainer.tsx` (746 lines) | Extract operation modules | ⬜ |
| Inconsistent dialogs | `DeleteFolderDialog.tsx` | Use `DeleteConfirmationDialog` | ⬜ |
| Duplicate keyboard handling | `TurnInput.tsx`, `EditTurnInput.tsx` | Extract shared hook | ⬜ |

### Medium Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| SheetContent defaults `gap-4 p-4` but both consumers override to `gap-0 p-0` | `shared/components/ui/sheet.tsx` | Change defaults to `gap-0 p-0`, let consumers opt in to spacing | ⬜ |

### Low Priority

(empty)
