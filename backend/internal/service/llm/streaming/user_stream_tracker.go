package streaming

import (
	"fmt"
	"sync"

	"meridian/internal/domain"
)

// UserStreamTracker enforces per-user limits on concurrent streams.
// Free users get freeLimit, paid users (purchased_balance > 0) get paidLimit.
// Uses sync.Mutex (not sync.Map) because Acquire requires an atomic check-and-increment.
type UserStreamTracker struct {
	mu        sync.Mutex
	counts    map[string]int // userID -> active stream count
	freeLimit int
	paidLimit int
}

// NewUserStreamTracker creates a new tracker with free/paid limits.
func NewUserStreamTracker(freeLimit, paidLimit int) *UserStreamTracker {
	return &UserStreamTracker{
		counts:    make(map[string]int),
		freeLimit: freeLimit,
		paidLimit: paidLimit,
	}
}

// Acquire increments the stream count for a user.
// hasPurchasedCredits determines whether the user gets the paid (higher) limit.
// Returns a RateLimitError if the user is already at their limit.
func (t *UserStreamTracker) Acquire(userID string, hasPurchasedCredits bool) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	limit := t.freeLimit
	if hasPurchasedCredits {
		limit = t.paidLimit
	}

	if t.counts[userID] >= limit {
		return domain.NewRateLimitError(
			fmt.Sprintf("max concurrent streams (%d) reached, please wait for an existing stream to complete", limit),
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
