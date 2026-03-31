package streaming

import (
	"fmt"
	"strings"
	"testing"
)

func TestInterjectionForwarderRouteIdleWritesToActive(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	buffer := forwarder.Register("turn-idle")
	buffer.Clear()

	target, held, err := forwarder.Route("turn-idle", "hello", "append")
	if err != nil {
		t.Fatalf("Route() error = %v", err)
	}
	if target != "turn-idle" {
		t.Fatalf("target turn = %q, want %q", target, "turn-idle")
	}
	if held {
		t.Fatalf("held = true, want false")
	}

	got, ok := buffer.Peek()
	if !ok {
		t.Fatalf("buffer.Peek() ok = false, want true")
	}
	if got != "hello" {
		t.Fatalf("buffer content = %q, want %q", got, "hello")
	}
}

func TestInterjectionForwarderRouteDrainingWritesToPending(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	active := forwarder.Register("turn-draining")
	active.Clear()
	forwarder.Register("turn-successor")

	epoch, drained, ok := forwarder.BeginDrain("turn-draining")
	if !ok {
		t.Fatalf("BeginDrain() ok = false, want true")
	}
	if drained != "" {
		t.Fatalf("drained = %q, want empty", drained)
	}

	target, held, err := forwarder.Route("turn-draining", "late", "append")
	if err != nil {
		t.Fatalf("Route() error = %v", err)
	}
	if target != "turn-draining" {
		t.Fatalf("target turn = %q, want %q", target, "turn-draining")
	}
	if !held {
		t.Fatalf("held = false, want true")
	}

	if got, ok := active.Peek(); ok || got != "" {
		t.Fatalf("active buffer = (%q,%v), want empty", got, ok)
	}

	late, completeOK := forwarder.CompleteDrain("turn-draining", epoch, "turn-successor")
	if !completeOK {
		t.Fatalf("CompleteDrain() ok = false, want true")
	}
	if late != "late" {
		t.Fatalf("late content = %q, want %q", late, "late")
	}
}

func TestInterjectionForwarderRouteForwardedFollowsSuccessor(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	forwarder.Register("turn-old")
	successor := forwarder.Register("turn-new")
	successor.Clear()

	epoch, _, ok := forwarder.BeginDrain("turn-old")
	if !ok {
		t.Fatalf("BeginDrain() ok = false, want true")
	}
	if _, ok := forwarder.CompleteDrain("turn-old", epoch, "turn-new"); !ok {
		t.Fatalf("CompleteDrain() ok = false, want true")
	}

	target, held, err := forwarder.Route("turn-old", "forward-me", "append")
	if err != nil {
		t.Fatalf("Route() error = %v", err)
	}
	if target != "turn-new" {
		t.Fatalf("target turn = %q, want %q", target, "turn-new")
	}
	if held {
		t.Fatalf("held = true, want false")
	}

	got, ok := successor.Peek()
	if !ok {
		t.Fatalf("successor.Peek() ok = false, want true")
	}
	if got != "forward-me" {
		t.Fatalf("successor content = %q, want %q", got, "forward-me")
	}
}

func TestInterjectionForwarderBeginCompleteCapturesLateInterjections(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	oldBuffer := forwarder.Register("turn-late-old")
	oldBuffer.Clear()
	newBuffer := forwarder.Register("turn-late-new")
	newBuffer.Clear()

	if _, _, err := forwarder.Route("turn-late-old", "first", "append"); err != nil {
		t.Fatalf("Route(first) error = %v", err)
	}

	epoch, drained, ok := forwarder.BeginDrain("turn-late-old")
	if !ok {
		t.Fatalf("BeginDrain() ok = false, want true")
	}
	if drained != "first" {
		t.Fatalf("drained = %q, want %q", drained, "first")
	}

	if _, held, err := forwarder.Route("turn-late-old", "late-1", "append"); err != nil {
		t.Fatalf("Route(late-1) error = %v", err)
	} else if !held {
		t.Fatalf("held for late-1 = false, want true")
	}
	if _, held, err := forwarder.Route("turn-late-old", "late-2", "append"); err != nil {
		t.Fatalf("Route(late-2) error = %v", err)
	} else if !held {
		t.Fatalf("held for late-2 = false, want true")
	}

	late, ok := forwarder.CompleteDrain("turn-late-old", epoch, "turn-late-new")
	if !ok {
		t.Fatalf("CompleteDrain() ok = false, want true")
	}
	if late != "late-1\nlate-2" {
		t.Fatalf("late = %q, want %q", late, "late-1\\nlate-2")
	}

	if _, _, err := forwarder.Route("turn-late-new", late, "append"); err != nil {
		t.Fatalf("Route(forward late) error = %v", err)
	}

	got, ok := newBuffer.Peek()
	if !ok {
		t.Fatalf("newBuffer.Peek() ok = false, want true")
	}
	if got != "late-1\nlate-2" {
		t.Fatalf("new buffer content = %q, want %q", got, "late-1\\nlate-2")
	}
}

func TestInterjectionForwarderBeginRollbackMergesPendingBack(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	buffer := forwarder.Register("turn-rollback")
	buffer.Clear()

	if _, _, err := forwarder.Route("turn-rollback", "first", "append"); err != nil {
		t.Fatalf("Route(first) error = %v", err)
	}

	epoch, drained, ok := forwarder.BeginDrain("turn-rollback")
	if !ok {
		t.Fatalf("BeginDrain() ok = false, want true")
	}
	if drained != "first" {
		t.Fatalf("drained = %q, want %q", drained, "first")
	}

	if _, held, err := forwarder.Route("turn-rollback", "late", "append"); err != nil {
		t.Fatalf("Route(late) error = %v", err)
	} else if !held {
		t.Fatalf("held for late = false, want true")
	}

	if ok := forwarder.Rollback("turn-rollback", epoch); !ok {
		t.Fatalf("Rollback() ok = false, want true")
	}

	got, ok := buffer.Peek()
	if !ok {
		t.Fatalf("buffer.Peek() ok = false, want true")
	}
	if got != "first\nlate" {
		t.Fatalf("buffer content = %q, want %q", got, "first\\nlate")
	}
}

func TestInterjectionForwarderEpochFencingRejectsStaleComplete(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	forwarder.Register("turn-epoch")
	forwarder.Register("turn-next")

	epoch1, _, ok := forwarder.BeginDrain("turn-epoch")
	if !ok {
		t.Fatalf("first BeginDrain() ok = false, want true")
	}
	if ok := forwarder.Rollback("turn-epoch", epoch1); !ok {
		t.Fatalf("Rollback(epoch1) ok = false, want true")
	}

	epoch2, _, ok := forwarder.BeginDrain("turn-epoch")
	if !ok {
		t.Fatalf("second BeginDrain() ok = false, want true")
	}

	if _, ok := forwarder.CompleteDrain("turn-epoch", epoch1, "turn-next"); ok {
		t.Fatalf("CompleteDrain(stale epoch) ok = true, want false")
	}

	if _, ok := forwarder.CompleteDrain("turn-epoch", epoch2, "turn-next"); !ok {
		t.Fatalf("CompleteDrain(current epoch) ok = false, want true")
	}
}

func TestInterjectionForwarderForwardingChainLimit(t *testing.T) {
	t.Parallel()

	forwarder := NewInterjectionForwarder()
	for i := 0; i <= maxForwardingHops+1; i++ {
		forwarder.Register(chainTurnID(i))
	}

	for i := 0; i <= maxForwardingHops; i++ {
		turnID := chainTurnID(i)
		nextTurnID := chainTurnID(i + 1)

		epoch, _, ok := forwarder.BeginDrain(turnID)
		if !ok {
			t.Fatalf("BeginDrain(%s) ok = false, want true", turnID)
		}
		if _, ok := forwarder.CompleteDrain(turnID, epoch, nextTurnID); !ok {
			t.Fatalf("CompleteDrain(%s) ok = false, want true", turnID)
		}
	}

	_, _, err := forwarder.Route(chainTurnID(0), "too-deep", "append")
	if err == nil {
		t.Fatalf("Route() error = nil, want forwarding depth error")
	}
	if !strings.Contains(err.Error(), "exceeded") {
		t.Fatalf("Route() error = %q, want depth limit error", err.Error())
	}
}

func chainTurnID(i int) string {
	return fmt.Sprintf("turn-chain-%d", i)
}
