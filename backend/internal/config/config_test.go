package config

import (
	"os"
	"testing"
)

func TestLoad_DBPoolDefaultsOnInvalidEnv(t *testing.T) {
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")

	// Invalid ints should fall back to defaults
	t.Setenv("DB_MAX_CONNS", "not-a-number")
	t.Setenv("DB_MIN_CONNS", "also-not-a-number")

	cfg := Load()
	if cfg.DBMaxConns != 25 {
		t.Fatalf("DBMaxConns default mismatch: got %d, want %d", cfg.DBMaxConns, 25)
	}
	if cfg.DBMinConns != 5 {
		t.Fatalf("DBMinConns default mismatch: got %d, want %d", cfg.DBMinConns, 5)
	}
}

func TestLoad_DBPoolReadsValidEnv(t *testing.T) {
	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")

	t.Setenv("DB_MAX_CONNS", "12")
	t.Setenv("DB_MIN_CONNS", "3")

	cfg := Load()
	if cfg.DBMaxConns != 12 {
		t.Fatalf("DBMaxConns mismatch: got %d, want %d", cfg.DBMaxConns, 12)
	}
	if cfg.DBMinConns != 3 {
		t.Fatalf("DBMinConns mismatch: got %d, want %d", cfg.DBMinConns, 3)
	}
}

func TestLoad_DBPoolDoesNotRequireOptionalEnv(t *testing.T) {
	// Ensure this test doesn't inherit env from other tests
	_ = os.Unsetenv("DB_MAX_CONNS")
	_ = os.Unsetenv("DB_MIN_CONNS")

	t.Setenv("ENVIRONMENT", "dev")
	t.Setenv("SUPABASE_URL", "https://example.supabase.co")

	cfg := Load()
	if cfg.DBMaxConns == 0 || cfg.DBMinConns == 0 {
		t.Fatalf("expected non-zero defaults for DB pool settings, got max=%d min=%d", cfg.DBMaxConns, cfg.DBMinConns)
	}
}

