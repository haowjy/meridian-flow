package collab

import (
	"context"
	"fmt"
	"log/slog"
	"sort"

	"github.com/google/uuid"
	ycrdt "github.com/haowjy/y-crdt"

	"meridian/internal/domain"
	"meridian/internal/domain/repositories"
	"meridian/internal/domain/services"
	collabSvc "meridian/internal/domain/services/collab"
)

const (
	restoreBookmarkTypeAITurn        = "ai_turn"
	restoreBookmarkTypeSafetyRestore = "safety_restore"
	restoreDeleteAllUpdatesCutoff    = int64(^uint64(0) >> 1)
)

type restoreSessionManager interface {
	Freeze(ctx context.Context, docID string) error
	Rebuild(ctx context.Context, docID string) error
}

type restoreBroadcaster interface {
	BroadcastDocumentRestored(documentID string)
}

type RestoreService struct {
	bookmarkStore   collabSvc.BookmarkStore
	stateStore      collabSvc.DocumentStateStore
	checkpointStore collabSvc.CheckpointStore
	updateLogStore  collabSvc.UpdateLogStore
	statusMirror    collabSvc.StatusMirror
	sessionManager  restoreSessionManager
	broadcaster     restoreBroadcaster
	txManager       repositories.TransactionManager
	authorizer      services.ResourceAuthorizer
	logger          *slog.Logger
}

func NewRestoreService(
	bookmarkStore collabSvc.BookmarkStore,
	stateStore collabSvc.DocumentStateStore,
	checkpointStore collabSvc.CheckpointStore,
	updateLogStore collabSvc.UpdateLogStore,
	statusMirror collabSvc.StatusMirror,
	sessionManager restoreSessionManager,
	broadcaster restoreBroadcaster,
	txManager repositories.TransactionManager,
	authorizer services.ResourceAuthorizer,
	logger *slog.Logger,
) collabSvc.RestoreService {
	if logger == nil {
		logger = slog.Default()
	}
	return &RestoreService{
		bookmarkStore:   bookmarkStore,
		stateStore:      stateStore,
		checkpointStore: checkpointStore,
		updateLogStore:  updateLogStore,
		statusMirror:    statusMirror,
		sessionManager:  sessionManager,
		broadcaster:     broadcaster,
		txManager:       txManager,
		authorizer:      authorizer,
		logger:          logger,
	}
}

func (s *RestoreService) RestoreTurn(ctx context.Context, userID string, turnID uuid.UUID) (*collabSvc.RestoreResult, error) {
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID.String()); err != nil {
		return nil, err
	}

	return s.restoreFromTurn(ctx, turnID, restoreBookmarkTypeAITurn, true)
}

func (s *RestoreService) UndoRestore(ctx context.Context, userID string, turnID uuid.UUID) (*collabSvc.RestoreResult, error) {
	if err := s.authorizer.CanAccessTurn(ctx, userID, turnID.String()); err != nil {
		return nil, err
	}

	return s.restoreFromTurn(ctx, turnID, restoreBookmarkTypeSafetyRestore, false)
}

func (s *RestoreService) restoreFromTurn(
	ctx context.Context,
	turnID uuid.UUID,
	sourceBookmarkType string,
	createSafetyBookmarks bool,
) (*collabSvc.RestoreResult, error) {
	turnIDStr := turnID.String()
	allBookmarks, err := s.bookmarkStore.ListByTurnID(ctx, turnIDStr)
	if err != nil {
		return nil, fmt.Errorf("list turn bookmarks: %w", err)
	}

	sourceBookmarks := make(map[string]collabSvc.Bookmark)
	for _, bookmark := range allBookmarks {
		if bookmark.BookmarkType != sourceBookmarkType {
			continue
		}
		if _, exists := sourceBookmarks[bookmark.DocumentID]; exists {
			continue
		}
		sourceBookmarks[bookmark.DocumentID] = bookmark
	}
	if len(sourceBookmarks) == 0 {
		return nil, domain.NewNotFoundError(
			"turn_restore",
			fmt.Sprintf("no %s bookmarks found for turn %s", sourceBookmarkType, turnID),
		)
	}

	docIDs := make([]string, 0, len(sourceBookmarks))
	for docID := range sourceBookmarks {
		docIDs = append(docIDs, docID)
	}
	sort.Strings(docIDs)

	restoredStates := make(map[string][]byte, len(docIDs))
	frozenDocIDs := make([]string, 0, len(docIDs))

	txErr := s.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		for _, docID := range docIDs {
			if err := s.updateLogStore.AcquireCompactionLock(txCtx, docID); err != nil {
				return err
			}
		}

		for _, docID := range docIDs {
			if err := s.sessionManager.Freeze(txCtx, docID); err != nil {
				return fmt.Errorf("freeze session %s: %w", docID, err)
			}
			frozenDocIDs = append(frozenDocIDs, docID)
		}

		if createSafetyBookmarks {
			for _, docID := range docIDs {
				currentState, err := s.stateStore.LoadState(txCtx, docID)
				if err != nil {
					return fmt.Errorf("load current state for safety bookmark %s: %w", docID, err)
				}
				bookmark := &collabSvc.Bookmark{
					DocumentID:   docID,
					State:        currentState,
					BookmarkType: restoreBookmarkTypeSafetyRestore,
					TurnID:       &turnIDStr,
				}
				if err := s.bookmarkStore.Create(txCtx, bookmark); err != nil {
					return fmt.Errorf("create safety bookmark for %s: %w", docID, err)
				}
			}
		}

		for _, docID := range docIDs {
			bookmark := sourceBookmarks[docID]
			bookmarkState, err := s.bookmarkStore.GetState(txCtx, bookmark.ID)
			if err != nil {
				return fmt.Errorf("resolve restore state for %s: %w", docID, err)
			}
			restoredStates[docID] = append([]byte(nil), bookmarkState...)

			if err := s.checkpointStore.Create(txCtx, docID, bookmarkState, 0); err != nil {
				return fmt.Errorf("create restore checkpoint for %s: %w", docID, err)
			}
			if err := s.updateLogStore.DeleteUpTo(txCtx, docID, restoreDeleteAllUpdatesCutoff); err != nil {
				return fmt.Errorf("delete updates after restore for %s: %w", docID, err)
			}

			content, err := decodeRestoreContent(bookmarkState)
			if err != nil {
				s.logger.Warn("decode restored content failed, storing empty content projection",
					"document_id", docID,
					"error", err,
				)
				content = ""
			}
			if err := s.stateStore.SaveState(txCtx, docID, bookmarkState, content); err != nil {
				return fmt.Errorf("save restored content projection for %s: %w", docID, err)
			}
		}

		return nil
	})

	if txErr != nil {
		if rebuildErr := s.rebuildFrozenDocuments(ctx, frozenDocIDs); rebuildErr != nil {
			return nil, fmt.Errorf("%w (rebuild failed: %v)", txErr, rebuildErr)
		}
		return nil, txErr
	}

	for _, docID := range docIDs {
		if s.broadcaster != nil {
			s.broadcaster.BroadcastDocumentRestored(docID)
		}
	}

	if s.statusMirror != nil {
		for _, docID := range docIDs {
			statusMap, err := extractProposalStatusMapFromState(restoredStates[docID])
			if err != nil {
				if rebuildErr := s.rebuildFrozenDocuments(ctx, frozenDocIDs); rebuildErr != nil {
					return nil, fmt.Errorf("extract restored status map for %s: %w (rebuild failed: %v)", docID, err, rebuildErr)
				}
				return nil, fmt.Errorf("extract restored status map for %s: %w", docID, err)
			}
			if err := s.statusMirror.ReconcileAll(ctx, docID, statusMap); err != nil {
				if rebuildErr := s.rebuildFrozenDocuments(ctx, frozenDocIDs); rebuildErr != nil {
					return nil, fmt.Errorf("reconcile restored status map for %s: %w (rebuild failed: %v)", docID, err, rebuildErr)
				}
				return nil, fmt.Errorf("reconcile restored status map for %s: %w", docID, err)
			}
		}
	}

	if rebuildErr := s.rebuildFrozenDocuments(ctx, frozenDocIDs); rebuildErr != nil {
		return nil, rebuildErr
	}

	affectedDocumentIDs := make([]uuid.UUID, 0, len(docIDs))
	for _, docID := range docIDs {
		docUUID, err := uuid.Parse(docID)
		if err != nil {
			return nil, fmt.Errorf("parse restored document id %q: %w", docID, err)
		}
		affectedDocumentIDs = append(affectedDocumentIDs, docUUID)
	}

	return &collabSvc.RestoreResult{
		AffectedDocumentIDs: affectedDocumentIDs,
	}, nil
}

func (s *RestoreService) rebuildFrozenDocuments(ctx context.Context, docIDs []string) error {
	for _, docID := range docIDs {
		if err := s.sessionManager.Rebuild(ctx, docID); err != nil {
			return fmt.Errorf("rebuild session %s: %w", docID, err)
		}
	}
	return nil
}

func decodeRestoreContent(state []byte) (string, error) {
	doc := ycrdt.NewDoc("restore-content", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, "restore-content"); err != nil {
			return "", err
		}
	}

	yText := doc.GetText("content")
	if yText == nil {
		return "", nil
	}
	return yText.ToString(), nil
}

func extractProposalStatusMapFromState(state []byte) (map[string]string, error) {
	doc := ycrdt.NewDoc("restore-status-map", true, ycrdt.DefaultGCFilter, nil, false)
	if len(state) > 0 {
		if err := safeApplyUpdate(doc, state, "restore-status-map"); err != nil {
			return nil, err
		}
	}

	statusMapAny := doc.GetMap("_proposal_status")
	statusMap, ok := statusMapAny.(*ycrdt.YMap)
	if !ok || statusMap == nil {
		return map[string]string{}, nil
	}

	snapshot := make(map[string]string)
	statusMap.Range(func(key string, value interface{}) {
		status, isString := value.(string)
		if !isString {
			return
		}
		snapshot[key] = status
	})

	return snapshot, nil
}
