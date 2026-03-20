package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"meridian/internal/domain"
	"meridian/internal/domain/models"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

// SupabaseJWTVerifier implements JWTVerifier using JWKS from Supabase.
type SupabaseJWTVerifier struct {
	jwks   keyfunc.Keyfunc
	logger *slog.Logger
}

// NewJWTVerifier creates a new JWT verifier that fetches public keys from Supabase's JWKS endpoint.
// The JWKS keys are cached and automatically refreshed based on HTTP cache headers.
func NewJWTVerifier(jwksURL string, logger *slog.Logger) (JWTVerifier, error) {
	if jwksURL == "" {
		return nil, errors.New("JWKS URL cannot be empty")
	}

	// Create JWKS client with default settings
	// keyfunc v3 automatically handles caching and refresh based on HTTP cache headers
	ctx := context.Background()
	jwks, err := keyfunc.NewDefaultCtx(ctx, []string{jwksURL})
	if err != nil {
		return nil, fmt.Errorf("failed to create JWKS client: %w", err)
	}

	logger.Info("JWT verifier initialized", "jwks_url", jwksURL)

	return &SupabaseJWTVerifier{
		jwks:   jwks,
		logger: logger,
	}, nil
}

// VerifyToken validates a JWT token and extracts auth claims.
// Returns an error if the token is invalid, expired, or has incorrect claims.
func (v *SupabaseJWTVerifier) VerifyToken(tokenString string) (*models.AuthClaims, error) {
	// Parse and validate the token
	token, err := jwt.ParseWithClaims(tokenString, &SupabaseClaims{}, v.jwks.Keyfunc)
	if err != nil {
		// Invalid/expired tokens are expected in normal operation (e.g., client refresh, bad auth header).
		// Avoid logging at ERROR to prevent noisy logs and accidental PII exposure.
		v.logger.Debug("jwt parse failed", "error", err)
		return nil, domain.ErrUnauthorized
	}

	// Validate token is valid and signed correctly
	if !token.Valid {
		v.logger.Debug("jwt token invalid after parsing")
		return nil, domain.ErrUnauthorized
	}

	// Prevent algorithm confusion attacks - allow only RS256 or ES256
	switch token.Method.Alg() {
	case "RS256", "ES256":
		// allowed
	default:
		v.logger.Warn("Token uses unexpected algorithm", "algorithm", token.Method.Alg(), "allowed", []string{"RS256", "ES256"})
		return nil, domain.ErrUnauthorized
	}

	// Extract claims
	claims, ok := token.Claims.(*SupabaseClaims)
	if !ok {
		v.logger.Debug("failed to extract claims from token")
		return nil, domain.ErrUnauthorized
	}

	// Validate user ID exists (sub claim)
	if claims.Subject == "" {
		v.logger.Debug("Token missing subject claim")
		return nil, domain.ErrUnauthorized
	}

	// Validate role is "authenticated" (reject anonymous tokens)
	if claims.Role != "authenticated" {
		v.logger.Debug("jwt token has invalid role",
			"role", claims.Role,
			"expected", "authenticated",
		)
		return nil, domain.ErrUnauthorized
	}

	var expiresAt *time.Time
	if claims.ExpiresAt != nil {
		expiry := claims.ExpiresAt.Time
		expiresAt = &expiry
	}

	return &models.AuthClaims{
		UserID:    claims.Subject,
		Email:     claims.Email,
		ExpiresAt: expiresAt,
	}, nil
}

// Close releases resources held by the JWT verifier.
// In keyfunc v3, the library manages its own resources based on HTTP cache headers,
// so this is a no-op for graceful shutdown compatibility.
func (v *SupabaseJWTVerifier) Close() error {
	v.logger.Debug("JWT verifier closed")
	return nil
}
