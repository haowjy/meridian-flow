package handler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"meridian/internal/config"
	"meridian/internal/domain"
	collabSvc "meridian/internal/domain/services/collab"
)

func TestCollabRestoreHandlerRestoreTurnSuccess(t *testing.T) {
	turnID := uuid.New()
	docA := uuid.New()
	docB := uuid.New()
	service := &fakeRestoreService{
		restoreResult: &collabSvc.RestoreResult{
			AffectedDocumentIDs: []uuid.UUID{docA, docB},
		},
	}
	h := NewCollabRestoreHandler(service, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/"+turnID.String()+"/restore", nil)
	req.SetPathValue("id", turnID.String())
	rr := httptest.NewRecorder()

	h.RestoreTurn(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected status 200, got %d body=%s", rr.Code, rr.Body.String())
	}
	var resp restoreTurnResponse
	if err := json.Unmarshal(rr.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(resp.AffectedDocumentIDs) != 2 {
		t.Fatalf("expected 2 affected docs, got %+v", resp.AffectedDocumentIDs)
	}
	if resp.AffectedDocumentIDs[0] != docA.String() || resp.AffectedDocumentIDs[1] != docB.String() {
		t.Fatalf("unexpected affected docs payload: %+v", resp.AffectedDocumentIDs)
	}
	if len(service.restoreCalls) != 1 || service.restoreCalls[0] != turnID {
		t.Fatalf("expected one restore call for %s, got %+v", turnID, service.restoreCalls)
	}
}

func TestCollabRestoreHandlerUndoRestoreNotFound(t *testing.T) {
	turnID := uuid.New()
	service := &fakeRestoreService{
		undoErr: domain.NewNotFoundError("turn_restore", "not found"),
	}
	h := NewCollabRestoreHandler(service, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/"+turnID.String()+"/undo-restore", nil)
	req.SetPathValue("id", turnID.String())
	rr := httptest.NewRecorder()

	h.UndoRestore(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected status 404, got %d body=%s", rr.Code, rr.Body.String())
	}
	if len(service.undoCalls) != 1 || service.undoCalls[0] != turnID {
		t.Fatalf("expected one undo call for %s, got %+v", turnID, service.undoCalls)
	}
}

func TestCollabRestoreHandlerRejectsInvalidTurnID(t *testing.T) {
	h := NewCollabRestoreHandler(&fakeRestoreService{}, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/not-a-uuid/restore", nil)
	req.SetPathValue("id", "not-a-uuid")
	rr := httptest.NewRecorder()

	h.RestoreTurn(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

type fakeRestoreService struct {
	restoreResult *collabSvc.RestoreResult
	restoreErr    error
	undoResult    *collabSvc.RestoreResult
	undoErr       error
	restoreCalls  []uuid.UUID
	undoCalls     []uuid.UUID
}

func (s *fakeRestoreService) RestoreTurn(_ context.Context, turnID uuid.UUID) (*collabSvc.RestoreResult, error) {
	s.restoreCalls = append(s.restoreCalls, turnID)
	return s.restoreResult, s.restoreErr
}

func (s *fakeRestoreService) UndoRestore(_ context.Context, turnID uuid.UUID) (*collabSvc.RestoreResult, error) {
	s.undoCalls = append(s.undoCalls, turnID)
	return s.undoResult, s.undoErr
}
