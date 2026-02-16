package collab

import (
	"context"
	"fmt"
	"log/slog"
	"sync"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
	collabSvc "meridian/internal/domain/services/collab"
)

const (
	defaultPersistDebounce         = 2 * time.Second
	defaultSnapshotIntervalUpdates = 500
	persistTimeout                 = 10 * time.Second
)

// DocumentSessionManager manages in-memory Yjs docs for active websocket sessions.
type DocumentSessionManager struct {
	mu                      sync.Mutex
	sessions                map[string]*DocumentSession
	store                   collabSvc.DocumentStore
	logger                  *slog.Logger
	snapshotIntervalUpdates int
}

// DocumentSession wraps a single in-memory Y.Doc lifecycle.
type DocumentSession struct {
	docID                   string
	doc                     *ycrdt.Doc
	store                   collabSvc.DocumentStore
	logger                  *slog.Logger
	snapshotIntervalUpdates int

	mu            sync.Mutex
	refCount      int
	dirty         bool
	updateCount   int
	debounceTimer *time.Timer
}

// NewDocumentSessionManager creates the collab document runtime cache.
func NewDocumentSessionManager(
	store collabSvc.DocumentStore,
	logger *slog.Logger,
	snapshotIntervalUpdates int,
) *DocumentSessionManager {
	if snapshotIntervalUpdates <= 0 {
		snapshotIntervalUpdates = defaultSnapshotIntervalUpdates
	}

	return &DocumentSessionManager{
		sessions:                make(map[string]*DocumentSession),
		store:                   store,
		logger:                  logger,
		snapshotIntervalUpdates: snapshotIntervalUpdates,
	}
}

// Acquire returns a live document session, creating and loading it on first connect.
func (m *DocumentSessionManager) Acquire(ctx context.Context, docID string) (*DocumentSession, error) {
	m.mu.Lock()
	if existing, ok := m.sessions[docID]; ok {
		existing.refCount++
		m.mu.Unlock()
		return existing, nil
	}
	m.mu.Unlock()

	session := &DocumentSession{
		docID:                   docID,
		doc:                     ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false),
		store:                   m.store,
		logger:                  m.logger,
		snapshotIntervalUpdates: m.snapshotIntervalUpdates,
		refCount:                1,
	}

	if err := session.loadState(ctx); err != nil {
		return nil, err
	}

	m.mu.Lock()
	defer m.mu.Unlock()
	if existing, ok := m.sessions[docID]; ok {
		existing.refCount++
		return existing, nil
	}

	m.sessions[docID] = session
	return session, nil
}

// Release decrements references and flushes state when the last websocket disconnects.
func (m *DocumentSessionManager) Release(ctx context.Context, docID string) error {
	m.mu.Lock()
	session, ok := m.sessions[docID]
	if !ok {
		m.mu.Unlock()
		return nil
	}

	session.refCount--
	if session.refCount > 0 {
		m.mu.Unlock()
		return nil
	}
	delete(m.sessions, docID)
	m.mu.Unlock()

	flushCtx, cancel := context.WithTimeout(ctx, persistTimeout)
	defer cancel()

	if err := session.flushOnDisconnect(flushCtx); err != nil {
		return err
	}

	return nil
}

// BuildSyncStep1Payload creates a sync-step1 message from current in-memory state.
func (s *DocumentSession) BuildSyncStep1Payload() ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	encoder := ycrdt.NewUpdateEncoderV1()
	ycrdt.WriteSyncStep1(encoder, s.doc)
	return encoder.ToUint8Array(), nil
}

// HandleSyncPayload applies a sync payload and returns protocol-specific response/update artifacts.
func (s *DocumentSession) HandleSyncPayload(payload []byte, transactionOrigin string) (int, []byte, []byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	decoder := ycrdt.NewUpdateDecoderV1(payload)
	responseEncoder := ycrdt.NewUpdateEncoderV1()
	messageType, err := safeReadSyncMessage(decoder, responseEncoder, s.doc, transactionOrigin)
	if err != nil {
		return 0, nil, nil, err
	}

	responsePayload := responseEncoder.ToUint8Array()

	var updatePayload []byte
	switch messageType {
	case ycrdt.MessageYjsSyncStep2, ycrdt.MessageYjsUpdate:
		updatePayload, err = extractUpdatePayload(payload)
		if err != nil {
			return 0, nil, nil, err
		}

		if err := s.markDirtyLocked(); err != nil {
			return 0, nil, nil, err
		}
	}

	return messageType, responsePayload, updatePayload, nil
}

func (s *DocumentSession) loadState(ctx context.Context) error {
	state, err := s.store.LoadState(ctx, s.docID)
	if err != nil {
		return err
	}
	if len(state) == 0 {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if err := safeApplyUpdate(s.doc, state, nil); err != nil {
		return fmt.Errorf("apply persisted yjs state: %w", err)
	}

	return nil
}

func (s *DocumentSession) flushOnDisconnect(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}

	if !s.dirty {
		return nil
	}

	if err := s.persistLocked(ctx, true); err != nil {
		return err
	}

	s.updateCount = 0
	return nil
}

func (s *DocumentSession) markDirtyLocked() error {
	s.dirty = true
	s.updateCount++

	if s.debounceTimer == nil {
		s.debounceTimer = time.AfterFunc(defaultPersistDebounce, s.runDebouncePersist)
	} else {
		s.debounceTimer.Reset(defaultPersistDebounce)
	}

	if s.updateCount >= s.snapshotIntervalUpdates {
		if err := s.persistLocked(context.Background(), true); err != nil {
			return err
		}
		s.updateCount = 0
	}

	return nil
}

func (s *DocumentSession) runDebouncePersist() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.dirty {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), persistTimeout)
	defer cancel()

	if err := s.persistLocked(ctx, false); err != nil {
		s.logger.Error("collab debounce persist failed",
			"document_id", s.docID,
			"error", err,
		)
	}
}

func (s *DocumentSession) persistLocked(ctx context.Context, writeSnapshot bool) error {
	state, content, err := s.currentStateLocked()
	if err != nil {
		return err
	}

	if err := s.store.SaveState(ctx, s.docID, state, content, content); err != nil {
		return err
	}

	if writeSnapshot {
		if err := s.store.SaveSnapshot(ctx, s.docID, state, "auto", nil, nil); err != nil {
			return err
		}
	}

	s.dirty = false
	return nil
}

func (s *DocumentSession) currentStateLocked() ([]byte, string, error) {
	state, err := safeEncodeStateAsUpdate(s.doc)
	if err != nil {
		return nil, "", err
	}

	// GetText normalizes placeholder AbstractType entries into concrete YText.
	// Reading doc.Share directly can miss valid content after ApplyUpdate.
	content := ""
	if yText := s.doc.GetText("content"); yText != nil {
		content = yText.ToString()
	}

	return state, content, nil
}

func extractUpdatePayload(syncPayload []byte) ([]byte, error) {
	decoder := ycrdt.NewUpdateDecoderV1(syncPayload)
	msgType := ycrdt.ReadVarUint(decoder.RestDecoder)
	if msgType != ycrdt.MessageYjsSyncStep2 && msgType != ycrdt.MessageYjsUpdate {
		return nil, fmt.Errorf("sync payload is not an update message: type=%d", msgType)
	}

	dataAny, err := ycrdt.ReadVarUint8Array(decoder.RestDecoder)
	if err != nil {
		return nil, fmt.Errorf("decode update payload: %w", err)
	}

	update, ok := dataAny.([]byte)
	if !ok {
		return nil, fmt.Errorf("decode update payload: unexpected payload type %T", dataAny)
	}

	return update, nil
}

func safeReadSyncMessage(
	decoder *ycrdt.UpdateDecoderV1,
	encoder *ycrdt.UpdateEncoderV1,
	doc *ycrdt.Doc,
	origin interface{},
) (messageType int, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("read sync message panic: %v", r)
		}
	}()

	messageType = ycrdt.ReadSyncMessage(decoder, encoder, doc, origin)
	return messageType, nil
}

func safeApplyUpdate(doc *ycrdt.Doc, update []byte, origin interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply update panic: %v", r)
		}
	}()

	ycrdt.ApplyUpdate(doc, update, origin)
	return nil
}

func safeEncodeStateAsUpdate(doc *ycrdt.Doc) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state panic: %v", r)
		}
	}()

	state = ycrdt.EncodeStateAsUpdate(doc, nil)
	return state, nil
}
