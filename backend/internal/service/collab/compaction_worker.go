package collab

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"meridian/internal/domain"
	collab "meridian/internal/domain/collab"

	ycrdt "github.com/haowjy/y-crdt"
)

const (
	defaultCompactionInterval = 60 * time.Second
	compactionThreshold       = int64(20000)
	compactionBatchSize       = int64(10000)
	bookmarkTypeManual        = "manual"
	bookmarkTypeDaily         = "daily"
	bookmarkTypeSafetyRestore = "safety_restore"
)

// CompactionWorker periodically compacts append-only Yjs update logs.
type CompactionWorker struct {
	updateLogStore  collab.UpdateLogStore
	checkpointStore collab.CheckpointStore
	bookmarkStore   collab.BookmarkStore
	txManager       domain.TransactionManager
	logger          *slog.Logger
	interval        time.Duration
	stop            chan struct{}
	done            chan struct{}
}

// NewCompactionWorker creates a compaction worker.
func NewCompactionWorker(
	updateLogStore collab.UpdateLogStore,
	checkpointStore collab.CheckpointStore,
	bookmarkStore collab.BookmarkStore,
	txManager domain.TransactionManager,
	logger *slog.Logger,
	interval time.Duration,
) *CompactionWorker {
	if interval <= 0 {
		interval = defaultCompactionInterval
	}

	return &CompactionWorker{
		updateLogStore:  updateLogStore,
		checkpointStore: checkpointStore,
		bookmarkStore:   bookmarkStore,
		txManager:       txManager,
		logger:          logger,
		interval:        interval,
		stop:            make(chan struct{}),
		done:            make(chan struct{}),
	}
}

// Start runs compaction on an interval until Stop is called.
func (w *CompactionWorker) Start(ctx context.Context) {
	defer close(w.done)

	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()

	w.logger.Info("collab compaction worker started",
		"interval", w.interval.String(),
		"threshold_updates", compactionThreshold,
		"compact_batch_size", compactionBatchSize,
	)

	w.runOnce(ctx)

	for {
		select {
		case <-w.stop:
			return
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.runOnce(ctx)
		}
	}
}

// Stop signals worker shutdown and waits until background loop exits.
func (w *CompactionWorker) Stop(ctx context.Context) error {
	close(w.stop)
	select {
	case <-w.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func (w *CompactionWorker) runOnce(ctx context.Context) {
	runCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()

	docIDs, err := w.updateLogStore.ListDocumentsWithMinUpdates(runCtx, compactionThreshold)
	if err != nil {
		w.logger.Error("list compaction candidates failed", "error", err)
		return
	}

	for _, docID := range docIDs {
		if err := w.compactDocument(runCtx, docID); err != nil {
			w.logger.Error("document compaction failed", "document_id", docID, "error", err)
		}
	}
}

func (w *CompactionWorker) compactDocument(ctx context.Context, docID string) error {
	return w.txManager.ExecTx(ctx, func(txCtx context.Context) error {
		if err := w.updateLogStore.AcquireCompactionLock(txCtx, docID); err != nil {
			return err
		}

		count, err := w.updateLogStore.CountUpdates(txCtx, docID)
		if err != nil {
			return err
		}
		if count < compactionThreshold {
			return nil
		}

		cutoffID, err := w.updateLogStore.GetNthOldestUpdateID(txCtx, docID, compactionBatchSize)
		if err != nil {
			if errors.Is(err, domain.ErrNotFound) {
				return nil
			}
			return err
		}

		checkpointState, checkpointUpToID, err := w.checkpointStore.GetLatest(txCtx, docID)
		if err != nil {
			return err
		}
		if checkpointUpToID >= cutoffID {
			return nil
		}

		if err := w.materializeBookmarks(txCtx, docID, cutoffID, bookmarkTypeManual); err != nil {
			return err
		}
		if err := w.materializeBookmarks(txCtx, docID, cutoffID, bookmarkTypeDaily); err != nil {
			return err
		}
		if err := w.bookmarkStore.DeleteByTypeAndCutoff(txCtx, docID, "ai_turn", cutoffID); err != nil {
			return err
		}
		if err := w.bookmarkStore.DeleteByTypeAndCutoff(txCtx, docID, bookmarkTypeSafetyRestore, cutoffID); err != nil {
			return err
		}

		updateEntries, err := w.updateLogStore.ListUpdatesInRange(txCtx, docID, checkpointUpToID, cutoffID)
		if err != nil {
			return err
		}
		mergedState, err := mergeCheckpointAndUpdates(docID, checkpointState, updateEntries)
		if err != nil {
			return err
		}

		if err := w.checkpointStore.Create(txCtx, docID, mergedState, cutoffID); err != nil {
			return err
		}
		if err := w.updateLogStore.DeleteUpTo(txCtx, docID, cutoffID); err != nil {
			return err
		}

		w.logger.Info("compacted append-only updates",
			"document_id", docID,
			"cutoff_update_id", cutoffID,
			"count_before", count,
		)
		return nil
	})
}

func (w *CompactionWorker) materializeBookmarks(
	ctx context.Context,
	docID string,
	cutoffID int64,
	bookmarkType string,
) error {
	bookmarks, err := w.bookmarkStore.ListByDocumentAndType(ctx, docID, bookmarkType)
	if err != nil {
		return err
	}

	for _, bookmark := range bookmarks {
		if bookmark.UpdateID == nil || *bookmark.UpdateID > cutoffID {
			continue
		}
		state, stateErr := w.bookmarkStore.GetState(ctx, bookmark.ID)
		if stateErr != nil {
			return fmt.Errorf("resolve bookmark %s state before materialize: %w", bookmark.ID, stateErr)
		}
		if err := w.bookmarkStore.MaterializeState(ctx, bookmark.ID, state); err != nil {
			return err
		}
	}

	return nil
}

func mergeCheckpointAndUpdates(
	docID string,
	checkpointState []byte,
	updates []collab.UpdateLogEntry,
) ([]byte, error) {
	doc := ycrdt.NewDoc(docID, true, ycrdt.DefaultGCFilter, nil, false)

	if len(checkpointState) > 0 {
		if err := safeApplyUpdate(doc, checkpointState, "compaction-checkpoint"); err != nil {
			return nil, fmt.Errorf("apply compaction checkpoint state: %w", err)
		}
	}

	for _, entry := range updates {
		if err := safeApplyUpdate(doc, entry.Update, "compaction-update"); err != nil {
			return nil, fmt.Errorf("apply compaction update %d: %w", entry.ID, err)
		}
	}

	state, err := safeEncodeStateAsUpdate(doc)
	if err != nil {
		return nil, fmt.Errorf("encode compacted checkpoint state: %w", err)
	}
	return state, nil
}
