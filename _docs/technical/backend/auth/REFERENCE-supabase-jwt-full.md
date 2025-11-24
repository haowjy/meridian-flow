---
detail: comprehensive
audience: developer
status: reference
note: "Comprehensive reference - prefer condensed guide: supabase-jwt-implementation.md"
---

# Supabase JWT Authentication - Comprehensive Reference

**Note:** This is a comprehensive reference document with full implementation code. For a condensed implementation guide, see `supabase-jwt-implementation.md`.

**Purpose:** Comprehensive reference for Supabase JWT authentication implementation in the Go backend.

**Target Audience:** Backend engineer implementing authentication

---

## Table of Contents

1. [Context & Current State](#context--current-state)
2. [Why This Implementation](#why-this-implementation)
3. [Approach Decision: RS256 vs HS256](#approach-decision-rs256-vs-hs256)
4. [Implementation Steps](#implementation-steps)
5. [Testing & Validation](#testing--validation)
6. [Security Considerations](#security-considerations)
7. [Migration & Rollout](#migration--rollout)
8. [Reference Links](#reference-links)

---

## Context & Current State

### Current Architecture (Production)

The backend uses **JWT validation via JWKS** for authentication:

```
Request → AuthMiddleware (validates JWT via JWKS) → Handler → Service
```

**Key Files:**
- `backend/internal/middleware/auth.go` - JWT validation middleware
- `backend/internal/auth/jwt_verifier.go` - JWKS-based token verification
- `backend/internal/config/config.go` - Config with Supabase URL
- `backend/internal/httputil/context.go` - User ID extraction
- `backend/cmd/server/main.go` - Middleware chain setup

**How it works:**
1. `AuthMiddleware` validates JWT from Authorization header via JWKS
2. User ID extracted from validated JWT claims
3. User ID injected into request context
4. Handlers call `getUserID(r)` to extract user ID from context
5. Services receive user ID for authorization checks
6. Returns 401 if JWT is missing, invalid, or expired

### Architecture Overview

**Features implemented:**
- ✅ Real JWT authentication via Supabase JWKS
- ✅ Multi-user support (user ID from JWT claims)
- ✅ Token validation (RS256/ES256 signatures)
- ✅ Production-ready security
- ✅ Automatic key refresh via JWKS caching

**Phase 2 requirements:**
- ✅ Validate real users from Supabase Auth
- ✅ Extract user ID from JWT tokens
- ✅ Support multiple users/projects
- ✅ Production-ready security
- ✅ Align with Supabase 2025 best practices

---

## Why This Implementation

### Business Requirements

1. **User Authentication:** Verify users are who they claim to be
2. **Multi-User Support:** Different users access different projects
3. **Security:** Protect user data from unauthorized access
4. **Integration:** Frontend uses Supabase Auth, backend must validate

### Technical Requirements

1. **JWT Validation:** Verify tokens issued by Supabase Auth
2. **User ID Extraction:** Get user ID from JWT `sub` claim
3. **Minimal Code Changes:** Leverage existing middleware architecture
4. **Future-Proof:** Align with Supabase 2025 direction

### Success Criteria

- [ ] Backend validates JWT tokens from Supabase Auth
- [ ] Unauthorized requests return 401
- [ ] User ID correctly extracted and injected into context
- [ ] All existing handlers work without modification
- [ ] Test coverage for auth failures

---

## Approach Decision: RS256 vs HS256

Supabase supports two JWT signing methods. **Choose based on your project creation date.**

### Option 1: RS256 + JWKS (Recommended for New Projects)

**When to use:**
- ✅ Project created after May 1, 2025
- ✅ Want best security practices
- ✅ Planning for production
- ✅ Need automatic key rotation

**How it works:**
```
Frontend Login → Supabase Auth → JWT (signed with private key)
                                    ↓
Backend → Fetch public key from JWKS → Verify signature → Extract claims
```

**Pros:**
- 🔒 More secure (no shared secrets)
- ⚡ Faster (no network call to Supabase for validation)
- 🔄 Automatic key rotation support
- 📈 Future-proof (Supabase's direction)

**Cons:**
- Slightly more complex implementation
- Requires JWKS fetching/caching

**JWKS Endpoint:**
```
https://<project-id>.supabase.co/auth/v1/.well-known/jwks.json
```

### Option 2: HS256 + JWT_SECRET (Legacy but Still Supported)

**When to use:**
- ✅ Project created before May 1, 2025
- ✅ Want simpler implementation
- ✅ Short-term solution (migrate to RS256 by Nov 2025)

**How it works:**
```
Frontend Login → Supabase Auth → JWT (signed with JWT_SECRET)
                                    ↓
Backend → Verify with same JWT_SECRET → Extract claims
```

**Pros:**
- 🎯 Simpler implementation
- ✅ Still officially supported (until Nov 2025)
- 📚 More examples/tutorials available

**Cons:**
- ⚠️ Shared secret (less secure)
- ⏰ Being phased out (migrate by Nov 2025)
- 🔐 Secret leakage risk

**JWT_SECRET Location:**
```
Supabase Dashboard → Settings → API → JWT Secret
```

### Recommendation

| Scenario | Choice |
|----------|--------|
| New project (post May 2025) | **RS256 + JWKS** |
| Legacy project (pre May 2025) | **HS256 + JWT_SECRET** (then migrate) |
| Production-bound in 2025+ | **RS256 + JWKS** |
| Quick prototype/MVP | **HS256 + JWT_SECRET** |

**For this project:** Since you're building for production and aligning with 2025 standards, **I recommend RS256 + JWKS**.

---

## Implementation Steps

### Prerequisites

**Check your Supabase project:**
1. Go to Supabase Dashboard → Settings → API
2. Check if you see "JWKS Endpoint" or "JWT Secret"
3. If JWKS endpoint exists → Use RS256 approach
4. If only JWT Secret exists → Use HS256 approach (migrate later)

---

### Implementation: RS256 + JWKS (Recommended)

#### Step 1: Add Dependencies

```bash
cd backend
go get github.com/golang-jwt/jwt/v5
go get github.com/MicahParks/keyfunc/v3
```

**Why these libraries:**
- `golang-jwt/jwt/v5` - Industry-standard JWT parsing (12,777+ importers)
- `MicahParks/keyfunc/v3` - JWKS fetching and caching for golang-jwt

#### Step 2: Add Configuration

**File:** `backend/internal/config/config.go`

```go
type Config struct {
	Port          string
	Environment   string
	SupabaseURL   string
	SupabaseKey   string  // Existing (anon key for frontend)
	SupabaseDBURL string
	TestUserID    string
	TestProjectID string
	CORSOrigins   string
	TablePrefix   string
	// LLM Configuration
	AnthropicAPIKey string
	DefaultModel    string
	// Debug flags
	Debug bool
	// NEW: JWT Configuration
	SupabaseJWKSURL string // Add this
}

func Load() *Config {
	env := getEnv("ENVIRONMENT", "dev")
	tablePrefix := getTablePrefix(env)
	supabaseURL := getEnv("SUPABASE_URL", "")

	// Construct JWKS URL from Supabase URL
	jwksURL := ""
	if supabaseURL != "" {
		jwksURL = supabaseURL + "/auth/v1/.well-known/jwks.json"
	}

	return &Config{
		Port:          getEnv("PORT", "8080"),
		Environment:   env,
		SupabaseURL:   supabaseURL,
		SupabaseKey:   getEnv("SUPABASE_KEY", ""),
		SupabaseDBURL: getEnv("SUPABASE_DB_URL", ""),
		TestUserID:    getEnv("TEST_USER_ID", "00000000-0000-0000-0000-000000000001"),
		TestProjectID: getEnv("TEST_PROJECT_ID", "00000000-0000-0000-0000-000000000001"),
		CORSOrigins:   getEnv("CORS_ORIGINS", "http://localhost:3000"),
		TablePrefix:   tablePrefix,
		AnthropicAPIKey: getEnv("ANTHROPIC_API_KEY", ""),
		DefaultModel:    getEnv("DEFAULT_MODEL", "moonshotai/kimi-k2-thinking"),
		Debug: getEnv("DEBUG", getDefaultDebug(env)) == "true",
		// NEW: JWKS URL
		SupabaseJWKSURL: getEnv("SUPABASE_JWKS_URL", jwksURL),
	}
}
```

**Why:** Auto-construct JWKS URL from `SUPABASE_URL` (DRY principle)

#### Step 3: Define JWT Claims Struct

**File:** `backend/internal/domain/auth.go` (create new file)

```go
package domain

import "github.com/golang-jwt/jwt/v5"

// SupabaseClaims represents the JWT claims from Supabase Auth
// See: https://supabase.com/docs/guides/auth/jwt-fields
type SupabaseClaims struct {
	jwt.RegisteredClaims                      // iss, sub, aud, exp, iat, nbf
	Email                string               `json:"email"`
	Phone                string               `json:"phone"`
	Role                 string               `json:"role"`        // "authenticated", "anon"
	AAL                  string               `json:"aal"`         // "aal1", "aal2"
	SessionID            string               `json:"session_id"`
	IsAnonymous          bool                 `json:"is_anonymous"`
	AppMetadata          map[string]interface{} `json:"app_metadata,omitempty"`
	UserMetadata         map[string]interface{} `json:"user_metadata,omitempty"`
}

// GetUserID returns the user ID from the sub claim
func (c *SupabaseClaims) GetUserID() string {
	return c.Subject
}
```

**Why:**
- `RegisteredClaims` provides standard JWT fields (exp, iat, etc.)
- Matches Supabase's JWT structure
- Type-safe access to claims

**Reference:** https://supabase.com/docs/guides/auth/jwt-fields

#### Step 4: Create JWT Verifier Service

**File:** `backend/internal/auth/jwt_verifier.go` (create new file/package)

```go
package auth

import (
	"context"
	"fmt"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
	"meridian/internal/domain"
)

// JWTVerifier handles JWT token verification using JWKS
type JWTVerifier struct {
	jwks keyfunc.Keyfunc
}

// NewJWTVerifier creates a new JWT verifier with JWKS
func NewJWTVerifier(jwksURL string) (*JWTVerifier, error) {
	// Configure JWKS with automatic refresh
	options := keyfunc.Options{
		RefreshInterval: 10 * time.Minute, // Supabase caches for 10 min
		RefreshTimeout:  10 * time.Second,
		RefreshErrorHandler: func(err error) {
			fmt.Printf("JWKS refresh error: %v\n", err)
		},
	}

	// Create JWKS from remote URL
	jwks, err := keyfunc.NewDefaultCtx(context.Background(), []string{jwksURL}, options)
	if err != nil {
		return nil, fmt.Errorf("failed to create JWKS: %w", err)
	}

	return &JWTVerifier{jwks: jwks}, nil
}

// VerifyToken verifies a JWT token and returns the claims
func (v *JWTVerifier) VerifyToken(tokenString string) (*domain.SupabaseClaims, error) {
	// Parse and validate token
	token, err := jwt.ParseWithClaims(
		tokenString,
		&domain.SupabaseClaims{},
		v.jwks.Keyfunc,
	)

	if err != nil {
		return nil, fmt.Errorf("failed to parse token: %w", err)
	}

	if !token.Valid {
		return nil, fmt.Errorf("token is invalid")
	}

	// Extract claims
	claims, ok := token.Claims.(*domain.SupabaseClaims)
	if !ok {
		return nil, fmt.Errorf("invalid claims type")
	}

	return claims, nil
}

// Close cleans up the JWKS background refresh
func (v *JWTVerifier) Close() {
	v.jwks.EndBackground()
}
```

**Why:**
- Encapsulates JWT verification logic
- Automatic JWKS refresh every 10 minutes (matches Supabase cache)
- Error handling for network issues
- Reusable across middleware

**Reference:** https://github.com/MicahParks/keyfunc

#### Step 5: Update Auth Middleware

**File:** `backend/internal/middleware/auth.go`

```go
package middleware

import (
	"fmt"
	"net/http"
	"strings"

	"meridian/internal/auth"
	"meridian/internal/httputil"
)

// AuthMiddleware validates Supabase JWT tokens and injects user ID into context
func AuthMiddleware(jwtVerifier *auth.JWTVerifier) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				httputil.RespondError(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			// Expected format: "Bearer <token>"
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				httputil.RespondError(w, http.StatusUnauthorized, "invalid authorization header format")
				return
			}

			tokenString := parts[1]

			// Verify token and extract claims
			claims, err := jwtVerifier.VerifyToken(tokenString)
			if err != nil {
				httputil.RespondError(w, http.StatusUnauthorized, fmt.Sprintf("invalid token: %v", err))
				return
			}

			// Inject user ID into context
			userID := claims.GetUserID()
			r = httputil.WithUserID(r, userID)

			next.ServeHTTP(w, r)
		})
	}
}
```

**Why:**
- Validates JWT signature using JWKS public keys
- Checks token expiration automatically (via `jwt.ParseWithClaims`)
- Extracts user ID and injects into context (matches existing pattern)
- Returns 401 for any validation failure

**Changes from Phase 1:**
- No longer uses test user ID
- Validates real JWT tokens
- Same interface → handlers don't need changes

#### Step 6: Update Server Initialization

**File:** `backend/cmd/server/main.go`

```go
package main

import (
	"database/sql"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"

	"github.com/joho/godotenv"
	"github.com/rs/cors"

	"meridian/internal/auth"     // NEW
	"meridian/internal/config"
	"meridian/internal/handler"
	"meridian/internal/middleware"
	"meridian/internal/repository/postgres"
	"meridian/internal/service"
)

func main() {
	// Load environment variables
	if err := godotenv.Load(); err != nil {
		log.Printf("Warning: .env file not found")
	}

	// Load config
	cfg := config.Load()

	// Connect to database
	db, err := sql.Open("pgx", cfg.SupabaseDBURL)
	if err != nil {
		log.Fatal("Failed to connect to database:", err)
	}
	defer db.Close()

	// NEW: Initialize JWT verifier
	jwtVerifier, err := auth.NewJWTVerifier(cfg.SupabaseJWKSURL)
	if err != nil {
		log.Fatal("Failed to create JWT verifier:", err)
	}
	defer jwtVerifier.Close()

	// Initialize repositories
	documentRepo := postgres.NewDocumentRepository(db, cfg.TablePrefix)
	folderRepo := postgres.NewFolderRepository(db, cfg.TablePrefix)
	// ... other repos

	// Initialize services
	documentService := service.NewDocumentService(documentRepo, folderRepo)
	// ... other services

	// Initialize handlers
	documentHandler := handler.NewDocumentHandler(documentService)
	// ... other handlers

	// Create router
	mux := http.NewServeMux()
	documentHandler.RegisterRoutes(mux)
	// ... register other routes

	// Apply middleware (reverse order)
	var httpHandler http.Handler = mux
	httpHandler = middleware.ProjectMiddleware(cfg.TestProjectID)(httpHandler)
	httpHandler = middleware.AuthMiddleware(jwtVerifier)(httpHandler)  // CHANGED
	httpHandler = middleware.Recovery()(httpHandler)

	// CORS
	corsHandler := cors.New(cors.Options{
		AllowedOrigins:   strings.Split(cfg.CORSOrigins, ","),
		AllowedMethods:   []string{"GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"},
		AllowedHeaders:   []string{"Authorization", "Content-Type", "Accept", "Origin"},
		AllowCredentials: true,
	}).Handler(httpHandler)

	// Start server
	addr := ":" + cfg.Port
	log.Printf("Server starting on %s", addr)
	if err := http.ListenAndServe(addr, corsHandler); err != nil {
		log.Fatal("Server failed:", err)
	}
}
```

**Changes:**
1. Import `meridian/internal/auth` package
2. Create `jwtVerifier` from JWKS URL
3. Pass `jwtVerifier` to `AuthMiddleware` (instead of test user ID)
4. Close verifier on shutdown

#### Step 7: Update Environment Variables

**File:** `backend/.env`

```bash
# Existing
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key  # Frontend uses this
SUPABASE_DB_URL=postgresql://postgres:[password]@db.[project].supabase.co:6543/postgres

# NEW (optional - auto-constructed from SUPABASE_URL)
# SUPABASE_JWKS_URL=https://your-project.supabase.co/auth/v1/.well-known/jwks.json
```

**Why:**
- JWKS URL auto-constructed from `SUPABASE_URL` → DRY
- Override available if needed (e.g., custom auth server)

---

### Implementation: HS256 + JWT_SECRET (Legacy Alternative)

If your project uses legacy JWT_SECRET instead of JWKS, follow these steps instead:

#### Step 1: Add Dependencies

```bash
cd backend
go get github.com/golang-jwt/jwt/v5
```

#### Step 2: Add Configuration

**File:** `backend/internal/config/config.go`

```go
type Config struct {
	// ... existing fields ...
	SupabaseJWTSecret string // Add this
}

func Load() *Config {
	return &Config{
		// ... existing fields ...
		SupabaseJWTSecret: getEnv("SUPABASE_JWT_SECRET", ""),
	}
}
```

#### Step 3: Define JWT Claims

Same as RS256 approach - use `backend/internal/domain/auth.go` from Step 3 above.

#### Step 4: Update Auth Middleware (HS256 Version)

**File:** `backend/internal/middleware/auth.go`

```go
package middleware

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/golang-jwt/jwt/v5"
	"meridian/internal/domain"
	"meridian/internal/httputil"
)

// AuthMiddleware validates Supabase JWT tokens using JWT_SECRET
func AuthMiddleware(jwtSecret string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract token from Authorization header
			authHeader := r.Header.Get("Authorization")
			if authHeader == "" {
				httputil.RespondError(w, http.StatusUnauthorized, "missing authorization header")
				return
			}

			// Expected format: "Bearer <token>"
			parts := strings.SplitN(authHeader, " ", 2)
			if len(parts) != 2 || parts[0] != "Bearer" {
				httputil.RespondError(w, http.StatusUnauthorized, "invalid authorization header format")
				return
			}

			tokenString := parts[1]

			// Parse and validate token
			token, err := jwt.ParseWithClaims(tokenString, &domain.SupabaseClaims{}, func(token *jwt.Token) (interface{}, error) {
				// Validate signing method (prevent algorithm confusion attack)
				if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
					return nil, fmt.Errorf("unexpected signing method: %v", token.Header["alg"])
				}
				return []byte(jwtSecret), nil
			})

			if err != nil {
				httputil.RespondError(w, http.StatusUnauthorized, fmt.Sprintf("invalid token: %v", err))
				return
			}

			if !token.Valid {
				httputil.RespondError(w, http.StatusUnauthorized, "token is not valid")
				return
			}

			// Extract claims
			claims, ok := token.Claims.(*domain.SupabaseClaims)
			if !ok {
				httputil.RespondError(w, http.StatusUnauthorized, "invalid token claims")
				return
			}

			// Inject user ID into context
			r = httputil.WithUserID(r, claims.GetUserID())
			next.ServeHTTP(w, r)
		})
	}
}
```

#### Step 5: Update Server Initialization (HS256 Version)

**File:** `backend/cmd/server/main.go`

```go
// Replace this line:
httpHandler = middleware.AuthMiddleware(cfg.TestUserID)(httpHandler)

// With this:
httpHandler = middleware.AuthMiddleware(cfg.SupabaseJWTSecret)(httpHandler)
```

#### Step 6: Update Environment Variables

**File:** `backend/.env`

```bash
# Existing
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_DB_URL=postgresql://...

# NEW - Get from Supabase Dashboard → Settings → API → JWT Secret
SUPABASE_JWT_SECRET=your-jwt-secret-here
```

**Where to find JWT Secret:**
1. Supabase Dashboard → Project Settings → API
2. Scroll to "JWT Settings"
3. Copy "JWT Secret" (long base64 string)

---

## Testing & Validation

### Unit Tests

**File:** `backend/internal/middleware/auth_test.go` (create new)

```go
package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"meridian/internal/auth"
	"meridian/internal/middleware"
)

func TestAuthMiddleware_MissingHeader(t *testing.T) {
	// Setup
	verifier, _ := auth.NewJWTVerifier("https://test.supabase.co/.well-known/jwks.json")
	handler := middleware.AuthMiddleware(verifier)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Test
	req := httptest.NewRequest("GET", "/test", nil)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Assert
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

func TestAuthMiddleware_InvalidFormat(t *testing.T) {
	// Setup
	verifier, _ := auth.NewJWTVerifier("https://test.supabase.co/.well-known/jwks.json")
	handler := middleware.AuthMiddleware(verifier)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))

	// Test - missing "Bearer" prefix
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "some-token")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)

	// Assert
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", rec.Code)
	}
}

// Add more tests for:
// - Invalid token
// - Expired token
// - Valid token (requires mock JWKS or test token)
```

### Integration Tests

**Test with real Supabase token:**

```bash
# 1. Get a token from your frontend or Supabase Auth
# (login via Supabase Auth UI or use supabase-js client)

# 2. Export token
export TOKEN="eyJhbGci..."

# 3. Test protected endpoint
curl -v \
  -H "Authorization: Bearer $TOKEN" \
  http://localhost:8080/api/documents

# Expected: 200 OK (if token valid)
```

### Test Cases

| Test Case | Expected Result |
|-----------|----------------|
| No Authorization header | 401 Unauthorized |
| Wrong header format (no "Bearer") | 401 Unauthorized |
| Invalid token signature | 401 Unauthorized |
| Expired token | 401 Unauthorized |
| Valid token | User ID extracted, request proceeds |
| Token from different Supabase project | 401 Unauthorized |

### Manual Testing Checklist

- [ ] Start backend server
- [ ] Login via frontend (get JWT token)
- [ ] Call protected endpoint with valid token → 200 OK
- [ ] Call without Authorization header → 401
- [ ] Call with malformed header → 401
- [ ] Call with expired token → 401
- [ ] Verify user ID is correct in backend logs
- [ ] Test multiple users (different tokens)

---

## Security Considerations

### Token Security

1. **HTTPS in Production**
   - Always use HTTPS to prevent token interception
   - Tokens in HTTP headers are vulnerable to man-in-the-middle attacks

2. **Token Expiration**
   - Supabase default: 1 hour (configurable)
   - Short expiration reduces risk of token theft
   - Frontend should handle token refresh automatically

3. **Secret Management**
   - **NEVER commit secrets to Git** (use `.env`, add to `.gitignore`)
   - **NEVER expose JWT_SECRET in frontend code**
   - Use environment variables in production (Railway secrets, etc.)

4. **Algorithm Validation**
   - Always validate signing algorithm (prevents algorithm confusion attacks)
   - Code explicitly checks for HMAC (HS256) or RSA (RS256)

### Common Vulnerabilities

| Vulnerability | Mitigation |
|---------------|------------|
| Algorithm confusion | Validate `token.Method` before verification |
| Token replay | Use short expiration + HTTPS |
| Secret leakage | Environment variables + .gitignore |
| XSS token theft | Frontend: use httpOnly cookies (if possible) |
| Missing validation | Always check `token.Valid` after parsing |

### Best Practices

1. **Validate Everything**
   ```go
   // ✅ Good
   if !token.Valid {
       return error
   }

   // ❌ Bad - assumes token is valid
   claims := token.Claims.(*SupabaseClaims)
   ```

2. **Explicit Algorithm Check**
   ```go
   // ✅ Good
   if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
       return error
   }

   // ❌ Bad - accepts any algorithm
   return []byte(secret), nil
   ```

3. **Error Messages**
   ```go
   // ✅ Good - generic message
   return "unauthorized"

   // ❌ Bad - reveals implementation details
   return "JWT signature invalid: " + err.Error()
   ```

---

## Migration & Rollout

### Gradual Rollout Strategy

**Option 1: Environment-based toggle**

```go
// cmd/server/main.go

if cfg.Environment == "dev" && cfg.TestUserID != "" {
    // Use test auth for local development
    httpHandler = middleware.AuthMiddleware(cfg.TestUserID)(httpHandler)
} else {
    // Use real JWT auth for staging/production
    jwtVerifier, err := auth.NewJWTVerifier(cfg.SupabaseJWKSURL)
    if err != nil {
        log.Fatal("Failed to create JWT verifier:", err)
    }
    defer jwtVerifier.Close()
    httpHandler = middleware.AuthMiddleware(jwtVerifier)(httpHandler)
}
```

**Option 2: Feature flag**

```bash
# .env
USE_REAL_AUTH=true  # false for test auth
```

### Deployment Checklist

**Before Deployment:**
- [ ] Add `SUPABASE_JWKS_URL` (or `SUPABASE_JWT_SECRET`) to production env vars
- [ ] Verify JWKS endpoint is accessible from production (test with `curl`)
- [ ] Update frontend to send `Authorization: Bearer <token>` header
- [ ] Test with real Supabase tokens in staging environment
- [ ] Add monitoring/logging for auth failures

**During Deployment:**
- [ ] Deploy backend with new auth code
- [ ] Deploy frontend with token-sending code
- [ ] Monitor error logs for auth failures
- [ ] Test login flow end-to-end

**After Deployment:**
- [ ] Verify users can authenticate
- [ ] Check 401 errors for unauthenticated requests
- [ ] Monitor for unusual auth patterns
- [ ] Remove test user middleware code

### Rollback Plan

If issues occur:

1. **Backend rollback:**
   ```bash
   git revert <auth-commit>
   # Redeploy
   ```

2. **Environment variable rollback:**
   ```bash
   # Temporarily re-enable test auth
   USE_REAL_AUTH=false
   ```

3. **Verify:**
   - Test endpoints work with test user ID
   - Check database connections still work
   - Verify no auth-related errors

---

## Reference Links

### Official Supabase Documentation

- **JWT Overview:** https://supabase.com/docs/guides/auth/jwts
- **JWT Claims Reference:** https://supabase.com/docs/guides/auth/jwt-fields
- **JWT Signing Keys (RS256):** https://supabase.com/docs/guides/auth/signing-keys
- **Server-Side Auth Guide:** https://supabase.com/docs/guides/auth/server-side
- **Auth Architecture:** https://supabase.com/docs/guides/auth/architecture

### Go Libraries

- **golang-jwt/jwt (v5):** https://pkg.go.dev/github.com/golang-jwt/jwt/v5
- **MicahParks/keyfunc (JWKS):** https://github.com/MicahParks/keyfunc
- **Go JWT Tutorial:** https://golang-jwt.github.io/jwt/usage/create/

### Community Resources

- **Supabase + Go Backend Example:** https://depshub.com/blog/using-supabase-auth-as-a-service-with-a-custom-backend/
- **StackOverflow: Supabase JWT Go:** https://stackoverflow.com/questions/74711755/how-to-connect-supabase-with-my-golang-for-jwt-token-verification-api-from-supab
- **GitHub Discussions:** https://github.com/orgs/supabase/discussions/29289

### Security

- **OWASP JWT Security:** https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
- **Algorithm Confusion Attack:** https://auth0.com/blog/critical-vulnerabilities-in-json-web-token-libraries/
- **JWT Best Practices:** https://tools.ietf.org/html/rfc8725

### Supabase 2025 Changes

- **API Keys Migration:** https://github.com/orgs/supabase/discussions/29260
- **Asymmetric Keys Announcement:** https://dev.to/kvetoslavnovak/supabase-auth-itroduces-asymmetric-jwts-4i4e
- **RS256 Support Discussion:** https://github.com/orgs/supabase/discussions/12759

---

## Appendix: Troubleshooting

### Common Errors

**Error:** `failed to create JWKS: connection refused`
- **Cause:** JWKS URL unreachable
- **Fix:** Check `SUPABASE_URL` is correct, verify network access

**Error:** `unexpected signing method: HS256`
- **Cause:** Project uses HS256 but code expects RS256
- **Fix:** Use HS256 implementation (legacy approach)

**Error:** `token is expired`
- **Cause:** Frontend token expired (default 1 hour)
- **Fix:** Implement token refresh in frontend

**Error:** `sub claim not found`
- **Cause:** Token not from Supabase Auth
- **Fix:** Verify token source, check Supabase Auth integration

### Debugging Tips

1. **Log token claims:**
   ```go
   claims, _ := jwtVerifier.VerifyToken(tokenString)
   log.Printf("User ID: %s, Email: %s", claims.GetUserID(), claims.Email)
   ```

2. **Decode token locally:**
   ```bash
   # Install jwt-cli: https://github.com/mike-engel/jwt-cli
   jwt decode <token>
   ```

3. **Verify JWKS endpoint:**
   ```bash
   curl https://your-project.supabase.co/auth/v1/.well-known/jwks.json
   ```

4. **Test token in jwt.io:**
   - Go to https://jwt.io
   - Paste token
   - Check claims structure

---

## Summary

**What we're building:**
- Replace test auth middleware with real Supabase JWT validation
- Extract user ID from JWT tokens
- Maintain existing handler architecture (no handler changes needed)

**Why RS256 + JWKS (recommended):**
- ✅ Future-proof (Supabase's 2025 direction)
- ✅ More secure (no shared secrets)
- ✅ Automatic key rotation
- ✅ Production-ready

**Why HS256 + JWT_SECRET (legacy):**
- ✅ Simpler implementation
- ✅ Works for older projects
- ⚠️ Must migrate to RS256 by Nov 2025

**Implementation time:** 4-6 hours (including testing)

**Questions?** Check reference links or Supabase Discord: https://discord.supabase.com
