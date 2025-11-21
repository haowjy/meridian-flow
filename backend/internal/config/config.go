package config

import (
	"os"
)

type Config struct {
	Port            string
	Environment     string
	SupabaseURL     string
	SupabaseKey     string
	SupabaseDBURL   string
	SupabaseJWKSURL string // Constructed from SupabaseURL + /auth/v1/.well-known/jwks.json
	CORSOrigins     string
	TablePrefix     string
	// LLM Configuration
	AnthropicAPIKey  string
	OpenRouterAPIKey string
	DefaultProvider  string
	DefaultModel     string
	// Debug flags
	Debug bool // Enables DEBUG features like SSE event IDs
}

func Load() *Config {
	env := getEnv("ENVIRONMENT", "dev")
	tablePrefix := getTablePrefix(env)
	supabaseURL := getEnv("SUPABASE_URL", "")

	// Construct JWKS URL from Supabase URL
	jwksURL := supabaseURL + "/auth/v1/.well-known/jwks.json"

	return &Config{
		Port:            getEnv("PORT", "8080"),
		Environment:     env,
		SupabaseURL:     supabaseURL,
		SupabaseKey:     getEnv("SUPABASE_KEY", ""),
		SupabaseDBURL:   getEnv("SUPABASE_DB_URL", ""),
		SupabaseJWKSURL: jwksURL,
		CORSOrigins:     getEnv("CORS_ORIGINS", "http://localhost:3000"),
		TablePrefix:     tablePrefix,
		// LLM Configuration
		AnthropicAPIKey:  getEnv("ANTHROPIC_API_KEY", ""),
		OpenRouterAPIKey: getEnv("OPENROUTER_API_KEY", ""),
		DefaultProvider:  getEnv("DEFAULT_PROVIDER", "anthropic"),
		DefaultModel:     getEnv("DEFAULT_MODEL", "claude-haiku-4-5-20251001"),
		// Debug flags - default to true in dev/test, false in production
		Debug: getEnv("DEBUG", getDefaultDebug(env)) == "true",
	}
}

// getDefaultDebug returns the default debug setting based on environment
func getDefaultDebug(env string) string {
	if env == "prod" {
		return "false"
	}
	return "true" // Enable DEBUG in dev/test by default
}

// getTablePrefix returns the table prefix based on environment
func getTablePrefix(env string) string {
	// Allow manual override via TABLE_PREFIX env var
	if prefix := os.Getenv("TABLE_PREFIX"); prefix != "" {
		return prefix
	}

	// Auto-generate based on environment
	switch env {
	case "prod":
		return "prod_"
	case "test":
		return "test_"
	case "dev":
		return "dev_"
	default:
		return "dev_"
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}
