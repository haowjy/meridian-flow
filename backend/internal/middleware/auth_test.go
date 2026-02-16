package middleware

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/golang-jwt/jwt/v5"
	"meridian/internal/domain/models"
)

type testAuthJWTVerifier struct {
	verifyCalls int
	claims      *models.SupabaseClaims
	err         error
}

func (v *testAuthJWTVerifier) VerifyToken(_ string) (*models.SupabaseClaims, error) {
	v.verifyCalls++
	if v.err != nil {
		return nil, v.err
	}
	if v.claims == nil {
		return nil, errors.New("no claims")
	}
	return v.claims, nil
}

func (v *testAuthJWTVerifier) Close() error {
	return nil
}

func TestAuthMiddleware_SkipsWebSocketRoutes(t *testing.T) {
	verifier := &testAuthJWTVerifier{}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := AuthMiddleware(verifier)(next)
	req := httptest.NewRequest(http.MethodGet, "/ws/documents/doc-1", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, recorder.Code)
	}
	if !nextCalled {
		t.Fatalf("expected downstream handler to be called")
	}
	if verifier.verifyCalls != 0 {
		t.Fatalf("expected verifier not to run, got %d calls", verifier.verifyCalls)
	}
}

func TestAuthMiddleware_RequiresAuthForAPIRoutes(t *testing.T) {
	verifier := &testAuthJWTVerifier{
		claims: &models.SupabaseClaims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"},
			Role:             "authenticated",
		},
	}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := AuthMiddleware(verifier)(next)
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
	if nextCalled {
		t.Fatalf("downstream handler should not be called without auth header")
	}
	if verifier.verifyCalls != 0 {
		t.Fatalf("expected verifier not to run without auth header, got %d calls", verifier.verifyCalls)
	}
}

func TestAuthMiddleware_DoesNotSkipOtherWebSocketRoutes(t *testing.T) {
	verifier := &testAuthJWTVerifier{
		claims: &models.SupabaseClaims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"},
			Role:             "authenticated",
		},
	}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := AuthMiddleware(verifier)(next)
	req := httptest.NewRequest(http.MethodGet, "/ws/admin", nil)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected status %d, got %d", http.StatusUnauthorized, recorder.Code)
	}
	if nextCalled {
		t.Fatalf("downstream handler should not be called without auth header")
	}
	if verifier.verifyCalls != 0 {
		t.Fatalf("expected verifier not to run without auth header, got %d calls", verifier.verifyCalls)
	}
}
