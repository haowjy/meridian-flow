# Phase 5: Lifecycle Management

## Scope and Intent

Replace ad-hoc goroutine launching and defer-based shutdown with structured lifecycle management using `signal.NotifyContext` + `errgroup.WithContext`. All workers and the HTTP server run under one errgroup — any failure cancels everything, and shutdown is graceful.

## Files to Modify

- `backend/internal/app/run.go` — primary target: replace current run logic with RunWithGracefulShutdown
- `backend/internal/app/workers.go` — update Start/Stop to work with errgroup
- `backend/cmd/server/main.go` — minimal changes (if any)

## Current State

After Phase 4, `run.go` contains the runtime orchestration. Workers are started via `Workers.Start()` and stopped via deferred `Workers.Stop()`. The HTTP server runs `ListenAndServe` directly.

## Target: Structured Lifecycle

```go
// internal/app/run.go
func Run(cfg *config.Config, infra *Infrastructure, application *Application) error {
    ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
    defer stop()

    g, gctx := errgroup.WithContext(ctx)

    // HTTP server
    server := NewHTTPServer(cfg, application)
    g.Go(func() error {
        infra.Logger.Info("server listening", "port", cfg.Server.Port)
        if err := server.ListenAndServe(); err != http.ErrServerClosed {
            return err // unexpected error cancels group
        }
        return nil // ErrServerClosed is expected on shutdown
    })

    // Shutdown trigger: when context cancels, drain HTTP
    g.Go(func() error {
        <-gctx.Done()
        shutdownCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
        defer cancel()
        return server.Shutdown(shutdownCtx)
    })

    // Background workers all receive gctx
    if err := application.Workers.Start(g, gctx); err != nil {
        return fmt.Errorf("worker startup: %w", err)
    }

    return g.Wait()
}
```

### Workers with errgroup

```go
// internal/app/workers.go
func (w *Workers) Start(g *errgroup.Group, ctx context.Context) error {
    // Job queue
    g.Go(func() error {
        return w.jobQueue.Start(ctx)
    })

    // Compaction worker
    g.Go(func() error {
        w.compactionWorker.Start(ctx) // blocks until ctx cancels
        return nil
    })

    // Billing reconciliation ticker (every 15 min)
    g.Go(func() error {
        w.runReconciliation(ctx)
        return nil
    })

    // Credit expiration ticker (every hour)
    g.Go(func() error {
        w.runExpiration(ctx)
        return nil
    })

    return nil
}

func (w *Workers) Stop(ctx context.Context) error {
    // Stop compaction worker
    if err := w.compactionWorker.Stop(ctx); err != nil {
        w.logger.Error("compaction worker stop error", "error", err)
    }
    // Drain job queue
    if err := w.jobQueue.Stop(ctx); err != nil {
        w.logger.Error("job queue stop error", "error", err)
    }
    return nil
}
```

### Replace time.Sleep with context select

If InMemoryQueue retry uses `time.Sleep`, replace with:
```go
select {
case <-time.After(retryDelay):
    // retry
case <-ctx.Done():
    return ctx.Err() // respond to shutdown
}
```

### Ban context.Background() audit

Search for `context.Background()` in long-lived workers and replace with the errgroup context. Allowed exceptions:
- `config.Load()` / infrastructure setup (runs once at startup)
- `server.Shutdown()` context (needs to outlive the cancelled context)
- Test code

### main.go update

```go
func main() {
    _ = godotenv.Load()
    cfg := config.Load()

    infra, err := app.NewInfrastructure(cfg)
    if err != nil { ... }
    defer infra.Close()

    application, err := app.NewApplication(cfg, infra)
    if err != nil { ... }

    if err := app.Run(cfg, infra, application); err != nil {
        infra.Logger.Error("application error", "error", err)
        os.Exit(1)
    }
}
```

## Shutdown Contract

- Signal received (SIGINT/SIGTERM) → root context cancels
- HTTP server stops accepting, drains in-flight requests (30s timeout)
- All workers receive cancelled context, exit their loops
- `errgroup.Wait()` blocks until all goroutines complete
- Worker failure → cancels group → triggers HTTP shutdown
- `http.ErrServerClosed` is non-fatal (expected during shutdown)

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] `signal.NotifyContext` used (not raw signal.Notify)
- [ ] All workers under errgroup (not bare goroutines)
- [ ] No `context.Background()` in long-lived workers (except allowed exceptions)
- [ ] `http.ErrServerClosed` handled as non-fatal
- [ ] Worker failure cancels the group (triggers shutdown)
- [ ] Graceful shutdown timeout exists (30s for HTTP, workers have their own)
- [ ] No `time.Sleep` in retry paths (use select on context)
