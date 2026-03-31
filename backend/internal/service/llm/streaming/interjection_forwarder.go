package streaming

import (
	"fmt"
	"sync"

	mstream "github.com/haowjy/meridian-stream-go"
)

const maxForwardingHops = 10

type interjectionPhase uint8

const (
	phaseIdle interjectionPhase = iota
	phaseDraining
	phaseForwarded
)

type turnEntry struct {
	mu      sync.Mutex
	phase   interjectionPhase
	epoch   uint64
	target  string
	active  *mstream.InMemoryInterjectionBuffer
	pending *mstream.InMemoryInterjectionBuffer
}

// InterjectionForwarder routes interjections across stream-switch boundaries.
// It maintains per-turn state: idle -> draining -> forwarded.
type InterjectionForwarder struct {
	entries sync.Map // map[turnID]*turnEntry
}

var _ InterjectionRouter = (*InterjectionForwarder)(nil)

func NewInterjectionForwarder() *InterjectionForwarder {
	return &InterjectionForwarder{}
}

func (f *InterjectionForwarder) Register(turnID string) *mstream.InMemoryInterjectionBuffer {
	actual, _ := f.entries.LoadOrStore(turnID, &turnEntry{
		phase:   phaseIdle,
		active:  mstream.NewInMemoryInterjectionBuffer(),
		pending: mstream.NewInMemoryInterjectionBuffer(),
	})
	return actual.(*turnEntry).active
}

func (f *InterjectionForwarder) Remove(turnID string) {
	f.entries.Delete(turnID)
}

func (f *InterjectionForwarder) BeginDrain(turnID string) (uint64, string, bool) {
	entry, ok := f.getEntry(turnID)
	if !ok {
		return 0, "", false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	if entry.phase != phaseIdle {
		return 0, "", false
	}

	entry.epoch++
	entry.phase = phaseDraining
	entry.target = ""
	entry.pending.Clear()

	drained, _ := entry.active.Peek()
	return entry.epoch, drained, true
}

func (f *InterjectionForwarder) CompleteDrain(turnID string, epoch uint64, newTurnID string) (string, bool) {
	entry, ok := f.getEntry(turnID)
	if !ok {
		return "", false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	if entry.phase != phaseDraining || entry.epoch != epoch || newTurnID == "" {
		return "", false
	}

	late, _ := entry.pending.DrainAndClear()
	entry.active.Clear()
	entry.phase = phaseForwarded
	entry.target = newTurnID

	return late, true
}

func (f *InterjectionForwarder) Rollback(turnID string, epoch uint64) bool {
	entry, ok := f.getEntry(turnID)
	if !ok {
		return false
	}

	entry.mu.Lock()
	defer entry.mu.Unlock()

	if entry.phase != phaseDraining || entry.epoch != epoch {
		return false
	}

	pending, hasPending := entry.pending.DrainAndClear()
	if hasPending {
		if err := entry.active.Append(pending); err != nil {
			return false
		}
	}

	entry.phase = phaseIdle
	entry.target = ""
	return true
}

func (f *InterjectionForwarder) Route(turnID, content, mode string) (string, bool, error) {
	currentTurnID := turnID
	hops := 0

	for {
		if hops > maxForwardingHops {
			return "", false, fmt.Errorf("interjection forwarding exceeded %d hops for turn %s", maxForwardingHops, turnID)
		}

		entry, ok := f.getEntry(currentTurnID)
		if !ok {
			return "", false, fmt.Errorf("interjection forwarding target not found: %s", currentTurnID)
		}

		entry.mu.Lock()
		switch entry.phase {
		case phaseIdle:
			err := writeInterjection(entry.active, content, mode)
			entry.mu.Unlock()
			if err != nil {
				return currentTurnID, false, err
			}
			return currentTurnID, false, nil
		case phaseDraining:
			err := writeInterjection(entry.pending, content, mode)
			entry.mu.Unlock()
			if err != nil {
				return currentTurnID, true, err
			}
			return currentTurnID, true, nil
		case phaseForwarded:
			nextTurnID := entry.target
			entry.mu.Unlock()
			if nextTurnID == "" {
				return "", false, fmt.Errorf("interjection forwarding target missing for turn %s", currentTurnID)
			}
			hops++
			currentTurnID = nextTurnID
		default:
			entry.mu.Unlock()
			return "", false, fmt.Errorf("unknown interjection phase for turn %s", currentTurnID)
		}
	}
}

func (f *InterjectionForwarder) getEntry(turnID string) (*turnEntry, bool) {
	v, ok := f.entries.Load(turnID)
	if !ok {
		return nil, false
	}
	return v.(*turnEntry), true
}

func writeInterjection(buffer *mstream.InMemoryInterjectionBuffer, content, mode string) error {
	if mode == "replace" {
		return buffer.Replace(content)
	}
	return buffer.Append(content)
}
