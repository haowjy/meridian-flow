# Phase 1: Daytona Sandbox Service

**Round 1** — Foundation. All subsequent phases depend on this.

## Scope

Implement the sandbox service that manages Daytona sandbox lifecycle for Python code execution. This is the infrastructure layer — no LLM tool integration yet.

## Intent

The execute_python tool needs a service to create, start, stop, and execute commands in Daytona sandboxes. This phase builds that service following the existing domain pattern (interfaces in `domain/`, implementation in `service/`, config in `config/`).

## Files to Create

- `backend/internal/domain/sandbox/interfaces.go` — Service interface + types
- `backend/internal/domain/sandbox/types.go` — SandboxInfo, SandboxState, ExecResult
- `backend/internal/service/sandbox/daytona.go` — DaytonaSandboxService implementation
- `backend/internal/service/sandbox/daytona_test.go` — Unit tests with mock Daytona client
- `backend/internal/config/sandbox.go` — SandboxConfig struct
- `backend/migrations/NNNNNN_create_project_sandboxes.up.sql` — project_sandboxes table
- `backend/migrations/NNNNNN_create_project_sandboxes.down.sql`
- `backend/internal/repository/postgres/sandbox.go` — SandboxRepository

## Files to Modify

- `backend/internal/config/config.go` — Add SandboxConfig to root Config struct
- `backend/internal/app/domains/` — Add sandbox domain wiring module
- `backend/.env.example` — Add DAYTONA_* env vars

## Interface Contract

```go
// domain/sandbox/interfaces.go
type Service interface {
    EnsureRunning(ctx context.Context, projectID uuid.UUID) (*SandboxInfo, error)
    Stop(ctx context.Context, projectID uuid.UUID) error
    ExecSync(ctx context.Context, projectID uuid.UUID, cmd string) (*ExecResult, error)
    ExecStream(ctx context.Context, projectID uuid.UUID, cmd string, onOutput func(stream string, data string)) (*ExecResult, error)
    WriteFile(ctx context.Context, projectID uuid.UUID, path string, content []byte) error
    ReadFile(ctx context.Context, projectID uuid.UUID, path string) ([]byte, error)
    HydrateDatasets(ctx context.Context, projectID uuid.UUID, datasetIDs []uuid.UUID) error
    GetSandboxState(ctx context.Context, projectID uuid.UUID) (SandboxState, error)
}
```

## Dependencies

- Requires: Daytona Go SDK import (check `github.com/daytonaio/sdk-go` or similar)
- Independent of: All other MVP phases (this is the foundation)

## Patterns to Follow

- Domain interfaces: `backend/internal/domain/agents/interfaces.go`
- Service implementation: `backend/internal/service/agents/persona_catalog.go`
- Config struct: `backend/internal/config/` (existing pattern with `env` tags)
- Migration: `backend/migrations/AGENTS.md` for rules (TABLE_PREFIX, naming)
- Repository: `backend/internal/repository/postgres/` (use `db.Tables.*` for table names)

## Verification Criteria

- [ ] `make build` passes with new files
- [ ] `make test` passes (unit tests for sandbox service with mock Daytona client)
- [ ] Migration applies cleanly: `make migrate-up`
- [ ] SandboxConfig loads from env vars
- [ ] Service interface compiles and is usable from tests

## Agent Staffing

- **Implementer**: `coder` (backend Go, well-defined interfaces)
- **Reviewer**: 1x reviewer with SOLID focus (verify domain separation)
- **Verifier**: `verifier` (build + tests)
