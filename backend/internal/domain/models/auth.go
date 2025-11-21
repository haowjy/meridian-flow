package models

import "github.com/golang-jwt/jwt/v5"

// SupabaseClaims represents the JWT claims structure from Supabase Auth.
// See: https://supabase.com/docs/guides/auth/jwts
type SupabaseClaims struct {
	jwt.RegisteredClaims        // Standard JWT claims (sub, iss, aud, exp, iat, etc.)
	Email                string `json:"email"`
	Phone                string `json:"phone"`
	AppMetadata          map[string]interface{} `json:"app_metadata"`
	UserMetadata         map[string]interface{} `json:"user_metadata"`
	Role                 string `json:"role"` // "authenticated" or "anon"
	AAL                  string `json:"aal"`  // Authentication Assurance Level: "aal1" or "aal2"
	AMR                  []map[string]interface{} `json:"amr"` // Authentication Method References
	SessionID            string `json:"session_id"`
	IsAnonymous          bool   `json:"is_anonymous"`
}

// GetUserID returns the user ID from the JWT subject claim.
// This is the primary identifier for the authenticated user.
func (c *SupabaseClaims) GetUserID() string {
	return c.Subject
}
