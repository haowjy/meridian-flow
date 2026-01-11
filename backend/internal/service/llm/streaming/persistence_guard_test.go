package streaming

import (
	"errors"
	"sync"
	"testing"
)

func TestPersistenceGuard_InitiallyArmed(t *testing.T) {
	guard := NewPersistenceGuard()

	if !guard.IsArmed() {
		t.Error("guard should be armed initially")
	}
}

func TestPersistenceGuard_DisarmPreventsPeristence(t *testing.T) {
	guard := NewPersistenceGuard()

	// Disarm the guard
	guard.Disarm()

	// After disarm, should not persist
	persisted, err := guard.TryPersist(func() error {
		return nil
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if persisted {
		t.Error("should not persist after disarm")
	}
}

func TestPersistenceGuard_ArmedAllowsPersistence(t *testing.T) {
	guard := NewPersistenceGuard()

	// While armed, should persist
	called := false
	persisted, err := guard.TryPersist(func() error {
		called = true
		return nil
	})
	if err != nil {
		t.Errorf("unexpected error: %v", err)
	}
	if !persisted {
		t.Error("should persist while armed")
	}
	if !called {
		t.Error("persistence function should have been called")
	}
}

func TestPersistenceGuard_IdempotentDisarm(t *testing.T) {
	guard := NewPersistenceGuard()

	// Multiple disarms should be safe
	guard.Disarm()
	guard.Disarm()
	guard.Disarm()

	if guard.IsArmed() {
		t.Error("guard should stay disarmed")
	}
}

func TestPersistenceGuard_TryPersistPropagatesError(t *testing.T) {
	guard := NewPersistenceGuard()

	expectedErr := errors.New("persistence failed")
	persisted, err := guard.TryPersist(func() error {
		return expectedErr
	})

	if err != expectedErr {
		t.Errorf("expected error %v, got %v", expectedErr, err)
	}
	if persisted {
		t.Error("should not report persisted when error occurred")
	}
}

func TestPersistenceGuard_ConcurrentDisarmAndCheck(t *testing.T) {
	// This test verifies that disarm is immediately visible to concurrent readers.
	// Run with -race to detect data races.

	guard := NewPersistenceGuard()

	// Number of concurrent goroutines
	const numGoroutines = 100
	const numChecks = 1000

	var wg sync.WaitGroup
	disarmed := make(chan struct{})

	// Start reader goroutines that check armed state
	for i := 0; i < numGoroutines; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-disarmed // Wait for disarm signal
			// After disarm, should always see disarmed state
			for j := 0; j < numChecks; j++ {
				if guard.IsArmed() {
					t.Error("should see disarmed state after Disarm() returns")
				}
			}
		}()
	}

	// Disarm and signal readers
	guard.Disarm()
	close(disarmed)

	wg.Wait()
}

func TestPersistenceGuard_DisarmImmediatelyVisibleDuringPersist(t *testing.T) {
	// This test simulates the race condition scenario:
	// 1. Persistence callback is running
	// 2. Another goroutine calls Disarm()
	// 3. Subsequent IsArmed() calls in the callback should see disarmed

	guard := NewPersistenceGuard()

	// Channels for synchronization
	inPersist := make(chan struct{})
	disarmDone := make(chan struct{})
	checkDone := make(chan struct{})

	go func() {
		// Simulate persistence callback
		guard.TryPersist(func() error {
			// Signal that we're in the persistence callback
			close(inPersist)

			// Wait for disarm to complete
			<-disarmDone

			// Check if we can see the disarm
			// Note: In real code, this check would happen BEFORE the actual DB write
			if guard.IsArmed() {
				t.Error("should see disarmed state immediately after Disarm()")
			}
			close(checkDone)
			return nil
		})
	}()

	// Wait for persistence to start
	<-inPersist

	// Disarm from another goroutine (simulating cancel handler)
	guard.Disarm()
	close(disarmDone)

	// Wait for check to complete
	<-checkDone
}
