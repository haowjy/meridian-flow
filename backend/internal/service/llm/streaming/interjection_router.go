package streaming

import (
	mstream "github.com/haowjy/meridian-stream-go"
)

// InterjectionRouter abstracts interjection routing for both HTTP and WS paths.
// The v1 adapter wraps the existing InterjectionRegistry + InterjectionBuffer.
// Phase 2 replaces it with a forwarding implementation.
type InterjectionRouter interface {
	Route(turnID, content, mode string) (targetTurnID string, held bool, err error)
	BeginDrain(turnID string) (epoch uint64, drained string, ok bool)
	CompleteDrain(turnID string, epoch uint64, newTurnID string) (late string, ok bool)
	Rollback(turnID string, epoch uint64) bool
	Register(turnID string) *mstream.InMemoryInterjectionBuffer
	Remove(turnID string)
}

// V1InterjectionRouter preserves existing interjection behavior by delegating to
// InterjectionRegistry + InMemoryInterjectionBuffer.
type V1InterjectionRouter struct {
	registry *mstream.InterjectionRegistry
}

var _ InterjectionRouter = (*V1InterjectionRouter)(nil)

func NewV1InterjectionRouter(registry *mstream.InterjectionRegistry) *V1InterjectionRouter {
	return &V1InterjectionRouter{registry: registry}
}

func (r *V1InterjectionRouter) Route(turnID, content, mode string) (string, bool, error) {
	buffer := r.registry.GetOrCreate(turnID)

	var err error
	if mode == "replace" {
		err = buffer.Replace(content)
	} else {
		err = buffer.Append(content)
	}
	if err != nil {
		return turnID, false, err
	}

	return turnID, false, nil
}

func (r *V1InterjectionRouter) BeginDrain(turnID string) (uint64, string, bool) {
	buffer, exists := r.registry.Get(turnID)
	if !exists {
		return 0, "", false
	}
	drained, ok := buffer.DrainAndClear()
	return 0, drained, ok
}

func (r *V1InterjectionRouter) CompleteDrain(_ string, _ uint64, _ string) (string, bool) {
	return "", true
}

func (r *V1InterjectionRouter) Rollback(_ string, _ uint64) bool {
	return true
}

func (r *V1InterjectionRouter) Register(turnID string) *mstream.InMemoryInterjectionBuffer {
	return r.registry.GetOrCreate(turnID)
}

func (r *V1InterjectionRouter) Remove(turnID string) {
	r.registry.Remove(turnID)
}
