package streaming

import (
	"sync/atomic"
)

// PersistenceGuard gates block persistence atomically.
// It provides a single source of truth for "should we persist?"
//
// This prevents the race condition where:
// 1. Cancel is requested (queued as command)
// 2. But streaming goroutine is mid-PersistAndClear callback
// 3. State check passes (command not yet processed)
// 4. Block gets persisted despite cancel intent
//
// With PersistenceGuard:
// 1. Cancel handler calls Disarm() IMMEDIATELY (atomic store)
// 2. PersistAndClear callback checks IsArmed() (atomic load)
// 3. No race: disarm is visible immediately across goroutines
type PersistenceGuard struct {
	// armed: true = blocks can be persisted, false = all persistence should be skipped
	armed atomic.Bool
}

// NewPersistenceGuard creates an armed guard (persistence allowed).
func NewPersistenceGuard() *PersistenceGuard {
	pg := &PersistenceGuard{}
	pg.armed.Store(true)
	return pg
}

// Disarm prevents any future persistence.
// Called by RequestSoftCancel/RequestHardCancel BEFORE queuing command.
// Safe to call multiple times (idempotent).
//
// Thread-safety: Uses atomic store, immediately visible to all goroutines.
func (pg *PersistenceGuard) Disarm() {
	pg.armed.Store(false)
}

// IsArmed returns true if persistence is still allowed.
// Used inside PersistAndClear callback for final check.
//
// Thread-safety: Uses atomic load, sees disarm immediately.
func (pg *PersistenceGuard) IsArmed() bool {
	return pg.armed.Load()
}

// TryPersist attempts to persist if guard is armed.
// Returns (persisted bool, error).
//
// This is a convenience method that encapsulates the check-then-act pattern.
// For cases where you need custom logic, use IsArmed() directly.
func (pg *PersistenceGuard) TryPersist(fn func() error) (bool, error) {
	// Atomic check: if not armed, skip entirely
	if !pg.armed.Load() {
		return false, nil
	}
	// Execute persistence
	if err := fn(); err != nil {
		return false, err
	}
	return true, nil
}
