package jobs

import "context"

// Job represents a unit of work that can be executed in background.
// ISP: Single method interface - minimal contract.
type Job interface {
	Execute(ctx context.Context) error
}

// JobMetadata provides job identification and tracking.
// ISP: Separate from Job (clients only need what they use).
type JobMetadata interface {
	JobID() string      // Unique ID for deduplication
	JobType() string    // For logging/monitoring
	Retryable() bool    // Whether to retry on failure
}

// JobQueue manages background job execution.
// OCP: Adding new job types doesn't modify this interface.
type JobQueue interface {
	Enqueue(job Job) error
	Start(ctx context.Context) error
	Stop(ctx context.Context) error
	Stats() QueueStats
}

// QueueStats provides metrics about the job queue state.
type QueueStats struct {
	Pending   int // Jobs waiting in queue
	Executing int // Jobs currently being processed
	Completed int // Jobs successfully completed
	Failed    int // Jobs that failed (after all retries)
}
