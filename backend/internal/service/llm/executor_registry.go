package llm

import (
	"context"
	"sync"
	"time"
)

// TurnExecutorRegistry manages all active TurnExecutor instances.
//
// Design:
//   - One executor per turn (keyed by turn_id)
//   - Thread-safe access via RWMutex
//   - Background cleanup removes completed/errored/cancelled executors
//   - Singleton pattern for global access
//
// Lifecycle:
//   1. ChatService creates executor and registers it
//   2. SSE clients connect and get executor from registry
//   3. Executor completes/errors and updates status
//   4. Cleanup goroutine removes old executors after 10 minutes
type TurnExecutorRegistry struct {
	executors map[string]*TurnExecutor // turnID -> executor
	mu        sync.RWMutex

	cleanupInterval time.Duration
	retentionPeriod time.Duration // How long to keep completed executors

	// Tracking for cleanup
	completionTimes map[string]time.Time // turnID -> completion time
	timesMu         sync.RWMutex
}

// Global registry instance
var (
	globalRegistry     *TurnExecutorRegistry
	globalRegistryOnce sync.Once
)

// GetGlobalRegistry returns the singleton TurnExecutorRegistry instance.
func GetGlobalRegistry() *TurnExecutorRegistry {
	globalRegistryOnce.Do(func() {
		globalRegistry = NewTurnExecutorRegistry(
			1*time.Minute,  // Cleanup every minute
			10*time.Minute, // Keep completed executors for 10 minutes
		)
		// Start cleanup goroutine
		go globalRegistry.StartCleanup(context.Background())
	})
	return globalRegistry
}

// NewTurnExecutorRegistry creates a new TurnExecutorRegistry.
// For testing only - use GetGlobalRegistry() in production.
func NewTurnExecutorRegistry(cleanupInterval, retentionPeriod time.Duration) *TurnExecutorRegistry {
	return &TurnExecutorRegistry{
		executors:       make(map[string]*TurnExecutor),
		cleanupInterval: cleanupInterval,
		retentionPeriod: retentionPeriod,
		completionTimes: make(map[string]time.Time),
	}
}

// Register registers a new TurnExecutor for a turn.
// If an executor already exists for this turn, it returns false.
func (r *TurnExecutorRegistry) Register(turnID string, executor *TurnExecutor) bool {
	r.mu.Lock()
	defer r.mu.Unlock()

	// Check if executor already exists
	if _, exists := r.executors[turnID]; exists {
		return false
	}

	r.executors[turnID] = executor
	return true
}

// Get retrieves the TurnExecutor for a turn.
// Returns nil if no executor exists.
func (r *TurnExecutorRegistry) Get(turnID string) *TurnExecutor {
	r.mu.RLock()
	defer r.mu.RUnlock()

	return r.executors[turnID]
}

// Remove removes a TurnExecutor from the registry.
// Safe to call even if executor doesn't exist.
func (r *TurnExecutorRegistry) Remove(turnID string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.executors, turnID)

	// Also remove completion time tracking
	r.timesMu.Lock()
	delete(r.completionTimes, turnID)
	r.timesMu.Unlock()
}

// MarkCompleted marks an executor as completed (for cleanup tracking).
// Should be called when executor reaches terminal state (complete/error/cancelled).
func (r *TurnExecutorRegistry) MarkCompleted(turnID string) {
	r.timesMu.Lock()
	defer r.timesMu.Unlock()

	r.completionTimes[turnID] = time.Now()
}

// StartCleanup starts the background cleanup goroutine.
// Removes completed/errored/cancelled executors after retentionPeriod.
func (r *TurnExecutorRegistry) StartCleanup(ctx context.Context) {
	ticker := time.NewTicker(r.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.cleanup()
		}
	}
}

// cleanup removes old completed executors.
func (r *TurnExecutorRegistry) cleanup() {
	now := time.Now()

	// Find executors to remove
	var toRemove []string

	r.mu.RLock()
	for turnID, executor := range r.executors {
		status := executor.GetStatus()

		// Only cleanup terminal states
		if status == "complete" || status == "error" || status == "cancelled" {
			// Check completion time
			r.timesMu.RLock()
			completionTime, exists := r.completionTimes[turnID]
			r.timesMu.RUnlock()

			if exists && now.Sub(completionTime) > r.retentionPeriod {
				toRemove = append(toRemove, turnID)
			} else if !exists {
				// No completion time tracked, mark it now
				r.MarkCompleted(turnID)
			}
		}
	}
	r.mu.RUnlock()

	// Remove old executors
	if len(toRemove) > 0 {
		r.mu.Lock()
		for _, turnID := range toRemove {
			delete(r.executors, turnID)
		}
		r.mu.Unlock()

		// Remove completion times
		r.timesMu.Lock()
		for _, turnID := range toRemove {
			delete(r.completionTimes, turnID)
		}
		r.timesMu.Unlock()
	}
}

// Count returns the number of active executors.
// Useful for monitoring and testing.
func (r *TurnExecutorRegistry) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()

	return len(r.executors)
}

// GetAll returns all turn IDs with active executors.
// Useful for debugging and monitoring.
func (r *TurnExecutorRegistry) GetAll() []string {
	r.mu.RLock()
	defer r.mu.RUnlock()

	turnIDs := make([]string, 0, len(r.executors))
	for turnID := range r.executors {
		turnIDs = append(turnIDs, turnID)
	}

	return turnIDs
}
