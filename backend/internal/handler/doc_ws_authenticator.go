package handler

import (
	"context"
	"fmt"

	"meridian/internal/auth"
	authdomain "meridian/internal/domain/auth"
	"meridian/internal/wsutil"
)

var _ wsutil.Authenticator = (*docWSAuthenticator)(nil)

type docWSAuthenticator struct {
	jwtVerifier       auth.JWTVerifier
	authorizer        authdomain.ResourceAuthorizer
	isIdentityBlocked IdentityBlockChecker
}

func NewDocWSAuthenticator(
	jwtVerifier auth.JWTVerifier,
	authorizer authdomain.ResourceAuthorizer,
	isIdentityBlocked IdentityBlockChecker,
) wsutil.Authenticator {
	return &docWSAuthenticator{
		jwtVerifier:       jwtVerifier,
		authorizer:        authorizer,
		isIdentityBlocked: isIdentityBlocked,
	}
}

func (a *docWSAuthenticator) Authenticate(token string) (*wsutil.AuthResult, error) {
	if a.jwtVerifier == nil {
		return nil, fmt.Errorf("jwt verifier unavailable")
	}

	result, err := authenticateToken(token, a.jwtVerifier, a.isIdentityBlocked)
	if err != nil {
		return nil, err
	}

	return &wsutil.AuthResult{
		UserID:    result.UserID,
		ExpiresAt: result.JWTExpiry,
	}, nil
}

func (a *docWSAuthenticator) CheckProjectAccess(ctx context.Context, userID, projectID string) error {
	if a.authorizer == nil {
		return fmt.Errorf("failed to verify project access")
	}

	return a.authorizer.CanAccessProject(ctx, userID, projectID)
}
