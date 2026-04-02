# Phase 1: Daytona Sandbox Service

**Round 1** — Foundation. Bash tool (Phase 2) depends on this.

## Scope

Implement the sandbox service that manages Daytona sandbox lifecycle and persistent Jupyter kernel. This is infrastructure — no LLM tool integration yet.

## Intent

The bash tool needs a service to create, start, stop, and execute commands/code in Daytona sandboxes with a persistent kernel. This phase builds that service following the existing domain pattern.

## Files to Create

- `backend/internal/domain/sandbox/interfaces.go` — Service interface
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
type Service interface {
    EnsureRunning(ctx context.Context, projectID uuid.UUID) (*SandboxInfo, error)
    Stop(ctx context.Context, projectID uuid.UUID) error
    ExecBash(ctx context.Context, projectID uuid.UUID, cmd string, onOutput func(stream string, text string)) (*ExecResult, error)
    ExecInKernel(ctx context.Context, projectID uuid.UUID, code string, onOutput func(stream string, text string)) (*ExecResult, error)
    WriteFile(ctx context.Context, projectID uuid.UUID, path string, content []byte) error
    ReadFile(ctx context.Context, projectID uuid.UUID, path string) ([]byte, error)
    HydrateDatasets(ctx context.Context, projectID uuid.UUID, datasetIDs []uuid.UUID) error
    GetSandboxState(ctx context.Context, projectID uuid.UUID) (SandboxState, error)
}
```

Key difference from previous: `ExecInKernel` replaces `ExecSync`/`ExecStream`. Two execution paths: bash commands (direct shell) and kernel execution (persistent Python).

## Dependencies

- Requires: Daytona Go SDK
- Independent of: All other MVP phases

## Patterns to Follow

- Domain interfaces: `backend/internal/domain/agents/interfaces.go`
- Service implementation: `backend/internal/service/agents/persona_catalog.go`
- Config struct: `backend/internal/config/` (env tags)
- Migration: `backend/migrations/AGENTS.md` for rules
- Repository: `backend/internal/repository/postgres/`
- Concurrency: `singleflight.Group` per Decision D6

## Constraints

- `ExecInKernel` must stream stdout/stderr via the `onOutput` callback, same as `ExecBash`
- Kernel startup is part of `EnsureRunning` — when sandbox starts, kernel starts too
- Kernel crash recovery: detect unresponsive kernel, restart, retry once
- Do NOT implement auto-stop worker in this phase (defer to integration)

## Verification Criteria

- [ ] `make build` passes
- [ ] Unit tests pass with mock Daytona client
- [ ] Migration applies cleanly
- [ ] SandboxConfig loads from env vars
- [ ] `ExecBash` and `ExecInKernel` have distinct code paths in tests

## Agent Staffing

- **Implementer**: `coder` (backend Go, well-defined interfaces)
- **Reviewer**: 1x reviewer (SOLID focus)
- **Verifier**: `verifier`
