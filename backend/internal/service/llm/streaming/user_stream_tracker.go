package streaming

import (
	"fmt"
	"sync"

	"meridian/internal/domain"
)

// UserStreamTracker enforces a per-user limit on concurrent streams.
// Uses sync.Mutex (not sync.Map) because Acquire requires an atomic check-and-increment.
type UserStreamTracker struct {
	mu     sync.Mutex
	counts map[string]int // userID -> active stream count
	limit  int
}

// NewUserStreamTracker creates a new tracker with the given per-user limit.
func NewUserStreamTracker(limit int) *UserStreamTracker {
	return &UserStreamTracker{
		counts: make(map[string]int),
		limit:  limit,
	}
}

// Acquire increments the stream count for a user.
// Returns a RateLimitError if the user is already at the limit.
func (t *UserStreamTracker) Acquire(userID string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.counts[userID] >= t.limit {
		return domain.NewRateLimitError(
			fmt.Sprintf("max concurrent streams (%d) reached, please wait for an existing stream to complete", t.limit),
		)
	}

	t.counts[userID]++
	return nil
}

// Release decrements the stream count for a user. Floors at 0.
func (t *UserStreamTracker) Release(userID string) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.counts[userID] > 0 {
		t.counts[userID]--
	}
	// Clean up map entry when count hits zero to prevent unbounded growth
	if t.counts[userID] == 0 {
		delete(t.counts, userID)
	}
}

// Count returns the current active stream count for a user. For debugging.
func (t *UserStreamTracker) Count(userID string) int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.counts[userID]
}
