package streaming

import (
	"context"
	"errors"
	"testing"

	"meridian/internal/domain"
	"meridian/internal/domain/services"
)

func TestServiceMovedTurnAuthorizationIntoServiceMethods(t *testing.T) {
	svc := &Service{
		authorizer: &testStreamingAuthorizer{
			err: domain.NewForbiddenError("access denied"),
		},
	}

	if err := svc.InterruptTurn(context.Background(), "user-123", "turn-123"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("InterruptTurn expected forbidden error, got %v", err)
	}

	if err := svc.AuthorizeTurnStream(context.Background(), "user-123", "turn-123"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("AuthorizeTurnStream expected forbidden error, got %v", err)
	}

	if _, err := svc.UpsertInterjection(context.Background(), "user-123", "turn-123", "hi", "append"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("UpsertInterjection expected forbidden error, got %v", err)
	}

	if _, err := svc.GetInterjection(context.Background(), "user-123", "turn-123"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("GetInterjection expected forbidden error, got %v", err)
	}

	if err := svc.ClearInterjection(context.Background(), "user-123", "turn-123"); !errors.Is(err, domain.ErrForbidden) {
		t.Fatalf("ClearInterjection expected forbidden error, got %v", err)
	}
}

type testStreamingAuthorizer struct {
	err error
}

func (a *testStreamingAuthorizer) CanAccessProject(context.Context, string, string) error { return nil }
func (a *testStreamingAuthorizer) CanAccessFolder(context.Context, string, string) error  { return nil }
func (a *testStreamingAuthorizer) CanAccessDocument(context.Context, string, string) error {
	return nil
}
func (a *testStreamingAuthorizer) CanAccessThread(context.Context, string, string) error { return nil }
func (a *testStreamingAuthorizer) CanAccessTurn(context.Context, string, string) error   { return a.err }

var _ services.ResourceAuthorizer = (*testStreamingAuthorizer)(nil)
