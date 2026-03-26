package streaming

// shutdown.go — ShutdownCoordinator for graceful shutdown of active streams.
//
// On SIGTERM the coordinator:
//  1. Stops accepting new turns (via atomic flag)
//  2. Waits for active streams to finish (up to gracePeriod, default 30s)
//  3. Cancels any remaining streams that haven't completed
//
// The coordinator tracks active executors via Register/Deregister, separate from
// the ExecutorRegistry (which is keyed by turnID for interruption). This coordinator
// is concerned with global lifecycle, not per-turn operations.

import (
	"context"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// DefaultShutdownGracePeriod is the maximum time to wait for active streams
// during graceful shutdown before force-cancelling.
const DefaultShutdownGracePeriod = 30 * time.Second

// ShutdownCoordinator tracks active stream executors and orchestrates graceful
// shutdown. It ensures in-flight streams have time to complete before the
// process exits.
type ShutdownCoordinator struct {
	// draining is set to 1 when shutdown begins. New turns are rejected.
	draining atomic.Int32

	// active tracks the count of in-flight executors.
	// wg.Wait() blocks until all active executors have deregistered.
	wg sync.WaitGroup

	// cancelFuncs stores cancel functions for active executors, keyed by turnID.
	// Protected by mu. Used for force-cancellation after grace period.
	mu          sync.Mutex
	cancelFuncs map[string]context.CancelFunc

	gracePeriod time.Duration
	logger      *slog.Logger
}

// NewShutdownCoordinator creates a new coordinator with the given grace period.
// If gracePeriod is zero, DefaultShutdownGracePeriod is used.
func NewShutdownCoordinator(gracePeriod time.Duration, logger *slog.Logger) *ShutdownCoordinator {
	if gracePeriod <= 0 {
		gracePeriod = DefaultShutdownGracePeriod
	}
	return &ShutdownCoordinator{
		cancelFuncs: make(map[string]context.CancelFunc),
		gracePeriod: gracePeriod,
		logger:      logger,
	}
}

// IsDraining returns true if shutdown has been initiated and new turns should
// be rejected.
func (c *ShutdownCoordinator) IsDraining() bool {
	return c.draining.Load() != 0
}

// Register adds an active executor to the coordinator's tracking.
// Returns a context derived from the given parent that will be cancelled during
// force-shutdown. The caller MUST call Deregister when the executor completes.
func (c *ShutdownCoordinator) Register(parent context.Context, turnID string) context.Context {
	ctx, cancel := context.WithCancel(parent)

	c.mu.Lock()
	c.cancelFuncs[turnID] = cancel
	c.mu.Unlock()

	c.wg.Add(1)

	c.logger.Debug("executor registered with shutdown coordinator",
		"turn_id", turnID,
	)

	return ctx
}

// Deregister removes an executor from the coordinator's tracking.
// Must be called exactly once per Register call (typically in a defer).
func (c *ShutdownCoordinator) Deregister(turnID string) {
	c.mu.Lock()
	if cancel, ok := c.cancelFuncs[turnID]; ok {
		delete(c.cancelFuncs, turnID)
		// Don't call cancel here — the executor finished normally.
		// Just release the cancel func to avoid leaks.
		_ = cancel
	}
	c.mu.Unlock()

	c.wg.Done()

	c.logger.Debug("executor deregistered from shutdown coordinator",
		"turn_id", turnID,
	)
}

// ActiveCount returns the number of currently tracked executors.
// Primarily for observability and testing.
func (c *ShutdownCoordinator) ActiveCount() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.cancelFuncs)
}

// Shutdown initiates graceful shutdown:
//  1. Sets the draining flag (new turns rejected)
//  2. Waits up to gracePeriod for active streams to complete
//  3. Force-cancels any remaining streams
//
// This method blocks until all executors have deregistered or been cancelled.
// It should be called from the server's shutdown handler (e.g., SIGTERM handler).
func (c *ShutdownCoordinator) Shutdown() {
	c.draining.Store(1)

	activeCount := c.ActiveCount()
	c.logger.Info("graceful shutdown initiated",
		"active_streams", activeCount,
		"grace_period", c.gracePeriod,
	)

	if activeCount == 0 {
		c.logger.Info("no active streams, shutdown complete")
		return
	}

	// Wait for streams with a deadline.
	done := make(chan struct{})
	go func() {
		c.wg.Wait()
		close(done)
	}()

	select {
	case <-done:
		c.logger.Info("all active streams completed gracefully")
		return

	case <-time.After(c.gracePeriod):
		remaining := c.ActiveCount()
		c.logger.Warn("grace period expired, force-cancelling remaining streams",
			"remaining_streams", remaining,
		)
		c.forceCancel()

		// Wait a short time for cancellation to propagate.
		select {
		case <-done:
			c.logger.Info("all streams cancelled after force-cancel")
		case <-time.After(5 * time.Second):
			c.logger.Error("some streams did not respond to cancellation within 5s")
		}
	}
}

// forceCancel calls the cancel function for every still-active executor.
func (c *ShutdownCoordinator) forceCancel() {
	c.mu.Lock()
	defer c.mu.Unlock()

	for turnID, cancel := range c.cancelFuncs {
		c.logger.Warn("force-cancelling stream",
			"turn_id", turnID,
		)
		cancel()
	}
}
