# Daytona Sandbox Service

Manages persistent per-project sandboxes for code execution, including a persistent Jupyter kernel for Python variable persistence. See [overview](../overview.md) for system context.

**Revised from previous design**: Added `ExecInKernel` for persistent Python execution and `KernelManager` for kernel lifecycle. The `ExecSync`/`ExecStream` methods are renamed to `ExecBash` for clarity. The sandbox now starts a Jupyter kernel on boot.

## Interface

```go
// backend/internal/domain/sandbox/interfaces.go

type Service interface {
    // EnsureRunning starts the sandbox + kernel for a project if not already running.
    // Returns sandbox connection info. Idempotent — safe to call repeatedly.
    EnsureRunning(ctx context.Context, projectID uuid.UUID) (*SandboxInfo, error)

    // Stop stops the sandbox for a project. Retains disk state.
    Stop(ctx context.Context, projectID uuid.UUID) error

    // ExecBash runs a shell command in the sandbox.
    // For file operations, package installs, non-Python commands.
    // onOutput called for each stdout/stderr line. Pass nil to ignore.
    ExecBash(ctx context.Context, projectID uuid.UUID, cmd string, onOutput func(stream string, text string)) (*ExecResult, error)

    // ExecInKernel sends Python code to the persistent Jupyter kernel.
    // Variables and imports survive between calls.
    // onOutput called for each stdout/stderr line.
    ExecInKernel(ctx context.Context, projectID uuid.UUID, code string, onOutput func(stream string, text string)) (*ExecResult, error)

    // WriteFile writes content to a path in the sandbox.
    WriteFile(ctx context.Context, projectID uuid.UUID, path string, content []byte) error

    // ReadFile reads a file from the sandbox.
    ReadFile(ctx context.Context, projectID uuid.UUID, path string) ([]byte, error)

    // HydrateDatasets pulls dataset files from Supabase Storage into the sandbox.
    HydrateDatasets(ctx context.Context, projectID uuid.UUID, datasetIDs []uuid.UUID) error

    // GetSandboxState returns the current lifecycle state.
    GetSandboxState(ctx context.Context, projectID uuid.UUID) (SandboxState, error)
}
```

## Types

```go
// backend/internal/domain/sandbox/types.go

type SandboxInfo struct {
    SandboxID string
    State     SandboxState
    ProjectID uuid.UUID
    KernelReady bool  // Whether the Jupyter kernel is responsive
}

type SandboxState string

const (
    SandboxStateCold     SandboxState = "cold"
    SandboxStateStarting SandboxState = "starting"
    SandboxStateRunning  SandboxState = "running"
    SandboxStateStopped  SandboxState = "stopped"
    SandboxStateError    SandboxState = "error"
)

type ExecResult struct {
    ExitCode int
    Stdout   string
    Stderr   string
}
```

## Sandbox Lifecycle

```mermaid
statechart-v2
    [*] --> Cold
    Cold --> Starting: EnsureRunning()
    Starting --> Running: Daytona ready + kernel started
    Starting --> Error: Boot failed
    Running --> Running: ExecBash/ExecInKernel
    Running --> Stopped: Auto-stop (15min idle)
    Running --> Stopped: Stop()
    Stopped --> Starting: EnsureRunning()
    Error --> Starting: EnsureRunning() retry
```

One sandbox per project. Mapping stored in `project_sandboxes` table:

```sql
CREATE TABLE ${TABLE_PREFIX}project_sandboxes (
    project_id   UUID PRIMARY KEY REFERENCES ${TABLE_PREFIX}projects(id),
    sandbox_id   TEXT NOT NULL,
    state        TEXT NOT NULL DEFAULT 'cold',
    snapshot_id  TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Implementation

```go
// backend/internal/service/sandbox/daytona.go

type DaytonaSandboxService struct {
    client     *daytona.Client
    repo       SandboxRepository
    storageSvc storage.Service
    snapshotID string
    sf         singleflight.Group  // Deduplicates concurrent EnsureRunning per project
    logger     *slog.Logger
}
```

### Persistent Jupyter Kernel

The sandbox snapshot includes a pre-configured Jupyter kernel. On `EnsureRunning()`:

1. Start sandbox from snapshot (if not running)
2. Start Jupyter kernel gateway if not already running:
   ```bash
   jupyter kernelgateway --ip=0.0.0.0 --port=8888 --KernelGatewayApp.api='kernel_gateway.notebook_http' 2>/dev/null &
   ```
3. Wait for kernel to be responsive (health check)
4. Store kernel connection info

The kernel gateway provides a REST API for executing code:
- `POST /api/kernels` — start a kernel
- `POST /api/kernels/{id}/execute` — execute code (with streaming via WebSocket)

```go
// ExecInKernel sends code to the persistent kernel via the kernel gateway API
func (s *DaytonaSandboxService) ExecInKernel(ctx context.Context, projectID uuid.UUID, code string, onOutput func(string, string)) (*ExecResult, error) {
    info, err := s.EnsureRunning(ctx, projectID)
    if err != nil { return nil, err }
    
    // Connect to kernel gateway WebSocket for streaming output
    // Send execute_request message
    // Stream stdout/stderr via onOutput callback
    // Collect final result
    
    s.updateLastUsed(ctx, projectID)
    return result, nil
}
```

**Kernel recovery**: If the kernel becomes unresponsive (OOM, crash), `ExecInKernel` detects the failure, restarts the kernel, and retries once. The caller gets an error only if the retry also fails. Variables from the crashed kernel are lost — the AI must re-import modules and re-run setup code.

### ExecBash

Regular shell commands bypass the kernel entirely:

```go
func (s *DaytonaSandboxService) ExecBash(ctx context.Context, projectID uuid.UUID, cmd string, onOutput func(string, string)) (*ExecResult, error) {
    info, err := s.EnsureRunning(ctx, projectID)
    if err != nil { return nil, err }
    
    // Use Daytona exec API for shell command
    // Stream stdout/stderr via onOutput callback
    
    s.updateLastUsed(ctx, projectID)
    return result, nil
}
```

### Snapshot Strategy

Pre-built Daytona snapshot contains:
- Ubuntu 22.04
- Python 3.11
- Jupyter kernel gateway (`jupyter_kernel_gateway`)
- Pre-installed packages: `numpy scipy pandas SimpleITK pydicom scikit-image trimesh plotly matplotlib jupyter_client ipykernel`
- The `result_helper.py` module at `/workspace/.meridian/`
- Network egress allowlist: only Supabase Storage URL
- Env scrubbed: only `PYTHONUNBUFFERED=1`, `SUPABASE_STORAGE_URL` set

Sandbox creation from snapshot: ~2-5 seconds. Kernel startup: ~1-2 seconds additional.

### Dataset Hydration

When the agent first accesses a dataset, the service pulls files from Supabase Storage:

```go
func (s *DaytonaSandboxService) HydrateDatasets(ctx context.Context, projectID uuid.UUID, datasetIDs []uuid.UUID) error {
    info, err := s.EnsureRunning(ctx, projectID)
    // For each dataset:
    //   1. List files in Supabase Storage bucket: datasets/{projectID}/{datasetID}/
    //   2. Download each file
    //   3. Write to sandbox: /workspace/datasets/{dataset_slug}/{filename}
    //   4. Write manifest: /workspace/datasets/{dataset_slug}/.manifest.json
}
```

Manifest tracks hydrated files to avoid redundant transfers:

```json
{
  "dataset_id": "uuid",
  "slug": "knee-scan-001",
  "hydrated_at": "2026-04-01T12:00:00Z",
  "files": [
    {"name": "slice_0001.dcm", "size": 524288, "hash": "sha256:..."}
  ]
}
```

### Auto-Stop Worker

Background goroutine checks for idle sandboxes every 5 minutes:

```go
func (s *DaytonaSandboxService) RunIdleChecker(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Minute)
    for {
        select {
        case <-ctx.Done(): return
        case <-ticker.C:
            // Find sandboxes where last_used_at < now - autoStopMinutes
            // Call Daytona stop API (kernel stops with sandbox)
            // Update state to "stopped" in DB
        }
    }
}
```

## Configuration

```go
// backend/internal/config/sandbox.go

type SandboxConfig struct {
    DaytonaAPIKey       string `env:"DAYTONA_API_KEY"`
    DaytonaAPIURL       string `env:"DAYTONA_API_URL" envDefault:"https://api.daytona.io"`
    SnapshotID          string `env:"DAYTONA_SNAPSHOT_ID"`
    AutoStopMinutes     int    `env:"DAYTONA_AUTO_STOP_MINUTES" envDefault:"15"`
    SandboxCPU          int    `env:"DAYTONA_SANDBOX_CPU" envDefault:"2"`
    SandboxMemoryGB     int    `env:"DAYTONA_SANDBOX_MEMORY_GB" envDefault:"4"`
    SandboxDiskGB       int    `env:"DAYTONA_SANDBOX_DISK_GB" envDefault:"10"`
    MaxExecTimeoutSecs  int    `env:"DAYTONA_MAX_EXEC_TIMEOUT" envDefault:"600"`
    KernelPort          int    `env:"DAYTONA_KERNEL_PORT" envDefault:"8888"`
}
```

## Cost Considerations

At 2 vCPU / 4 GiB:
- Running: ~$0.13/hour
- Stopped: ~$0.0001/hour (disk only)
- Auto-stop at 15 minutes keeps costs reasonable
- Expected: researcher interacts 1-2 hours, sandbox auto-stops, resumes next session
- Kernel restart on resume: ~1-2 seconds (variables lost, filesystem preserved)

## Related Docs

- [bash Tool](bash-tool.md) — uses this service for code execution
- [Dataset Domain](dataset-domain.md) — files hydrated into sandbox
- [Display Result Pipeline](display-results.md) — results stream from sandbox execution
