package config

import (
	"os"
	"testing"
)

func TestLoad_DBPoolDefaultsOnInvalidEnv(t *testing.T) {
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")
	t.Setenv("SUPABASE_DB_URL", "postgres://localhost/test")

	// Invalid ints should fall back to defaults
	t.Setenv("DB_MAX_CONNS", "not-a-number")
	t.Setenv("DB_MIN_CONNS", "also-not-a-number")

	cfg := Load()
	if cfg.Database.MaxConns != 25 {
		t.Fatalf("Database.MaxConns default mismatch: got %d, want %d", cfg.Database.MaxConns, 25)
	}
	if cfg.Database.MinConns != 5 {
		t.Fatalf("Database.MinConns default mismatch: got %d, want %d", cfg.Database.MinConns, 5)
	}
}

func TestLoad_DBPoolReadsValidEnv(t *testing.T) {
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")
	t.Setenv("SUPABASE_DB_URL", "postgres://localhost/test")

	t.Setenv("DB_MAX_CONNS", "12")
	t.Setenv("DB_MIN_CONNS", "3")

	cfg := Load()
	if cfg.Database.MaxConns != 12 {
		t.Fatalf("Database.MaxConns mismatch: got %d, want %d", cfg.Database.MaxConns, 12)
	}
	if cfg.Database.MinConns != 3 {
		t.Fatalf("Database.MinConns mismatch: got %d, want %d", cfg.Database.MinConns, 3)
	}
}

func TestLoad_DBPoolDoesNotRequireOptionalEnv(t *testing.T) {
	// Ensure this test doesn't inherit env from other tests
	_ = os.Unsetenv("DB_MAX_CONNS")
	_ = os.Unsetenv("DB_MIN_CONNS")
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")
	t.Setenv("SUPABASE_DB_URL", "postgres://localhost/test")

	cfg := Load()
	if cfg.Database.MaxConns == 0 || cfg.Database.MinConns == 0 {
		t.Fatalf("expected non-zero defaults for DB pool settings, got max=%d min=%d", cfg.Database.MaxConns, cfg.Database.MinConns)
	}
}

func TestCompleteDefaults_JWKSURL(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{Environment: "dev"},
		Auth:   AuthConfig{SupabaseURL: "https://example.supabase.co"},
	}
	cfg.CompleteDefaults()

	want := "https://example.supabase.co/auth/v1/.well-known/jwks.json"
	if cfg.Auth.SupabaseJWKSURL != want {
		t.Fatalf("JWKS URL mismatch: got %q, want %q", cfg.Auth.SupabaseJWKSURL, want)
	}
}

func TestCompleteDefaults_DebugDefaultsByEnv(t *testing.T) {
	// Ensure no override
	_ = os.Unsetenv("DEBUG")

	tests := []struct {
		env  string
		want bool
	}{
		{"dev", true},
		{"test", true},
		{"prod", false},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := &Config{Server: ServerConfig{Environment: tt.env}}
			cfg.CompleteDefaults()
			if cfg.Server.Debug != tt.want {
				t.Fatalf("Debug for env %q: got %v, want %v", tt.env, cfg.Server.Debug, tt.want)
			}
		})
	}
}

func TestCompleteDefaults_LogLevelDefaultsByEnv(t *testing.T) {
	_ = os.Unsetenv("LOG_LEVEL")

	tests := []struct {
		env  string
		want string
	}{
		{"dev", "debug"},
		{"prod", "info"},
		{"test", "info"},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := &Config{Server: ServerConfig{Environment: tt.env}}
			cfg.CompleteDefaults()
			if cfg.Logging.Level != tt.want {
				t.Fatalf("LogLevel for env %q: got %q, want %q", tt.env, cfg.Logging.Level, tt.want)
			}
		})
	}
}

func TestValidate_PoolSanity(t *testing.T) {
	cfg := &Config{
		Server:   ServerConfig{Environment: "dev"},
		Database: DatabaseConfig{URL: "postgres://localhost/test", MinConns: 30, MaxConns: 10},
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("expected validation error for MinConns > MaxConns, got nil")
	}
}

func TestValidate_PoolSanity_OK(t *testing.T) {
	cfg := &Config{
		Server:   ServerConfig{Environment: "dev"},
		Database: DatabaseConfig{URL: "postgres://localhost/test", MinConns: 5, MaxConns: 25},
	}
	if err := cfg.Validate(); err != nil {
		t.Fatalf("expected no validation error, got %v", err)
	}
}

func TestIsProd(t *testing.T) {
	tests := []struct {
		env  string
		want bool
	}{
		{"prod", true},
		{"dev", false},
		{"test", false},
	}
	for _, tt := range tests {
		t.Run(tt.env, func(t *testing.T) {
			cfg := &Config{Server: ServerConfig{Environment: tt.env}}
			if cfg.IsProd() != tt.want {
				t.Fatalf("IsProd() for env %q: got %v, want %v", tt.env, cfg.IsProd(), tt.want)
			}
		})
	}
}

func TestGetEnvListNormalized_ParsesCommaSeparatedValues(t *testing.T) {
	t.Setenv("BLOCKED_PROD_IDENTITIES", " test-*@my-domain.com , *@example.com ,, ")

	got := getEnvListNormalized("BLOCKED_PROD_IDENTITIES")
	if len(got) != 2 {
		t.Fatalf("expected 2 entries, got %d", len(got))
	}
	if got[0] != "test-*@my-domain.com" {
		t.Fatalf("expected first pattern, got %q", got[0])
	}
	if got[1] != "*@example.com" {
		t.Fatalf("expected second pattern, got %q", got[1])
	}
}

func TestConfig_IsProdIdentityBlocked(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{Environment: "prod"},
		Auth: AuthConfig{
			BlockedProdIdentities: []string{"test-*@my-domain.com", "*@example.com", "cccccccc-cccc-cccc-cccc-cccccccccccc"},
		},
	}

	if !cfg.IsProdIdentityBlocked("user-1", "test-9@my-domain.com") {
		t.Fatalf("expected wildcard email block")
	}
	if !cfg.IsProdIdentityBlocked("user-2", "hello@example.com") {
		t.Fatalf("expected domain wildcard email block")
	}
	if !cfg.IsProdIdentityBlocked("cccccccc-cccc-cccc-cccc-cccccccccccc", "ok@safe.com") {
		t.Fatalf("expected user id block")
	}
	if cfg.IsProdIdentityBlocked("user-3", "writer@safe.com") {
		t.Fatalf("expected unmatched identity to be allowed")
	}
}

func TestConfig_IsProdIdentityBlocked_OnlyAppliesInProd(t *testing.T) {
	cfg := &Config{
		Server: ServerConfig{Environment: "dev"},
		Auth: AuthConfig{
			BlockedProdIdentities: []string{"*@example.com"},
		},
	}

	if cfg.IsProdIdentityBlocked("user-1", "test@example.com") {
		t.Fatalf("expected denylist to be ignored outside prod")
	}
}

func TestWildcardMatch(t *testing.T) {
	tests := []struct {
		pattern string
		value   string
		match   bool
	}{
		{pattern: "test-*@my-domain.com", value: "test-1@my-domain.com", match: true},
		{pattern: "*@example.com", value: "foo@example.com", match: true},
		{pattern: "*@example.com", value: "foo@sub.example.com", match: false},
		{pattern: "abc*", value: "abcdef", match: true},
		{pattern: "abc*", value: "ab", match: false},
	}

	for _, tc := range tests {
		if got := wildcardMatch(tc.pattern, tc.value); got != tc.match {
			t.Fatalf("pattern %q value %q expected %v, got %v", tc.pattern, tc.value, tc.match, got)
		}
	}
}
