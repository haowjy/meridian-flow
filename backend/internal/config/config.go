package config

import (
	"os"
)

type Config struct {
	Port          string
	Environment   string
	SupabaseURL   string
	SupabaseKey   string
	SupabaseDBURL string
	TestUserID    string
	TestProjectID string
	CORSOrigins   string
	TablePrefix   string
}

func Load() *Config {
	env := getEnv("ENVIRONMENT", "dev")
	tablePrefix := getTablePrefix(env)

	return &Config{
		Port:          getEnv("PORT", "8080"),
		Environment:   env,
		SupabaseURL:   getEnv("SUPABASE_URL", ""),
		SupabaseKey:   getEnv("SUPABASE_KEY", ""),
		SupabaseDBURL: getEnv("SUPABASE_DB_URL", ""),
		TestUserID:    getEnv("TEST_USER_ID", "00000000-0000-0000-0000-000000000001"),
		TestProjectID: getEnv("TEST_PROJECT_ID", "00000000-0000-0000-0000-000000000001"),
		CORSOrigins:   getEnv("CORS_ORIGINS", "http://localhost:3000"),
		TablePrefix:   tablePrefix,
	}
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
