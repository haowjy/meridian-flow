# Phase 1: ISP Consumer Narrowing (Item 6)

## Scope
Change consumers that use the composite `DocumentStore` interface to use the narrower `DocumentReader` interface when they only need read methods. Primary target: `OwnerBasedAuthorizer`.

## Files to Modify
- `backend/internal/service/auth/owner_authorizer.go` — change `docRepo` field from `DocumentStore` to `DocumentReader`
- Any constructor/wiring that passes DocumentStore where DocumentReader now suffices

## Current State
Domain interfaces are already split (good ISP design at the domain level):
- `DocumentReader` — GetByID, GetByIDOnly, GetByPath, ListByFolder, GetAllMetadataByProject
- `DocumentWriter` — Create, Update, Delete, Move
- `DocumentSearcher` — Search
- `DocumentPathResolver` — ResolvePathNotation
- `DocumentStore` — composite of all four

`OwnerBasedAuthorizer` (line 23) declares `docRepo domaindocsys.DocumentStore` but only calls `GetByIDOnly` — a reader method.

## Implementation
1. In `owner_authorizer.go`: change field type and constructor param from `DocumentStore` to `DocumentReader`
2. Find where `OwnerBasedAuthorizer` is constructed (likely in `internal/app/domains/auth.go`) and verify the passed value satisfies `DocumentReader` (it will — DocumentStore embeds DocumentReader)
3. Search for other consumers of `DocumentStore` that only use reader methods — narrow those too

## How to Find Other Consumers
Search for `DocumentStore` in struct fields and function params outside of the repository package (repos implement the full interface, that's fine). For each consumer, check which methods it actually calls.

## Constraints
- Don't change the domain interfaces themselves — they're already correctly split
- Don't change the repository implementation — it correctly implements the full interface
- Only narrow the consumer side (struct fields, constructor params)
- Don't merge any interfaces — keep Reader/Writer/Searcher/PathResolver separate

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] `OwnerBasedAuthorizer.docRepo` is `DocumentReader`, not `DocumentStore`
- [ ] No consumer uses a wider interface than it needs
