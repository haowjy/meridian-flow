package models

import "time"

// AuthClaims represents an authenticated user. Pure domain type with no JWT/Supabase imports.
type AuthClaims struct {
	UserID    string
	Email     string
	ExpiresAt *time.Time
}

// GetUserID returns the user ID from the JWT subject claim.
// This is the primary identifier for the authenticated user.
func (c *AuthClaims) GetUserID() string {
	return c.UserID
}
