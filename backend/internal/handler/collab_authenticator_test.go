package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	collabModels "meridian/internal/domain/models/collab"
)

// --- test resolver for authenticator unit tests ---

type testAuthResolver struct {
	allowed    bool
	ownerErr   error
	projectID  string
	resolveErr error
}

func (r *testAuthResolver) ResolveDocument(_ context.Context, docID string) (*collabModels.CollabDocRef, error) {
	if r.resolveErr != nil {
		return nil, r.resolveErr
	}
	return &collabModels.CollabDocRef{
		DocumentID: docID,
		ProjectID:  r.projectID,
	}, nil
}

func (r *testAuthResolver) VerifyOwnership(_ context.Context, _ string, _ string) (bool, error) {
	if r.ownerErr != nil {
		return false, r.ownerErr
	}
	return r.allowed, nil
}

func newTestAuthenticator(resolver *testAuthResolver, verifier *testJWTVerifier) *collabAuthenticator {
	return newCollabAuthenticator(
		verifier,
		resolver,
		nil,
		slog.New(slog.NewTextHandler(io.Discard, nil)),
	)
}

// --- checkDocumentAccess tests ---

func TestAuthenticator_CheckDocumentAccess_Success(t *testing.T) {
	resolver := &testAuthResolver{allowed: true, projectID: testProjectID}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	code, msg := auth.checkDocumentAccess(context.Background(), testProjectID, testUserID, testDocID1)
	if code != "" || msg != "" {
		t.Fatalf("expected success, got code=%q msg=%q", code, msg)
	}
}

func TestAuthenticator_CheckDocumentAccess_Forbidden(t *testing.T) {
	resolver := &testAuthResolver{allowed: false, projectID: testProjectID}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	code, msg := auth.checkDocumentAccess(context.Background(), testProjectID, testUserID, testDocID1)
	if code != "FORBIDDEN" {
		t.Fatalf("expected FORBIDDEN, got code=%q msg=%q", code, msg)
	}
}

func TestAuthenticator_CheckDocumentAccess_OwnershipError(t *testing.T) {
	resolver := &testAuthResolver{ownerErr: errors.New("db down")}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	code, _ := auth.checkDocumentAccess(context.Background(), testProjectID, testUserID, testDocID1)
	if code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got code=%q", code)
	}
}

func TestAuthenticator_CheckDocumentAccess_ProjectMismatch(t *testing.T) {
	otherProject := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	resolver := &testAuthResolver{allowed: true, projectID: otherProject}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	code, _ := auth.checkDocumentAccess(context.Background(), testProjectID, testUserID, testDocID1)
	if code != "PROJECT_MISMATCH" {
		t.Fatalf("expected PROJECT_MISMATCH, got code=%q", code)
	}
}

func TestAuthenticator_CheckDocumentAccess_ResolveError(t *testing.T) {
	resolver := &testAuthResolver{allowed: true, resolveErr: errors.New("db down")}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	code, _ := auth.checkDocumentAccess(context.Background(), testProjectID, testUserID, testDocID1)
	if code != "INTERNAL_ERROR" {
		t.Fatalf("expected INTERNAL_ERROR, got code=%q", code)
	}
}

// --- getSubscriptionInvalidationReason tests ---

func TestAuthenticator_InvalidationReason_Valid(t *testing.T) {
	resolver := &testAuthResolver{allowed: true, projectID: testProjectID}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	reason, invalid := auth.getSubscriptionInvalidationReason(context.Background(), testProjectID, testUserID, testDocID1)
	if invalid {
		t.Fatalf("expected valid subscription, got invalid with reason=%q", reason)
	}
}

func TestAuthenticator_InvalidationReason_AccessRevoked(t *testing.T) {
	resolver := &testAuthResolver{allowed: false, projectID: testProjectID}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	reason, invalid := auth.getSubscriptionInvalidationReason(context.Background(), testProjectID, testUserID, testDocID1)
	if !invalid || reason != "access_revoked" {
		t.Fatalf("expected access_revoked, got invalid=%v reason=%q", invalid, reason)
	}
}

func TestAuthenticator_InvalidationReason_ProjectMismatch(t *testing.T) {
	otherProject := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	resolver := &testAuthResolver{allowed: true, projectID: otherProject}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	reason, invalid := auth.getSubscriptionInvalidationReason(context.Background(), testProjectID, testUserID, testDocID1)
	if !invalid || reason != "project_mismatch" {
		t.Fatalf("expected project_mismatch, got invalid=%v reason=%q", invalid, reason)
	}
}

func TestAuthenticator_InvalidationReason_OwnershipErrorFailsOpen(t *testing.T) {
	// Transient errors should not invalidate subscriptions (fail-open).
	resolver := &testAuthResolver{ownerErr: errors.New("db timeout")}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	reason, invalid := auth.getSubscriptionInvalidationReason(context.Background(), testProjectID, testUserID, testDocID1)
	if invalid {
		t.Fatalf("expected fail-open on transient error, got invalid with reason=%q", reason)
	}
}

func TestAuthenticator_InvalidationReason_ResolveErrorFailsOpen(t *testing.T) {
	resolver := &testAuthResolver{allowed: true, resolveErr: errors.New("db timeout")}
	auth := newTestAuthenticator(resolver, &testJWTVerifier{})

	reason, invalid := auth.getSubscriptionInvalidationReason(context.Background(), testProjectID, testUserID, testDocID1)
	if invalid {
		t.Fatalf("expected fail-open on resolve error, got invalid with reason=%q", reason)
	}
}
