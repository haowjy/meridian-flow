# Phase AI: Git Import + Import Service (Allowlist SSRF)

## Scope
Create GitFetcher (clone with SSRF allowlist), ImportService (validate + batch write), and HTTP endpoint.

## Files to Create
- `backend/internal/service/agents/git_fetcher.go` — GitFetcher implementation
- `backend/internal/service/agents/git_fetcher_test.go`
- `backend/internal/service/agents/import_service.go` — ImportService implementation
- `backend/internal/service/agents/import_service_test.go`
- `backend/internal/handler/agent_import.go` — POST /api/projects/{id}/agents/import-git

## Key Details
- GitFetcher.ValidateURL: HTTPS-only, hostname in allowlist [github.com, gitlab.com, bitbucket.org]
- GitFetcher.Clone: git clone --depth=1, 50MB repo cap, 1MB file cap
- Validate: structure checks, binary detection, symlink rejection
- ImportService: clone → extract .agents/ → validate frontmatter → always-overwrite → ExecTx batch write
- Atomic: all-or-nothing within ExecTx

## Verification Criteria
- [ ] `make test` passes
- [ ] Reject non-HTTPS URLs
- [ ] Reject hosts not on allowlist
- [ ] Invalid frontmatter → 422, no partial writes
- [ ] Binary file → 422
- [ ] Symlinks rejected
- [ ] Atomic: all-or-nothing within ExecTx
- [ ] `go vet ./...` clean
