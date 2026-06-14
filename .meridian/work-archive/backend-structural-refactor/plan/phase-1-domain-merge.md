# Phase 1: Domain Package Merge + Naming Fixes

## Scope and Intent

Merge three separate domain trees (`domain/models/<domain>/`, `domain/services/<domain>/`, `domain/repositories/<domain>/`) into a single `domain/<domain>/` package per domain. Apply naming fixes during each move. The goal: agents import ONE package per domain, zero aliases needed.

This is the largest phase — 8 domains, ~70 files moved, ~100+ import sites updated. Work domain-by-domain in blast radius order, with a verification gate after each.

## Execution Order

1. `billing` (10 files → `domain/billing/`, ~40 import sites — proves the pattern)
2. `skill` (2 files → `domain/skill/`, small blast radius)
3. `auth` (1 file + ResourceAuthorizer relocation → `domain/auth/`, ~19 import sites)
4. `identifier` (1 file → `domain/identifier/`, small)
5. Root relocations: `TransactionManager` → `domain/transaction.go`, `UserPreferences` → `domain/user_preferences.go`
6. `llm` (22 files → `domain/llm/`, ~40 import sites — includes TurnStatus enum, tool_limits.go extraction)
7. `collab` (5 files → `domain/collab/`, ~23 import sites — includes Store interface relocation)
8. `docsystem` (22 files → `domain/docsystem/`, ~33 import sites — includes ISP split, dead code removal)

## Per-Domain Merge Pattern

For each domain, repeat this exact sequence:

1. **Create target directory**: `domain/<domain>/`
2. **Move model files** from `domain/models/<domain>/*.go` → `domain/<domain>/`
   - Change `package <domain>model` or `package <domain>` to `package <domain>` (should already match in most cases)
3. **Move service interface files** from `domain/services/<domain>/*.go` → `domain/<domain>/`
   - These are interface definitions only — no implementations
4. **Move repository interface files** from `domain/repositories/<domain>/*.go` → `domain/<domain>/`
   - Rename all `*Repository` interfaces to `*Store`
5. **Update all import sites** across the codebase
   - Old: `billingmodel "meridian/internal/domain/models/billing"` → New: `"meridian/internal/domain/billing"`
   - Old: `billingdomain "meridian/internal/domain/services/billing"` → New: (same package, alias removed)
   - Old: `billingRepo "meridian/internal/domain/repositories/billing"` → New: (same package, alias removed)
   - Remove all aliases that were only needed because of the 3-package split
6. **Apply naming fixes** specific to this domain (see section below)
7. **Add compile-time assertions** to all implementation files: `var _ billing.CreditSettler = (*creditSettler)(nil)`
8. **Verify**: `cd backend && go build ./... && go test ./...`
9. **Delete empty source directories** after move

## File Naming Convention Within Domain Packages

- Model/type files: descriptive name (`turn.go`, `proposal.go`, `types.go`)
- Service interfaces: `<name>_service.go` when interface name ends in "Service" (`document_service.go` → `DocumentService`). Bare descriptive name otherwise (`settler.go` → `CreditSettler`)
- Store interfaces: `<name>_store.go` (`credit_store.go`, `thread_store.go`)
- One-per-package rule: When a package has exactly one store or service, use generic `store.go` or `service.go`. When multiple, use qualified names.

## Domain-Specific Instructions

### 1. billing (10 files)

Source files:
- `domain/models/billing/types.go` → `domain/billing/types.go`
- `domain/models/billing/pricing.go` → `domain/billing/pricing.go`
- `domain/models/billing/pricing_test.go` → `domain/billing/pricing_test.go`
- `domain/services/billing/billing.go` → `domain/billing/service.go` (rename: CreditService is the main service)
- `domain/services/billing/admission.go` → `domain/billing/admission.go`
- `domain/services/billing/settler.go` → `domain/billing/settler.go`
- `domain/services/billing/granter.go` → `domain/billing/granter.go`
- `domain/services/billing/stripe.go` → `domain/billing/stripe.go`
- `domain/repositories/billing/credit_store.go` → `domain/billing/credit_store.go`
- `domain/repositories/billing/generation_billing_store.go` → `domain/billing/billing_store.go` (rename for clarity)

Naming fixes during billing merge:
- `billingdomainSettleRequestInput` → `buildSettleRequestInput` (if this exists as a function name)
- `handleTerminalSettlement` → `handleFinalSettlement` (in `service/billing/credit_settler.go`)
- All `billingmodel` and `billingdomain` import aliases → remove (now one package)

Import sites to update (~40 unique files):
- `cmd/server/main.go`
- `internal/handler/billing.go`, `internal/handler/auth_handler.go`, `internal/handler/auth_handler_test.go`
- `internal/middleware/credit_gate.go`
- `internal/jobs/enrich_generation.go`, `internal/jobs/reconcile_billing.go`, `internal/jobs/expire_credits.go`
- All `internal/service/billing/*.go` files
- `internal/service/llm/setup.go`, `internal/service/llm/streaming/service.go`
- `internal/service/llm/streaming/billing_handler.go`, `cancel_handler.go`, `completion_handler.go`, `mstream_adapter.go`
- `internal/repository/postgres/billing/*.go`

### 2. skill (2 files)

Source files:
- `domain/models/skill/project_skill.go` → `domain/skill/project_skill.go`
- `domain/services/skill/project_skill.go` → `domain/skill/service.go` (one service in package → generic name)
- `domain/repositories/skill/project_skill.go` → `domain/skill/store.go` (one store → generic name; rename ProjectSkillRepository → ProjectSkillStore)

### 3. auth (2 files)

Source files:
- `domain/models/auth.go` (root package) → `domain/auth/auth.go` (includes AuthClaims)
- `domain/services/auth.go` (root package) → `domain/auth/auth.go` (merge with above — ResourceAuthorizer + AuthClaims in same file)

ResourceAuthorizer has ~19 import sites including:
- `internal/service/llm/streaming/service.go` (imports `"meridian/internal/domain/services"` for `services.ResourceAuthorizer`)
- `internal/service/collab/proposal_service.go`, `restore_service.go`
- `internal/service/docsystem/document.go`, `folder.go`, `project.go`
- `internal/service/llm/thread_history/service.go`
- `internal/service/auth/authorizer.go`
- `internal/middleware/*.go`

Update: `services.ResourceAuthorizer` → `auth.ResourceAuthorizer` everywhere.

### 4. identifier (1 file)

Source files:
- `domain/services/identifier/resolver.go` → `domain/identifier/resolver.go`

### 5. Root relocations

- `domain/repositories/transaction.go` (`TransactionManager` interface) → `domain/transaction.go`
  - Change package from `repositories` to `domain`
  - Update all ~16 import sites: `repositories.TransactionManager` → `domain.TransactionManager`
- `domain/services/user_preferences.go` → `domain/user_preferences.go`
  - Change package from `services` to `domain`
- `domain/repositories/user_preferences.go` → `domain/user_preferences.go` (merge with above, rename `UserPreferencesRepository` → `UserPreferencesStore`)
- After these moves, `domain/services/` root package should have NO files left (auth.go moved earlier)
- After these moves, `domain/repositories/` root package should have NO files left
- `domain/models/auth.go` and `domain/models/user_preferences.go` should already be moved

### 6. llm (22 files)

Source files from models/llm/:
- `thread.go`, `turn.go`, `turn_block.go`, `turn_block_delta.go`, `turn_block_filter_test.go`, `content_types.go`, `tool_definition.go`, `request_params.go`, `model_mapping.go`, `openrouter_models.go`
- All → `domain/llm/`

Source files from services/llm/:
- `thread.go` → `domain/llm/thread_service.go`
- `streaming.go` → `domain/llm/streaming.go`
- `provider.go` → `domain/llm/provider.go`
- `message_builder.go` → `domain/llm/message_builder.go`
- `system_prompt.go` → `domain/llm/system_prompt.go`
- `thread_history.go` → `domain/llm/thread_history.go`
- `tool_limits.go` → `domain/llm/tool_limits.go` (**INTERFACE ONLY** — extract `ConfigToolLimitResolver` impl to `service/llm/tool_limit_resolver.go`)

Source files from repositories/llm/:
- `thread.go` → `domain/llm/thread_store.go` (rename `ThreadRepository` → `ThreadStore`)
- `turn.go` → `domain/llm/turn.go` (keep composite, rename `TurnRepository` → `TurnStore`)
- `turn_reader.go` → `domain/llm/turn_reader.go`
- `turn_writer.go` → `domain/llm/turn_writer.go`
- `turn_navigator.go` → `domain/llm/turn_navigator.go`

Naming fixes during llm merge:
- `ResponseGenerator` struct → delete dead `GenerateResponse` method and its helper `buildMessages`, then rename struct to `ProviderResolver` (in `service/llm/streaming/response_generator.go` → rename file to `provider_resolver.go`)
- `mstream_adapter.go` → `stream_executor.go` (in `service/llm/streaming/`)
- `turnRepo` field name (typed as `TurnWriter`) → `turnWriter` (in `service/llm/streaming/service.go` and anywhere else)
- `persistOpenRouterGenerationRecord` → `persistGenerationRecord` (in streaming package)
- `SetupServices` → `SetupLLMServices` (in `service/llm/setup.go`)
- Add `TurnStatus` typed enum in `domain/llm/turn.go`:
  ```go
  type TurnStatus string
  const (
      TurnStatusPending         TurnStatus = "pending"
      TurnStatusStreaming        TurnStatus = "streaming"
      TurnStatusWaitingSubagents TurnStatus = "waiting_subagents"
      TurnStatusComplete        TurnStatus = "complete"
      TurnStatusCancelled       TurnStatus = "cancelled"
      TurnStatusError           TurnStatus = "error"
      TurnStatusCreditLimited   TurnStatus = "credit_limited"
  )
  ```
- Update all bare string comparisons for turn status to use typed constants
- Add migration for `credit_limited` to turn status CHECK constraint (check current migration numbering — use next available number)

Known import alias exception: `service/llm/setup.go` needs `domainllm "meridian/internal/domain/llm"` because it's also package `llm`.

### 7. collab (5+ files)

Source files from models/collab/:
- `proposal.go`, `document_ref.go`, `document_touch.go`, `snapshot.go` → `domain/collab/`

Source files from services/collab/:
- `collab.go` → split into multiple files per the design map:
  - `domain/collab/session.go` — DocumentSessionProvider, SyncSession, DocumentContentLoader
  - `domain/collab/state.go` — DocumentStateStore, CheckpointStore, ProjectedStateBuilder
  - `domain/collab/update_log.go` — UpdateLogStore + UpdateLogEntry
  - `domain/collab/bookmark.go` — BookmarkStore + Bookmark (if defined here)
  - `domain/collab/presence.go` — OwnerTabPresenceTracker, StatusMirror
  - `domain/collab/resolver.go` — DocumentResolver, AutoapplyResolver
  - `domain/collab/restore.go` — RestoreService
  - `domain/collab/state_manager.go` — DocumentStateManager (rename from ProposalRuntime)
  - `domain/collab/proposal.go` — merge model Proposal with ProposalStore + ProposalService + request types

Note: collab currently has NO `domain/repositories/collab/` — store interfaces are in `domain/services/collab/collab.go`. These get split into the files above during the merge.

Naming fix: `ProposalRuntime` → `DocumentStateManager`

### 8. docsystem (22 files)

Source files from models/docsystem/:
- `document.go`, `folder.go`, `project.go`, `file_type.go`, `search.go` → `domain/docsystem/`

Source files from services/docsystem/:
- `document.go` → `domain/docsystem/document_service.go`
- `folder.go` → `domain/docsystem/folder_service.go`
- `project.go` → `domain/docsystem/project_service.go`
- `tree.go` → `domain/docsystem/tree_service.go`
- `tree_models.go` → `domain/docsystem/tree_models.go`
- `content_analyzer.go` → `domain/docsystem/content_analyzer.go`
- `content_converter.go` → `domain/docsystem/content_converter.go`
- `favorite.go` → `domain/docsystem/favorite_service.go` (FavoriteService — add if missing from current interface)
- `file_processor.go` → `domain/docsystem/file_processor.go`
- `import.go` → `domain/docsystem/import_service.go`
- `namespace.go` → `domain/docsystem/namespace.go`
- `path_resolver.go` → `domain/docsystem/path_resolver.go` (rename PathResolver → DocumentPathResolver)
- `uploaded_file.go` → `domain/docsystem/uploaded_file.go`

Source files from repositories/docsystem/:
- `document.go` → ISP split into 4 files:
  - `domain/docsystem/document_reader.go` — DocumentReader (GetByID, GetByIDOnly, GetByPath, ListByFolder, GetAllMetadataByProject)
  - `domain/docsystem/document_writer.go` — DocumentWriter (Create, Update, Delete, DeleteAllByProject)
  - `domain/docsystem/document_searcher.go` — DocumentSearcher (SearchDocuments)
  - `domain/docsystem/document_store.go` — DocumentStore composite (embeds Reader+Writer+Searcher+DocumentPathResolver)
  - **DELETE** `GetAllByFolderRecursive` — zero callers, dead code
- `folder.go` → `domain/docsystem/folder_store.go` (rename FolderRepository → FolderStore)
- `project.go` → `domain/docsystem/project_store.go` (rename ProjectRepository → ProjectStore)
- `favorite.go` → `domain/docsystem/favorite_store.go` (rename FavoriteRepository → FavoriteStore)

Naming fix: `PathResolver` → `DocumentPathResolver` (interface + all references)

## Post-Merge Cleanup

After all 8 domains are merged:
1. Delete empty directories: `domain/models/`, `domain/services/`, `domain/repositories/`
2. Verify no orphaned imports: `grep -r "domain/models/" backend/` and `grep -r "domain/services/" backend/` and `grep -r "domain/repositories/" backend/` should return nothing from .go files
3. Verify no bare turn status strings: `grep -rn '"pending"\|"streaming"\|"complete"\|"cancelled"\|"error"\|"credit_limited"\|"waiting_subagents"' backend/internal/` — all should use TurnStatus constants (except migration SQL and test assertions)

## Migration: credit_limited CHECK Constraint

Add a new migration (use next available number after checking `backend/migrations/`):
```sql
-- +goose Up
-- +goose ENVSUB ON
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_status_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_status_check
    CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error', 'credit_limited'));

-- +goose Down
-- +goose ENVSUB ON
ALTER TABLE ${TABLE_PREFIX}turns
  DROP CONSTRAINT IF EXISTS ${TABLE_PREFIX}turns_status_check,
  ADD CONSTRAINT ${TABLE_PREFIX}turns_status_check
    CHECK (status IN ('pending', 'streaming', 'waiting_subagents', 'complete', 'cancelled', 'error'));
```

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] `grep -r "domain/models/" backend/internal/ --include="*.go"` returns nothing
- [ ] `grep -r "domain/services/" backend/internal/ --include="*.go"` returns nothing (except domain/services that no longer exist)
- [ ] `grep -r "domain/repositories/" backend/internal/ --include="*.go"` returns nothing
- [ ] No `billingmodel` or `billingdomain` import aliases remain
- [ ] `ConfigToolLimitResolver` struct is in `service/llm/`, not `domain/llm/`
- [ ] `GetAllByFolderRecursive` method is deleted (not wrapped)
- [ ] All implementation files have compile-time assertions
- [ ] TurnStatus typed enum is used everywhere (no bare strings except SQL/tests)
- [ ] credit_limited migration exists and runs

## Context Files

When spawning the coder, include:
- This blueprint (`plan/phase-1-domain-merge.md`)
- The design doc (`.meridian/work/backend-structural-refactor/design.md`) for the full domain map
