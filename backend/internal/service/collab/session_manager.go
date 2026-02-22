package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	ycrdt "github.com/skyterra/y-crdt"
	collabSvc "meridian/internal/domain/services/collab"
)

// ErrNoActiveSession is returned by ApplyUpdate when no collab session exists for a document.
// Callers can check for this to gracefully handle the case (e.g., auto-accepted proposals
// when the editor isn't open — the update is persisted and synced on next connect).
var ErrNoActiveSession = errors.New("no active collab session")

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
	contentLoader           collabSvc.DocumentContentLoader
	logger                  *slog.Logger
	snapshotIntervalUpdates int
}

// DocumentSession wraps a single in-memory Y.Doc lifecycle.
//
// Concurrency: refCount is guarded by DocumentSessionManager.mu (not this session's mu).
// Acquire/Release hold the manager lock when reading or writing refCount.
type DocumentSession struct {
	docID                   string
	doc                     *ycrdt.Doc
	store                   collabSvc.DocumentStore
	contentLoader           collabSvc.DocumentContentLoader
	logger                  *slog.Logger
	snapshotIntervalUpdates int

	mu            sync.Mutex
	refCount      int
	dirty         bool
	updateCount   int
	debounceTimer *time.Timer
	lastOrigin    string // "human" or "ai_accept" - tracks origin of most recent mutation for snapshot typing
}

// NewDocumentSessionManager creates the collab document runtime cache.
// contentLoader is separated from store (ISP) — only session bootstrap needs it.
func NewDocumentSessionManager(
	store collabSvc.DocumentStore,
	contentLoader collabSvc.DocumentContentLoader,
	logger *slog.Logger,
	snapshotIntervalUpdates int,
) *DocumentSessionManager {
	if snapshotIntervalUpdates <= 0 {
		snapshotIntervalUpdates = defaultSnapshotIntervalUpdates
	}

	return &DocumentSessionManager{
		sessions:                make(map[string]*DocumentSession),
		store:                   store,
		contentLoader:           contentLoader,
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
		contentLoader:           m.contentLoader,
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

// ApplyUpdate applies a proposal update to the active in-memory Y.Doc for a document.
// If an active session exists, the update is applied to the live doc. Otherwise, it falls
// back to loading persisted state, applying offline, and saving back — so auto-accepted
// proposals work even when no editor has the document open.
func (m *DocumentSessionManager) ApplyUpdate(ctx context.Context, documentID uuid.UUID, update []byte, origin string) error {
	docID := documentID.String()

	m.mu.Lock()
	session, ok := m.sessions[docID]
	m.mu.Unlock()

	if ok {
		return session.applyUpdate(ctx, update, origin)
	}

	// No active session — apply directly to persisted state so the update isn't lost.
	// This happens when AI edits are auto-accepted while no editor has the document open.
	m.logger.Info("applying update offline (no active session)", "document_id", docID, "origin", origin)
	return m.applyUpdateOffline(ctx, docID, update, origin)
}

// applyUpdateOffline loads persisted yjs_state, applies the update to a temporary Y.Doc,
// and saves the merged state back. This ensures auto-accepted proposals are reflected in
// the document state even without a live WS session.
func (m *DocumentSessionManager) applyUpdateOffline(ctx context.Context, docID string, update []byte, origin string) error {
	state, err := m.store.LoadState(ctx, docID)
	if err != nil {
		return fmt.Errorf("load state for offline apply: %w", err)
	}

	doc := ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, nil); err != nil {
			return fmt.Errorf("apply existing state for offline apply: %w", err)
		}
	}

	if err := safeApplyUpdate(doc, update, origin); err != nil {
		return fmt.Errorf("apply proposal update offline: %w", err)
	}

	newState, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		return fmt.Errorf("encode state after offline apply: %w", err)
	}

	content := ""
	if yText := doc.GetText("content"); yText != nil {
		content = yText.ToString()
	}

	// aiContent is recomputed separately by the AIContentProjector, pass empty here
	if err := m.store.SaveState(ctx, docID, newState, content, ""); err != nil {
		return fmt.Errorf("save state after offline apply: %w", err)
	}

	return nil
}

// GetStateSnapshot returns encoded Yjs state for an active in-memory session.
// If no active session exists, found=false and caller should fall back to persisted state.
func (m *DocumentSessionManager) GetStateSnapshot(_ context.Context, documentID uuid.UUID) ([]byte, bool, error) {
	docID := documentID.String()

	m.mu.Lock()
	session, ok := m.sessions[docID]
	m.mu.Unlock()
	if !ok {
		return nil, false, nil
	}

	session.mu.Lock()
	defer session.mu.Unlock()

	state, err := safeEncodeStateAsUpdate(session.doc)
	if err != nil {
		return nil, true, fmt.Errorf("encode in-memory state: %w", err)
	}
	return state, true, nil
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
func (s *DocumentSession) HandleSyncPayload(ctx context.Context, payload []byte, transactionOrigin string) (int, []byte, []byte, error) {
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

		// Mark origin as human since this came from user sync
		s.lastOrigin = "human"
		if err := s.markDirtyLocked(ctx); err != nil {
			return 0, nil, nil, err
		}
	}

	return messageType, responsePayload, updatePayload, nil
}

func (s *DocumentSession) applyUpdate(ctx context.Context, update []byte, origin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if err := safeApplyUpdate(s.doc, update, origin); err != nil {
		return fmt.Errorf("apply yjs update: %w", err)
	}

	// Mark origin as AI accept since this is a proposal runtime update
	s.lastOrigin = "ai_accept"
	if err := s.markDirtyLocked(ctx); err != nil {
		return err
	}
	return nil
}

func (s *DocumentSession) loadState(ctx context.Context) error {
	state, err := s.store.LoadState(ctx, s.docID)
	if err != nil {
		return err
	}
	if len(state) > 0 {
		s.mu.Lock()
		defer s.mu.Unlock()

		if err := safeApplyUpdate(s.doc, state, nil); err != nil {
			return fmt.Errorf("apply persisted yjs state: %w", err)
		}

		return nil
	}

	bootstrapContent, err := s.contentLoader.LoadContentForBootstrap(ctx, s.docID)
	if err != nil {
		return fmt.Errorf("load bootstrap content: %w", err)
	}
	if bootstrapContent == "" {
		return nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	yText := s.doc.GetText("content")
	if yText == nil {
		return nil
	}
	s.doc.Transact(func(_ *ycrdt.Transaction) {
		if yText.Length() == 0 {
			yText.Insert(0, bootstrapContent, nil)
		}
	}, "server-bootstrap")

	persistedState, content, err := s.currentStateLocked()
	if err != nil {
		return err
	}

	// Keep content and ai_content aligned with the bootstrap state.
	if err := s.store.SaveState(ctx, s.docID, persistedState, content, content); err != nil {
		return fmt.Errorf("persist bootstrapped yjs state: %w", err)
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

func (s *DocumentSession) markDirtyLocked(ctx context.Context) error {
	s.dirty = true
	s.updateCount++

	if s.debounceTimer == nil {
		s.debounceTimer = time.AfterFunc(defaultPersistDebounce, s.runDebouncePersist)
	} else {
		s.debounceTimer.Reset(defaultPersistDebounce)
	}

	if s.updateCount >= s.snapshotIntervalUpdates {
		if err := s.persistLocked(ctx, true); err != nil {
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

	// Uses context.Background() because this fires asynchronously from a timer,
	// after the original request context has completed.
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

	// Phase 1: aiContent == content because there is no separate AI-edited view yet.
	// Phase 2+ will diverge these when AI suggestions produce a distinct aiContent.
	if err := s.store.SaveState(ctx, s.docID, state, content, content); err != nil {
		return err
	}

	if writeSnapshot {
		// Route snapshot type by last mutation origin.
		// Mixed-batch tradeoff: if a batch contains both human and AI edits,
		// the last origin wins for this snapshot. This is acceptable since
		// snapshots are frequent (every 500 updates) and TTL-cleaned.
		snapshotType := "auto_human" // default to human if no origin set
		if s.lastOrigin == "ai_accept" {
			snapshotType = "auto_ai_accept"
		}

		if _, err := s.store.SaveSnapshot(ctx, s.docID, state, snapshotType, nil, nil); err != nil {
			return err
		}
	}

	s.dirty = false

	// Stop any pending debounce timer since we just persisted. The next update
	// will create a fresh timer. Without this, a stale timer could fire and
	// persist redundantly (harmless since dirty=false, but wasteful).
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}

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

// safeReadSyncMessage wraps ycrdt.ReadSyncMessage with panic recovery.
// Known panic triggers: nil decoder/encoder, nil doc, malformed sync payload.
// Panics map to RESET_REQUIRED at the handler layer.
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

// safeApplyUpdate wraps ycrdt.ApplyUpdate with panic recovery.
// Known panic triggers: nil doc, malformed/truncated update bytes, nil internal structures.
// Panics map to RESET_REQUIRED at the handler layer.
func safeApplyUpdate(doc *ycrdt.Doc, update []byte, origin interface{}) (err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("apply update panic: %v", r)
		}
	}()

	ycrdt.ApplyUpdate(doc, update, origin)
	return nil
}

// safeEncodeStateAsUpdate wraps ycrdt.EncodeStateAsUpdate with panic recovery.
// Known panic triggers: nil doc, corrupted internal doc state.
// Panics map to RESET_REQUIRED at the handler layer.
func safeEncodeStateAsUpdate(doc *ycrdt.Doc) (state []byte, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("encode state panic: %v", r)
		}
	}()

	state = ycrdt.EncodeStateAsUpdate(doc, nil)
	return state, nil
}
