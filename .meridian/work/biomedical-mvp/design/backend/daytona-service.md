# Daytona Sandbox Service

Manages persistent per-project sandboxes for Python code execution. See [overview](../overview.md) for system context.

## Interface

```go
// backend/internal/domain/sandbox/interfaces.go

type Service interface {
    // EnsureRunning starts the sandbox for a project if not already running.
    // Returns sandbox connection info. Idempotent — safe to call repeatedly.
    EnsureRunning(ctx context.Context, projectID uuid.UUID) (*SandboxInfo, error)

    // Stop stops the sandbox for a project. Retains disk state.
    Stop(ctx context.Context, projectID uuid.UUID) error

    // ExecSync runs a command in the sandbox and returns stdout/stderr.
    // For short-lived commands (file writes, pip installs).
    ExecSync(ctx context.Context, projectID uuid.UUID, cmd string) (*ExecResult, error)

    // ExecStream runs a command and streams stdout/stderr via callback.
    // For long-running Python scripts. Returns final exit code.
    ExecStream(ctx context.Context, projectID uuid.UUID, cmd string, onOutput func(stream string, data string)) (*ExecResult, error)

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
}

type SandboxState string

const (
    SandboxStateCold     SandboxState = "cold"      // No sandbox exists
    SandboxStateStarting SandboxState = "starting"   // Boot in progress
    SandboxStateRunning  SandboxState = "running"    // Ready for commands
    SandboxStateStopped  SandboxState = "stopped"    // Disk retained, compute off
    SandboxStateError    SandboxState = "error"      // Failed state
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
    Starting --> Running: Daytona ready
    Starting --> Error: Boot failed
    Running --> Running: ExecSync/ExecStream
    Running --> Stopped: Auto-stop (15min idle)
    Running --> Stopped: Stop()
    Stopped --> Starting: EnsureRunning()
    Error --> Starting: EnsureRunning() retry
```

One sandbox per project. The mapping is stored in a `project_sandboxes` table:

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

## Implementation: Daytona Go SDK

```go
// backend/internal/service/sandbox/daytona.go

type DaytonaSandboxService struct {
    client     *daytona.Client   // Daytona Go SDK
    repo       SandboxRepository // DB binding
    storageSvc storage.Service   // Supabase Storage for dataset file access
    snapshotID string            // Pre-built snapshot with Python + packages
    mu         sync.Mutex        // Per-project mutex for EnsureRunning
    logger     *slog.Logger
}
```

### Snapshot Strategy

A pre-built Daytona snapshot contains:
- Ubuntu 22.04
- Python 3.11
- Pre-installed packages: `numpy scipy pandas SimpleITK pydicom scikit-image trimesh plotly matplotlib`
- The `result_helper.py` module at `/workspace/.meridian/`
- Supabase CLI tools for storage access

Sandbox creation from snapshot takes ~2-5 seconds. The snapshot ID is configured via environment variable:

```
DAYTONA_API_KEY=...
DAYTONA_API_URL=https://api.daytona.io
DAYTONA_SNAPSHOT_ID=meridian-biomedical-v1
DAYTONA_AUTO_STOP_MINUTES=15
DAYTONA_SANDBOX_CPU=2
DAYTONA_SANDBOX_MEMORY_GB=4
DAYTONA_SANDBOX_DISK_GB=10
```

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

The manifest tracks which files have been hydrated to avoid redundant transfers:

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

A background goroutine checks for idle sandboxes every 5 minutes:

```go
func (s *DaytonaSandboxService) RunIdleChecker(ctx context.Context) {
    ticker := time.NewTicker(5 * time.Minute)
    for {
        select {
        case <-ctx.Done(): return
        case <-ticker.C:
            // Find sandboxes where last_used_at < now - autoStopMinutes
            // Call Daytona stop API
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
}
```

## Cost Considerations

At 2 vCPU / 4 GiB:
- Running: ~$0.13/hour
- Stopped: ~$0.0001/hour (disk only)
- Auto-stop at 15 minutes keeps costs reasonable for bursty research workflows
- Expected usage: researcher interacts for 1-2 hours, sandbox auto-stops, resumes next session

## Related Docs

- [execute_python Tool](execute-python.md) — uses this service for code execution
- [Dataset Domain](dataset-domain.md) — files hydrated into sandbox
- [Stream Extensions](stream-extensions.md) — stdout/result streaming from sandbox
