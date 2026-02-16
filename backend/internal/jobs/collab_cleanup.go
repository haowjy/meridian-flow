package jobs

import (
	"context"
	"log/slog"
	"time"

	collabSvc "meridian/internal/domain/services/collab"
)

// CollabCleanup runs periodic cleanup of expired auto snapshots.
type CollabCleanup struct {
	store    collabSvc.DocumentStore
	ttlHours int
	interval time.Duration
	logger   *slog.Logger
	stop     chan struct{}
	done     chan struct{}
}

// NewCollabCleanup creates a new collab cleanup goroutine manager.
func NewCollabCleanup(
	store collabSvc.DocumentStore,
	ttlHours int,
	intervalMinutes int,
	logger *slog.Logger,
) *CollabCleanup {
	if ttlHours <= 0 {
		ttlHours = 168 // 7 days default
	}
	if intervalMinutes <= 0 {
		intervalMinutes = 60 // 1 hour default
	}

	return &CollabCleanup{
		store:    store,
		ttlHours: ttlHours,
		interval: time.Duration(intervalMinutes) * time.Minute,
		logger:   logger,
		stop:     make(chan struct{}),
		done:     make(chan struct{}),
	}
}

// Start begins the periodic cleanup ticker. Blocks until Stop is called.
func (c *CollabCleanup) Start(ctx context.Context) {
	defer close(c.done)

	ticker := time.NewTicker(c.interval)
	defer ticker.Stop()

	c.logger.Info("collab cleanup started",
		"auto_snapshot_ttl_hours", c.ttlHours,
		"cleanup_interval", c.interval.String(),
	)

	// Run once on startup to clean any backlog
	c.runCleanup(ctx)

	for {
		select {
		case <-c.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			c.runCleanup(ctx)
		}
	}
}

// Stop signals the cleanup goroutine to stop and waits for it to finish.
func (c *CollabCleanup) Stop(ctx context.Context) error {
	close(c.stop)

	select {
	case <-c.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (c *CollabCleanup) runCleanup(ctx context.Context) {
	cleanupCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	deleted, err := c.store.DeleteExpiredAutoSnapshots(cleanupCtx, c.ttlHours)
	if err != nil {
		c.logger.Error("collab auto snapshot cleanup failed", "error", err)
		return
	}

	if deleted > 0 {
		c.logger.Info("collab auto snapshot cleanup completed",
			"deleted", deleted,
			"ttl_hours", c.ttlHours,
		)
	}
}
