package config

import "testing"

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
		Environment:           "prod",
		BlockedProdIdentities: []string{"test-*@my-domain.com", "*@example.com", "cccccccc-cccc-cccc-cccc-cccccccccccc"},
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
		Environment:           "dev",
		BlockedProdIdentities: []string{"*@example.com"},
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
