package handler

import (
	"log/slog"
	"net"
	"net/http"
	"strings"

	"meridian/internal/config"
	billingdomain "meridian/internal/domain/services/billing"
	"meridian/internal/httputil"
)

// AuthHandler handles authentication-adjacent endpoints.
type AuthHandler struct {
	creditGranter billingdomain.CreditGranter
	logger        *slog.Logger
	cfg           *config.Config
}

func NewAuthHandler(
	creditGranter billingdomain.CreditGranter,
	logger *slog.Logger,
	cfg *config.Config,
) *AuthHandler {
	if logger == nil {
		logger = slog.Default()
	}

	return &AuthHandler{
		creditGranter: creditGranter,
		logger:        logger,
		cfg:           cfg,
	}
}

// Initialize grants first-login monthly credits for authenticated users.
// POST /api/auth/initialize
func (h *AuthHandler) Initialize(w http.ResponseWriter, r *http.Request) {
	userID := httputil.GetUserID(r)
	if userID == "" {
		httputil.RespondError(w, http.StatusUnauthorized, "missing authenticated user")
		return
	}

	claims := httputil.GetAuthClaims(r)
	if claims == nil {
		httputil.RespondError(w, http.StatusUnauthorized, "missing auth claims")
		return
	}

	result, err := h.creditGranter.InitializeSignupCredits(r.Context(), billingdomain.InitializeSignupCreditsRequest{
		UserID:        userID,
		Email:         claims.Email,
		AuthProvider:  claims.AuthProvider,
		EmailVerified: claims.EmailVerified,
		IPAddress:     extractClientIP(r),
		UserAgent:     strings.TrimSpace(r.UserAgent()),
	})
	if err != nil {
		handleError(w, err, h.cfg)
		return
	}

	if result == nil {
		result = &billingdomain.InitializeSignupCreditsResult{}
	}

	httputil.RespondJSON(w, http.StatusOK, map[string]interface{}{
		"credits_granted_millicredits":     result.CreditsGranted,
		"already_initialized":              result.AlreadyInitialized,
		"promotional_balance_millicredits": result.PromotionalBalanceMillicredits,
		"purchased_balance_millicredits":   result.PurchasedBalanceMillicredits,
		"total_balance_millicredits":       result.TotalBalanceMillicredits,
	})
}

func extractClientIP(r *http.Request) string {
	if forwarded := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); forwarded != "" {
		parts := strings.Split(forwarded, ",")
		if len(parts) > 0 {
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return ip
			}
		}
	}

	if realIP := strings.TrimSpace(r.Header.Get("X-Real-IP")); realIP != "" {
		return realIP
	}

	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err == nil && host != "" {
		return host
	}

	return strings.TrimSpace(r.RemoteAddr)
}
