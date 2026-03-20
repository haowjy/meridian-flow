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
	"meridian/internal/httputil"
)

type fakeRestoreAuthorizer struct {
	err            error
	canAccessCalls []struct {
		userID string
		turnID string
	}
}

func (a *fakeRestoreAuthorizer) CanAccessProject(context.Context, string, string) error { return nil }
func (a *fakeRestoreAuthorizer) CanAccessFolder(context.Context, string, string) error  { return nil }
func (a *fakeRestoreAuthorizer) CanAccessDocument(context.Context, string, string) error {
	return nil
}
func (a *fakeRestoreAuthorizer) CanAccessThread(context.Context, string, string) error { return nil }
func (a *fakeRestoreAuthorizer) CanAccessTurn(_ context.Context, userID, turnID string) error {
	a.canAccessCalls = append(a.canAccessCalls, struct {
		userID string
		turnID string
	}{userID: userID, turnID: turnID})
	return a.err
}

func TestCollabRestoreHandlerRestoreTurnSuccess(t *testing.T) {
	turnID := uuid.New()
	docA := uuid.New()
	docB := uuid.New()
	authorizer := &fakeRestoreAuthorizer{}
	service := &fakeRestoreService{
		restoreResult: &collabSvc.RestoreResult{
			AffectedDocumentIDs: []uuid.UUID{docA, docB},
		},
	}
	h := NewCollabRestoreHandler(service, authorizer, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/"+turnID.String()+"/restore", nil)
	req.SetPathValue("id", turnID.String())
	req = httputil.WithUserID(req, testUserID)
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
	if len(authorizer.canAccessCalls) != 1 || authorizer.canAccessCalls[0].turnID != turnID.String() {
		t.Fatalf("expected one auth check for turn %s, got %+v", turnID, authorizer.canAccessCalls)
	}
}

func TestCollabRestoreHandlerUndoRestoreNotFound(t *testing.T) {
	turnID := uuid.New()
	authorizer := &fakeRestoreAuthorizer{}
	service := &fakeRestoreService{
		undoErr: domain.NewNotFoundError("turn_restore", "not found"),
	}
	h := NewCollabRestoreHandler(service, authorizer, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/"+turnID.String()+"/undo-restore", nil)
	req.SetPathValue("id", turnID.String())
	req = httputil.WithUserID(req, testUserID)
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
	h := NewCollabRestoreHandler(&fakeRestoreService{}, &fakeRestoreAuthorizer{}, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/not-a-uuid/restore", nil)
	req.SetPathValue("id", "not-a-uuid")
	rr := httptest.NewRecorder()

	h.RestoreTurn(rr, req)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected status 400, got %d body=%s", rr.Code, rr.Body.String())
	}
}

func TestCollabRestoreHandlerRestoreTurnForbidden(t *testing.T) {
	turnID := uuid.New()
	authorizer := &fakeRestoreAuthorizer{err: domain.NewForbiddenError("access denied")}
	service := &fakeRestoreService{}
	h := NewCollabRestoreHandler(service, authorizer, &config.Config{Environment: "test"})

	req := httptest.NewRequest(http.MethodPost, "/api/turns/"+turnID.String()+"/restore", nil)
	req.SetPathValue("id", turnID.String())
	req = httputil.WithUserID(req, testUserID)
	rr := httptest.NewRecorder()

	h.RestoreTurn(rr, req)

	if rr.Code != http.StatusForbidden {
		t.Fatalf("expected status 403, got %d body=%s", rr.Code, rr.Body.String())
	}
	if len(service.restoreCalls) != 0 {
		t.Fatalf("expected no restore service calls, got %+v", service.restoreCalls)
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
