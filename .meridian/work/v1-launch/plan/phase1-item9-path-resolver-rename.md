# Phase 1: Path Resolver Rename (Item 9)

## Scope
Rename the tools-side `DocumentPathResolver` to `ToolPathResolver` to distinguish it from the docsystem path resolver. These are different things with different capabilities — the name should make that obvious.

## Files to Modify
- `backend/internal/service/llm/tools/path_resolver.go` — rename struct `DocumentPathResolver` -> `ToolPathResolver`
- All files that reference `DocumentPathResolver` — update to `ToolPathResolver`

## Current State
- **Tools side** (`tools/path_resolver.go`): `DocumentPathResolver` struct — read-only path walking for display paths
- **Docsystem side** (`service/docsystem/path_resolver.go`): `pathResolverService` — write-capable path notation resolution (creates folders)
- Interface: `domaindocsys.PathNotationResolver`

The tools one is read-only. It walks folder hierarchies to build display paths. It should NOT be confused with the docsystem one that creates/modifies folder structures.

## Implementation
1. Rename `DocumentPathResolver` -> `ToolPathResolver` in `tools/path_resolver.go`
2. Rename constructor `NewDocumentPathResolver` -> `NewToolPathResolver`
3. Update all references (likely in `tools/builder.go` and possibly `streaming/deps.go` or `streaming/service.go`)

## Constraints
- Only rename the tools-side resolver, not the docsystem one
- Don't merge the two resolvers — they are intentionally separate
- Don't change any behavior, just the name

## Verification Criteria
- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go vet ./...` passes
- [ ] No references to `DocumentPathResolver` remain (in tools package)
- [ ] Docsystem path resolver unchanged
