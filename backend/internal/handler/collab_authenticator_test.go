package handler

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	collab "meridian/internal/domain/collab"
)

// --- test resolver for authenticator unit tests ---

type testAuthResolver struct {
	allowed    bool
	ownerErr   error
	projectID  string
	resolveErr error
}

func (r *testAuthResolver) ResolveDocument(_ context.Context, docID string) (*collab.CollabDocRef, error) {
	if r.resolveErr != nil {
		return nil, r.resolveErr
	}
	return &collab.CollabDocRef{
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
		nil,
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
