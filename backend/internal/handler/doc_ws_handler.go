package handler

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"

	"github.com/google/uuid"

	"meridian/internal/domain"
	collab "meridian/internal/domain/collab"
	"meridian/internal/wsutil"
)

const docWSRestoredReason = "document_restored"

var _ wsutil.BinaryHandler = (*DocHandler)(nil)
var _ DocumentSyncBroadcaster = (*DocHandler)(nil)
var _ collab.DocumentPresenceTracker = (*DocHandler)(nil)

// DocHandler handles project-scoped doc websocket connections.
type DocHandler struct {
	sessionManager   collab.DocumentSessionProvider
	documentResolver collab.DocumentResolver
	logger           *slog.Logger

	docSubsMu sync.RWMutex
	docSubs   map[string][]*docSubscriber
}

type docSubscriber struct {
	session     wsutil.Session
	subId       string
	syncSession collab.SyncSession
	releaseFn   func()
	documentID  string
	epoch       string
	seq         atomic.Int64
}

type docHandlerState struct {
	session wsutil.Session

	mu          sync.RWMutex
	subsByDoc   map[string]*docSubscriber
	subsBySubId map[string]*docSubscriber
}

func NewDocHandler(
	sessionManager collab.DocumentSessionProvider,
	documentResolver collab.DocumentResolver,
	logger *slog.Logger,
) *DocHandler {
	if logger == nil {
		logger = slog.Default()
	}

	return &DocHandler{
		sessionManager:   sessionManager,
		documentResolver: documentResolver,
		logger:           logger,
		docSubs:          make(map[string][]*docSubscriber),
	}
}

func (h *DocHandler) OnConnect(session wsutil.Session) (wsutil.State, error) {
	return &docHandlerState{
		session:     session,
		subsByDoc:   make(map[string]*docSubscriber),
		subsBySubId: make(map[string]*docSubscriber),
	}, nil
}

func (h *DocHandler) OnSubscribe(rawState wsutil.State, sub wsutil.SubscribeRequest) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return err
	}

	documentUUID, err := parseUUID(sub.Resource.Id)
	if err != nil {
		return fmt.Errorf("invalid document id")
	}
	documentID := documentUUID.String()

	if oldSub := state.findByDocumentID(documentID); oldSub != nil && oldSub.subId != sub.SubId {
		state.session.EndSub(oldSub.subId)
	}

	if h.documentResolver == nil {
		return fmt.Errorf("document resolver unavailable")
	}
	allowed, err := h.documentResolver.VerifyOwnership(context.Background(), documentID, state.session.UserID())
	if err != nil {
		return fmt.Errorf("failed to verify document access")
	}
	if !allowed {
		return fmt.Errorf("access denied")
	}

	if h.sessionManager == nil {
		return fmt.Errorf("document session manager unavailable")
	}
	syncSession, releaseFn, err := h.sessionManager.GetOrCreateSession(context.Background(), documentID, state.session.UserID())
	if err != nil {
		return fmt.Errorf("failed to acquire document session")
	}

	registered := false
	defer func() {
		if !registered && releaseFn != nil {
			releaseFn()
		}
	}()

	syncStep1Payload, err := syncSession.BuildSyncStep1Payload()
	if err != nil {
		return fmt.Errorf("failed to build initial sync payload")
	}

	epoch := uuid.NewString()
	subscriber := &docSubscriber{
		session:     state.session,
		subId:       sub.SubId,
		syncSession: syncSession,
		releaseFn:   releaseFn,
		documentID:  documentID,
		epoch:       epoch,
	}

	if err := state.session.Send(wsutil.Envelope{
		Kind:     wsutil.KindControl,
		Op:       wsutil.OpSubscribed,
		SubId:    sub.SubId,
		Resource: &wsutil.Resource{Type: "document", Id: documentID},
		Epoch:    epoch,
		Payload:  wsutil.MustMarshal(map[string]any{"headSeq": 0, "recovered": false, "catchupCount": 0}),
	}); err != nil {
		return err
	}

	if err := state.session.SendBinaryToSub(sub.SubId, addDocPrefix(docWSPrefixSync, syncStep1Payload)); err != nil {
		return err
	}

	state.register(subscriber)
	h.registerDocSubscriber(subscriber)
	registered = true
	return nil
}

func (h *DocHandler) OnUnsubscribe(rawState wsutil.State, subID string) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return err
	}

	subscriber := state.removeBySubID(subID)
	if subscriber == nil {
		return nil
	}

	h.unregisterDocSubscriber(subscriber)
	if subscriber.releaseFn != nil {
		subscriber.releaseFn()
	}
	return nil
}

func (h *DocHandler) OnMessage(_ wsutil.State, _ wsutil.Envelope) error {
	return wsutil.ErrNotSupported
}

func (h *DocHandler) OnBinaryMessage(rawState wsutil.State, subId string, data []byte) error {
	state, err := h.requireState(rawState)
	if err != nil {
		return err
	}

	subscriber := state.findBySubID(subId)
	if subscriber == nil {
		return fmt.Errorf("document subscription not found")
	}

	if len(data) > docWSAppMaxFrame {
		return fmt.Errorf("%s: max %d bytes", domain.ErrFrameTooLarge.Error(), docWSAppMaxFrame)
	}
	if len(data) < 1 {
		return fmt.Errorf("invalid binary frame")
	}

	prefix := data[0]
	payload := data[1:]

	switch prefix {
	case docWSPrefixSync:
		_, responsePayload, updatePayload, err := subscriber.syncSession.HandleSyncPayload(context.Background(), payload, "human")
		if err != nil {
			return fmt.Errorf("document sync failed")
		}

		if len(responsePayload) > 0 {
			if err := subscriber.session.SendBinaryToSub(subscriber.subId, addDocPrefix(docWSPrefixSync, responsePayload)); err != nil {
				return err
			}
		}

		if len(updatePayload) > 0 {
			encodedUpdate, err := encodeSyncUpdatePayload(updatePayload)
			if err != nil {
				return fmt.Errorf("failed to encode sync update")
			}
			h.broadcastToDocSubscribers(
				subscriber.documentID,
				subscriber.subId,
				subscriber.session.ConnectionID(),
				addDocPrefix(docWSPrefixSync, encodedUpdate),
			)
		}
		return nil
	case docWSPrefixAwareness:
		h.logger.Debug("doc ws awareness frame received",
			"document_id", subscriber.documentID,
			"sub_id", subscriber.subId,
		)
		return nil
	default:
		return fmt.Errorf("unknown binary prefix")
	}
}

func (h *DocHandler) OnDisconnect(_ wsutil.State) {}

func (h *DocHandler) BroadcastYjsUpdate(documentID string, update []byte) {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		h.logger.Warn("doc ws yjs broadcast ignored invalid document id",
			"document_id", documentID,
			"error", err,
		)
		return
	}
	if len(update) == 0 {
		return
	}

	encodedUpdate, err := encodeSyncUpdatePayload(update)
	if err != nil {
		h.logger.Warn("doc ws yjs broadcast failed to encode update",
			"document_id", documentUUID.String(),
			"error", err,
		)
		return
	}

	h.broadcastToDocSubscribers(documentUUID.String(), "", "", addDocPrefix(docWSPrefixSync, encodedUpdate))
}

func (h *DocHandler) BroadcastDocumentRestored(documentID string) {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		h.logger.Warn("doc ws restored broadcast ignored invalid document id",
			"document_id", documentID,
			"error", err,
		)
		return
	}

	canonicalDocumentID := documentUUID.String()
	targets := h.snapshotDocSubscribers(canonicalDocumentID)
	for _, target := range targets {
		if target == nil {
			continue
		}

		endedSeq := target.seq.Add(1)
		err := target.session.Send(wsutil.Envelope{
			Kind:     wsutil.KindStream,
			Op:       wsutil.OpEnded,
			Resource: &wsutil.Resource{Type: "document", Id: canonicalDocumentID},
			SubId:    target.subId,
			Seq:      endedSeq,
			Epoch:    target.epoch,
			Payload:  wsutil.MustMarshal(map[string]any{"reason": docWSRestoredReason, "finalSeq": endedSeq}),
		})
		if err != nil {
			h.logger.Debug("doc ws restored broadcast failed to send ended",
				"document_id", canonicalDocumentID,
				"sub_id", target.subId,
				"error", err,
			)
		}

		target.session.EndSub(target.subId)
	}
}

func (h *DocHandler) HasActiveSubscribers(documentID string) bool {
	documentUUID, err := parseUUID(documentID)
	if err != nil {
		return false
	}

	h.docSubsMu.RLock()
	defer h.docSubsMu.RUnlock()

	return len(h.docSubs[documentUUID.String()]) > 0
}

func (h *DocHandler) broadcastToDocSubscribers(documentID string, excludeSubId string, excludeConnID string, data []byte) {
	targets := h.snapshotDocSubscribers(documentID)
	for _, target := range targets {
		if target == nil {
			continue
		}
		// Skip the sender — matched by both subId and connectionId to handle
		// the case where the same document has multiple subscribers on different
		// connections.
		if excludeSubId != "" && target.subId == excludeSubId && target.session.ConnectionID() == excludeConnID {
			continue
		}
		if err := target.session.SendBinaryToSub(target.subId, data); err != nil {
			h.logger.Debug("doc ws binary broadcast failed",
				"document_id", documentID,
				"sub_id", target.subId,
				"error", err,
			)
		}
	}
}

func (h *DocHandler) snapshotDocSubscribers(documentID string) []*docSubscriber {
	h.docSubsMu.RLock()
	subs := h.docSubs[documentID]
	targets := make([]*docSubscriber, len(subs))
	copy(targets, subs)
	h.docSubsMu.RUnlock()
	return targets
}

func (h *DocHandler) registerDocSubscriber(sub *docSubscriber) {
	if sub == nil {
		return
	}

	h.docSubsMu.Lock()
	h.docSubs[sub.documentID] = append(h.docSubs[sub.documentID], sub)
	h.docSubsMu.Unlock()
}

func (h *DocHandler) unregisterDocSubscriber(sub *docSubscriber) {
	if sub == nil {
		return
	}

	h.docSubsMu.Lock()
	defer h.docSubsMu.Unlock()

	subs := h.docSubs[sub.documentID]
	if len(subs) == 0 {
		return
	}

	targetConnID := ""
	if sub.session != nil {
		targetConnID = sub.session.ConnectionID()
	}

	filtered := make([]*docSubscriber, 0, len(subs))
	for _, candidate := range subs {
		if candidate == nil {
			continue
		}
		if candidate.subId == sub.subId {
			candidateConnID := ""
			if candidate.session != nil {
				candidateConnID = candidate.session.ConnectionID()
			}
			if candidateConnID == targetConnID {
				continue
			}
		}
		filtered = append(filtered, candidate)
	}

	if len(filtered) == 0 {
		delete(h.docSubs, sub.documentID)
		return
	}
	h.docSubs[sub.documentID] = filtered
}

func (h *DocHandler) requireState(rawState wsutil.State) (*docHandlerState, error) {
	state, ok := rawState.(*docHandlerState)
	if !ok || state == nil {
		return nil, fmt.Errorf("invalid doc handler state")
	}
	return state, nil
}

func (s *docHandlerState) register(sub *docSubscriber) {
	if sub == nil {
		return
	}
	s.mu.Lock()
	s.subsByDoc[sub.documentID] = sub
	s.subsBySubId[sub.subId] = sub
	s.mu.Unlock()
}

func (s *docHandlerState) findByDocumentID(documentID string) *docSubscriber {
	s.mu.RLock()
	sub := s.subsByDoc[documentID]
	s.mu.RUnlock()
	return sub
}

func (s *docHandlerState) findBySubID(subID string) *docSubscriber {
	s.mu.RLock()
	sub := s.subsBySubId[subID]
	s.mu.RUnlock()
	return sub
}

func (s *docHandlerState) removeBySubID(subID string) *docSubscriber {
	s.mu.Lock()
	defer s.mu.Unlock()

	sub := s.subsBySubId[subID]
	if sub == nil {
		return nil
	}

	delete(s.subsBySubId, subID)
	if current := s.subsByDoc[sub.documentID]; current != nil && current.subId == subID {
		delete(s.subsByDoc, sub.documentID)
	}
	return sub
}
