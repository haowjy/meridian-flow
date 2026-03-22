package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"meridian/internal/config"
	billing "meridian/internal/domain/billing"
	"meridian/internal/jobs"
	serviceCollab "meridian/internal/service/collab"

	mstream "github.com/haowjy/meridian-stream-go"
	"golang.org/x/sync/errgroup"
)

// Workers manages background workers and periodic jobs.
type Workers struct {
	cfg                *config.Config
	logger             *slog.Logger
	jobQueue           jobs.JobQueue
	compactionWorker   *serviceCollab.CompactionWorker
	streamRegistry     *mstream.Registry
	generationBillings billing.GenerationBillingStore
	creditSettler      billing.CreditSettler
	creditStore        billing.CreditStore
}

// NewWorkers wires worker dependencies from the assembled application.
func NewWorkers(cfg *config.Config, app *Application, logger *slog.Logger) *Workers {
	var streamRegistry *mstream.Registry
	if app.LLM != nil {
		streamRegistry = app.LLM.StreamRegistry
	}

	return &Workers{
		cfg:                cfg,
		logger:             logger,
		jobQueue:           app.JobQueue,
		compactionWorker:   app.Collab.CompactionWorker,
		streamRegistry:     streamRegistry,
		generationBillings: app.Billing.GenerationBillingStore,
		creditSettler:      app.Billing.CreditSettler,
		creditStore:        app.Billing.CreditStore,
	}
}

// Start registers background workers and periodic scheduling loops in the errgroup.
func (w *Workers) Start(g *errgroup.Group, ctx context.Context) error {
	if g == nil {
		return fmt.Errorf("errgroup is nil")
	}
	if ctx == nil {
		return fmt.Errorf("context is nil")
	}
	if w.jobQueue == nil {
		return fmt.Errorf("job queue not configured")
	}

	w.logger.Info("job queue started",
		"worker_pool_size", 5,
		"queue_capacity", 1000,
	)

	g.Go(func() error {
		err := w.jobQueue.Start(ctx)
		if err != nil && !errors.Is(err, context.Canceled) {
			return fmt.Errorf("job queue stopped: %w", err)
		}
		return nil
	})

	g.Go(func() error {
		w.startBillingReconcileLoop(ctx)
		return nil
	})

	g.Go(func() error {
		w.startCreditExpirationLoop(ctx)
		return nil
	})

	if w.compactionWorker != nil {
		g.Go(func() error {
			w.compactionWorker.Start(ctx)
			return nil
		})
	}

	if w.streamRegistry != nil {
		g.Go(func() error {
			w.streamRegistry.StartCleanup(ctx)
			return nil
		})
	}

	return nil
}

// Stop gracefully stops worker loops and queue processing.
func (w *Workers) Stop(ctx context.Context) error {
	var stopErr error

	if w.compactionWorker != nil {
		w.logger.Info("shutting down collab compaction worker...")
		if err := w.compactionWorker.Stop(ctx); err != nil {
			w.logger.Error("collab compaction worker shutdown error", "error", err)
			stopErr = errors.Join(stopErr, err)
		}
	}

	if w.jobQueue != nil {
		w.logger.Info("shutting down job queue...")
		if err := w.jobQueue.Stop(ctx); err != nil {
			w.logger.Error("job queue shutdown error", "error", err)
			stopErr = errors.Join(stopErr, err)
		} else {
			w.logger.Info("job queue stopped gracefully")
		}
	}

	return stopErr
}

func (w *Workers) startBillingReconcileLoop(ctx context.Context) {
	enqueue := func() {
		if err := w.jobQueue.Enqueue(jobs.NewReconcileBillingJob(w.generationBillings, w.creditSettler, w.logger)); err != nil {
			w.logger.Warn("failed to enqueue reconcile billing job", "error", err)
		}
	}

	enqueue()
	ticker := time.NewTicker(15 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			select {
			case <-ctx.Done():
				return
			default:
			}
			enqueue()
		}
	}
}

func (w *Workers) startCreditExpirationLoop(ctx context.Context) {
	enqueue := func() {
		if err := w.jobQueue.Enqueue(jobs.NewExpireCreditsJob(w.creditStore, w.logger)); err != nil {
			w.logger.Warn("failed to enqueue expire credits job", "error", err)
		}
	}

	enqueue()
	ticker := time.NewTicker(time.Hour)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			select {
			case <-ctx.Done():
				return
			default:
			}
			enqueue()
		}
	}
}
