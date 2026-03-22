package app

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"meridian/internal/config"
	billing "meridian/internal/domain/billing"
	"meridian/internal/jobs"
	serviceCollab "meridian/internal/service/collab"
)

// Workers manages background workers and periodic jobs.
type Workers struct {
	cfg                *config.Config
	logger             *slog.Logger
	jobQueue           jobs.JobQueue
	compactionWorker   *serviceCollab.CompactionWorker
	generationBillings billing.GenerationBillingStore
	creditSettler      billing.CreditSettler
	creditStore        billing.CreditStore
	queueCtx           context.Context
	queueCancel        context.CancelFunc
}

// NewWorkers wires worker dependencies from the assembled application.
func NewWorkers(cfg *config.Config, app *Application, logger *slog.Logger) *Workers {
	return &Workers{
		cfg:                cfg,
		logger:             logger,
		jobQueue:           app.JobQueue,
		compactionWorker:   app.Collab.CompactionWorker,
		generationBillings: app.Billing.GenerationBillingStore,
		creditSettler:      app.Billing.CreditSettler,
		creditStore:        app.Billing.CreditStore,
	}
}

// Start begins background workers and periodic scheduling loops.
func (w *Workers) Start(ctx context.Context) error {
	if w.jobQueue == nil {
		return fmt.Errorf("job queue not configured")
	}

	w.queueCtx, w.queueCancel = context.WithCancel(ctx)
	go func() {
		if err := w.jobQueue.Start(w.queueCtx); err != nil {
			w.logger.Error("job queue stopped", "error", err)
		}
	}()

	w.logger.Info("job queue started",
		"worker_pool_size", 5,
		"queue_capacity", 1000,
	)

	go w.startBillingReconcileLoop()
	go w.startCreditExpirationLoop()

	if w.compactionWorker != nil {
		go w.compactionWorker.Start(w.queueCtx)
	}

	return nil
}

// Stop gracefully stops worker loops and queue processing.
func (w *Workers) Stop(ctx context.Context) error {
	if w.queueCancel != nil {
		w.queueCancel()
	}

	if w.compactionWorker != nil {
		w.logger.Info("shutting down collab compaction worker...")
		if err := w.compactionWorker.Stop(ctx); err != nil {
			w.logger.Error("collab compaction worker shutdown error", "error", err)
		}
	}

	if w.jobQueue != nil {
		w.logger.Info("shutting down job queue...")
		if err := w.jobQueue.Stop(ctx); err != nil {
			w.logger.Error("job queue shutdown error", "error", err)
			return err
		}
		w.logger.Info("job queue stopped gracefully")
	}

	return nil
}

func (w *Workers) startBillingReconcileLoop() {
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
		case <-w.queueCtx.Done():
			return
		case <-ticker.C:
			enqueue()
		}
	}
}

func (w *Workers) startCreditExpirationLoop() {
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
		case <-w.queueCtx.Done():
			return
		case <-ticker.C:
			enqueue()
		}
	}
}
