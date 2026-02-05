# Refactoring Backlog

Technical debt and refactoring opportunities discovered during development.

## How to Use
- Run `/backlog` to review and update this file
- Items are prioritized: High → Medium → Low
- Check off items when completed (⬜ → ✅)

---

## Backend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| Duplicate error handling | `document.go:54-98`, `folder.go:64-103` | Extract `handleCreateError()` | ⬜ |
| Repeated identifier resolution | `document.go:77-87, 119-135, 209-220, 297-308` | Extract `resolveDocumentID()` | ⬜ |
| Large interfaces (ISP) | `domain/repositories/docsystem/document.go` | Split into Reader/Writer/Metadata | ⬜ |

### Medium Priority

(empty)

### Low Priority

(empty)

---

## Frontend

### High Priority

| Issue | Location | Refactor | Status |
|-------|----------|----------|--------|
| SRP violation | `useThreadStore.ts` (1,021 lines) | Split into separate stores | ⬜ |
| SRP violation | `DocumentTreeContainer.tsx` (746 lines) | Extract operation modules | ⬜ |
| Inconsistent dialogs | `DeleteFolderDialog.tsx` | Use `DeleteConfirmationDialog` | ⬜ |
| Duplicate keyboard handling | `TurnInput.tsx`, `EditTurnDialog.tsx` | Extract shared hook | ⬜ |

### Medium Priority

(empty)

### Low Priority

(empty)
