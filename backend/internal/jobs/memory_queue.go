package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"
)

// InMemoryQueue implements JobQueue interface with a worker pool architecture.
// Features:
// - Bounded channel for backpressure
// - Worker pool for concurrent job execution
// - Deduplication via sync.Map (atomic LoadOrStore)
// - Exponential backoff retry (managed by jobs via Retryable())
// - Graceful shutdown with timeout
// - Thread-safe stats tracking
type InMemoryQueue struct {
	jobCh      chan Job
	workerPool int
	logger     *slog.Logger

	inFlight sync.Map // jobID -> bool (deduplication)
	statsMu  sync.Mutex
	stats    QueueStats
	wg       sync.WaitGroup
	stopOnce sync.Once
	ctx      context.Context
	cancel   context.CancelFunc
}

// NewInMemoryQueue creates a new in-memory job queue.
// workerPool: number of concurrent workers (default: 5)
// capacity: bounded channel capacity for backpressure (default: 1000)
func NewInMemoryQueue(workerPool int, capacity int, logger *slog.Logger) *InMemoryQueue {
	if workerPool <= 0 {
		workerPool = 5
	}
	if capacity <= 0 {
		capacity = 1000
	}
	if logger == nil {
		logger = slog.Default()
	}

	return &InMemoryQueue{
		jobCh:      make(chan Job, capacity),
		workerPool: workerPool,
		logger:     logger,
		stats:      QueueStats{},
	}
}

// Enqueue adds a job to the queue with deduplication.
// Returns error if queue is full or job is duplicate (already in-flight).
func (q *InMemoryQueue) Enqueue(job Job) error {
	// Extract job ID for deduplication
	var jobID string
	if meta, ok := job.(JobMetadata); ok {
		jobID = meta.JobID()

		// Atomic deduplication check
		_, loaded := q.inFlight.LoadOrStore(jobID, true)
		if loaded {
			q.logger.Debug("job already in queue, skipping duplicate",
				"job_id", jobID,
				"job_type", meta.JobType(),
			)
			return nil // Not an error - just skip duplicate
		}
	}

	if q.ctx != nil {
		select {
		case <-q.ctx.Done():
			if jobID != "" {
				q.inFlight.Delete(jobID)
			}
			return fmt.Errorf("job queue stopped")
		default:
		}
	}

	// Non-blocking send (bounded channel)
	select {
	case q.jobCh <- job:
		q.statsMu.Lock()
		q.stats.Pending++
		q.statsMu.Unlock()

		if jobID != "" {
			q.logger.Debug("job enqueued",
				"job_id", jobID,
				"pending", q.stats.Pending,
			)
		}
		return nil
	default:
		// Queue full - apply backpressure
		if jobID != "" {
			q.inFlight.Delete(jobID)
		}
		return fmt.Errorf("job queue full (capacity: %d)", cap(q.jobCh))
	}
}

// Start spawns worker goroutines and begins processing jobs.
func (q *InMemoryQueue) Start(ctx context.Context) error {
	q.ctx, q.cancel = context.WithCancel(ctx)

	q.logger.Info("starting job queue",
		"worker_pool_size", q.workerPool,
		"queue_capacity", cap(q.jobCh),
	)

	// Spawn workers
	for i := 0; i < q.workerPool; i++ {
		q.wg.Add(1)
		go q.worker(q.ctx, i)
	}

	// Block until context cancelled
	<-q.ctx.Done()
	q.logger.Debug("job queue context cancelled, waiting for workers to finish")
	q.wg.Wait()

	return q.ctx.Err()
}

// Stop gracefully shuts down the queue.
// Waits for in-flight jobs to complete with timeout.
func (q *InMemoryQueue) Stop(ctx context.Context) error {
	var stopErr error

	q.stopOnce.Do(func() {
		q.logger.Info("stopping job queue", "pending", len(q.jobCh))

		// Cancel context to signal workers.
		// Keep channel open so racing producers don't panic on send.
		if q.cancel != nil {
			q.cancel()
		}

		// Wait for workers to finish with timeout
		done := make(chan struct{})
		go func() {
			q.wg.Wait()
			close(done)
		}()

		select {
		case <-done:
			q.logger.Info("job queue stopped gracefully")
		case <-ctx.Done():
			q.logger.Warn("job queue stop timeout exceeded",
				"timeout", ctx.Err(),
			)
			stopErr = ctx.Err()
		}
	})

	return stopErr
}

// Stats returns current queue statistics.
func (q *InMemoryQueue) Stats() QueueStats {
	q.statsMu.Lock()
	defer q.statsMu.Unlock()
	return q.stats
}

// worker is the main worker loop.
// Processes jobs from the channel until context is cancelled.
func (q *InMemoryQueue) worker(ctx context.Context, workerID int) {
	defer q.wg.Done()

	q.logger.Debug("worker started", "worker_id", workerID)

	for {
		select {
		case <-ctx.Done():
			q.logger.Debug("worker stopped", "worker_id", workerID)
			return
		case job := <-q.jobCh:
			// Decrement pending count
			q.statsMu.Lock()
			q.stats.Pending--
			q.stats.Executing++
			q.statsMu.Unlock()

			// Execute job
			q.executeJob(ctx, job, workerID)

			// Decrement executing count
			q.statsMu.Lock()
			q.stats.Executing--
			q.statsMu.Unlock()
		}
	}
}

// executeJob executes a single job with timeout and retry logic.
func (q *InMemoryQueue) executeJob(ctx context.Context, job Job, workerID int) {
	var jobID, jobType string

	// Extract metadata for logging (but NOT retryable yet)
	if meta, ok := job.(JobMetadata); ok {
		jobID = meta.JobID()
		jobType = meta.JobType()
	}

	// Execute with 30-second timeout per attempt
	execCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	startTime := time.Now()
	err := job.Execute(execCtx)
	duration := time.Since(startTime)

	q.statsMu.Lock()
	if err != nil {
		q.stats.Failed++
		q.logger.Error("job failed",
			"job_id", jobID,
			"job_type", jobType,
			"error", err,
			"duration_ms", duration.Milliseconds(),
			"worker_id", workerID,
		)

		// Check Retryable() AFTER execution (uses updated job state)
		var shouldRetry bool
		if meta, ok := job.(JobMetadata); ok {
			shouldRetry = meta.Retryable()
		}

		// Retry if retryable (re-enqueue with exponential backoff)
		if shouldRetry {
			q.logger.Info("retrying job",
				"job_id", jobID,
				"job_type", jobType,
			)
			q.statsMu.Unlock()

			// Base delay between retries; shutdown should interrupt this wait.
			select {
			case <-time.After(100 * time.Millisecond):
			case <-ctx.Done():
				if jobID != "" {
					q.inFlight.Delete(jobID)
				}
				return
			}

			// Clean up inFlight entry BEFORE re-enqueue (allow retry to pass deduplication)
			if jobID != "" {
				q.inFlight.Delete(jobID)
			}

			// Re-enqueue for retry (best-effort)
			if err := q.Enqueue(job); err != nil {
				q.logger.Error("failed to re-enqueue job for retry",
					"job_id", jobID,
					"error", err,
				)
				// Note: inFlight already deleted above, no additional cleanup needed
			}
			return
		}
	} else {
		q.stats.Completed++
		q.logger.Debug("job completed",
			"job_id", jobID,
			"job_type", jobType,
			"duration_ms", duration.Milliseconds(),
			"worker_id", workerID,
		)
	}
	q.statsMu.Unlock()

	// Clean up deduplication map (job finished or non-retryable failure)
	if jobID != "" {
		q.inFlight.Delete(jobID)
	}
}
