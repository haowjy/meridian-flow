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

	handler := AuthMiddleware(verifier, nil)(next)
	req := httptest.NewRequest(http.MethodGet, "/ws/projects/proj-1", nil)
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

	handler := AuthMiddleware(verifier, nil)(next)
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

	handler := AuthMiddleware(verifier, nil)(next)
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

func TestAuthMiddleware_RejectsBlockedUser(t *testing.T) {
	const blockedUserID = "blocked-user-id"
	verifier := &testAuthJWTVerifier{
		claims: &models.SupabaseClaims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: blockedUserID},
			Role:             "authenticated",
		},
	}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := AuthMiddleware(verifier, func(userID, _ string) bool {
		return userID == blockedUserID
	})(next)
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, recorder.Code)
	}
	if nextCalled {
		t.Fatalf("downstream handler should not be called for blocked users")
	}
	if verifier.verifyCalls != 1 {
		t.Fatalf("expected verifier to run once, got %d calls", verifier.verifyCalls)
	}
}

func TestAuthMiddleware_AllowsUnblockedUser(t *testing.T) {
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

	handler := AuthMiddleware(verifier, func(_, _ string) bool { return false })(next)
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusNoContent {
		t.Fatalf("expected status %d, got %d", http.StatusNoContent, recorder.Code)
	}
	if !nextCalled {
		t.Fatalf("expected downstream handler to be called")
	}
	if verifier.verifyCalls != 1 {
		t.Fatalf("expected verifier to run once, got %d calls", verifier.verifyCalls)
	}
}

func TestAuthMiddleware_RejectsBlockedEmailPattern(t *testing.T) {
	verifier := &testAuthJWTVerifier{
		claims: &models.SupabaseClaims{
			RegisteredClaims: jwt.RegisteredClaims{Subject: "user-1"},
			Email:            "test-42@my-domain.com",
			Role:             "authenticated",
		},
	}
	nextCalled := false
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusNoContent)
	})

	handler := AuthMiddleware(verifier, func(_, email string) bool {
		return email == "test-42@my-domain.com"
	})(next)
	req := httptest.NewRequest(http.MethodGet, "/api/projects", nil)
	req.Header.Set("Authorization", "Bearer valid-token")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, req)

	if recorder.Code != http.StatusForbidden {
		t.Fatalf("expected status %d, got %d", http.StatusForbidden, recorder.Code)
	}
	if nextCalled {
		t.Fatalf("downstream handler should not be called for blocked email")
	}
}
