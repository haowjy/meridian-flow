package handler

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"meridian/internal/config"
	authdomain "meridian/internal/domain/auth"
	billing "meridian/internal/domain/billing"
	"meridian/internal/httputil"
)

type mockAuthCreditGranter struct {
	result  *billing.InitializeSignupCreditsResult
	err     error
	lastReq billing.InitializeSignupCreditsRequest
}

func (m *mockAuthCreditGranter) InitializeSignupCredits(ctx context.Context, req billing.InitializeSignupCreditsRequest) (*billing.InitializeSignupCreditsResult, error) {
	_ = ctx
	m.lastReq = req
	if m.err != nil {
		return nil, m.err
	}
	return m.result, nil
}

func (m *mockAuthCreditGranter) RefreshMonthlyCredits(ctx context.Context, userID string) (*billing.MonthlyRefreshResult, error) {
	_ = ctx
	_ = userID
	return nil, nil
}

func TestAuthHandlerInitialize_Success(t *testing.T) {
	granter := &mockAuthCreditGranter{
		result: &billing.InitializeSignupCreditsResult{
			CreditsGranted:                 100000,
			AlreadyInitialized:             false,
			PromotionalBalanceMillicredits: 200000,
			PurchasedBalanceMillicredits:   50000,
			TotalBalanceMillicredits:       250000,
		},
	}
	h := NewAuthHandler(granter, nil, &config.Config{Server: config.ServerConfig{Environment: "test"}})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/initialize", nil)
	req.RemoteAddr = "203.0.113.5:4321"
	req.Header.Set("User-Agent", "meridian-test")
	req.Header.Set("X-Forwarded-For", "198.51.100.10, 10.0.0.1")
	req = httputil.WithUserID(req, "user-123")
	req = httputil.WithAuthClaims(req, &authdomain.AuthClaims{
		UserID:        "user-123",
		Email:         "writer@example.com",
		AuthProvider:  "google",
		EmailVerified: true,
	})

	rr := httptest.NewRecorder()
	h.Initialize(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusOK)
	}

	if granter.lastReq.UserID != "user-123" {
		t.Fatalf("UserID = %q, want %q", granter.lastReq.UserID, "user-123")
	}
	if granter.lastReq.Email != "writer@example.com" {
		t.Fatalf("Email = %q, want %q", granter.lastReq.Email, "writer@example.com")
	}
	if granter.lastReq.AuthProvider != "google" {
		t.Fatalf("AuthProvider = %q, want %q", granter.lastReq.AuthProvider, "google")
	}
	if !granter.lastReq.EmailVerified {
		t.Fatalf("EmailVerified = false, want true")
	}
	if granter.lastReq.IPAddress != "198.51.100.10" {
		t.Fatalf("IPAddress = %q, want %q", granter.lastReq.IPAddress, "198.51.100.10")
	}
	if granter.lastReq.UserAgent != "meridian-test" {
		t.Fatalf("UserAgent = %q, want %q", granter.lastReq.UserAgent, "meridian-test")
	}

	var body map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("unmarshal response: %v", err)
	}
	if body["credits_granted_millicredits"] != float64(100000) {
		t.Fatalf("credits_granted_millicredits = %v, want %d", body["credits_granted_millicredits"], 100000)
	}
}

func TestAuthHandlerInitialize_MissingClaimsReturnsUnauthorized(t *testing.T) {
	h := NewAuthHandler(&mockAuthCreditGranter{}, nil, &config.Config{Server: config.ServerConfig{Environment: "test"}})
	req := httptest.NewRequest(http.MethodPost, "/api/auth/initialize", nil)
	req = httputil.WithUserID(req, "user-123")

	rr := httptest.NewRecorder()
	h.Initialize(rr, req)

	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusUnauthorized)
	}
}

func TestAuthHandlerInitialize_ServiceErrorHandled(t *testing.T) {
	granter := &mockAuthCreditGranter{err: errors.New("boom")}
	h := NewAuthHandler(granter, nil, &config.Config{Server: config.ServerConfig{Environment: "test"}})

	req := httptest.NewRequest(http.MethodPost, "/api/auth/initialize", nil)
	req = httputil.WithUserID(req, "user-123")
	req = httputil.WithAuthClaims(req, &authdomain.AuthClaims{UserID: "user-123"})

	rr := httptest.NewRecorder()
	h.Initialize(rr, req)

	if rr.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want %d", rr.Code, http.StatusInternalServerError)
	}
}

func TestExtractClientIP_Precedence(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.RemoteAddr = "203.0.113.5:4321"
	req.Header.Set("X-Real-IP", "192.0.2.99")
	req.Header.Set("X-Forwarded-For", "198.51.100.10, 10.0.0.1")

	if got := extractClientIP(req); got != "198.51.100.10" {
		t.Fatalf("extractClientIP() = %q, want %q", got, "198.51.100.10")
	}
}
