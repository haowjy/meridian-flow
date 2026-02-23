package config

import (
	"fmt"
	"os"
	"strings"
)

type Config struct {
	Port            string
	Environment     string
	SupabaseURL     string
	SupabaseKey     string
	SupabaseDBURL   string
	SupabaseJWKSURL string // Constructed from SupabaseURL + /auth/v1/.well-known/jwks.json
	// Production access controls
	BlockedProdIdentities []string // Comma-separated identities from BLOCKED_PROD_IDENTITIES
	CORSOrigins           string
	TablePrefix           string
	// Database pool configuration (pgxpool)
	DBMaxConns int
	DBMinConns int
	// LLM Configuration
	AnthropicAPIKey               string
	OpenRouterAPIKey              string
	DefaultProvider               string
	DefaultModel                  string
	MaxToolRounds                 int // Fallback limit if resolver fails (default: 10)
	SoftCancelTimeoutSeconds      int // Timeout for soft cancel before forced cleanup (default: 300 = 5 minutes)
	LLMIdleTimeoutSeconds         int // Streaming idle timeout in seconds (default: 120 = 2 minutes)
	MaxConcurrentStreams          int // Max concurrent streams per user (default: 3)
	CollabSnapshotIntervalUpdates int // Collab snapshot safety net trigger (default: 500 updates)
	CollabAutoSnapshotTTLHours    int // TTL for auto snapshots in hours (default: 168 = 7 days)
	CollabCleanupIntervalMinutes  int // How often to run snapshot cleanup (default: 60 = 1 hour)
	CollabDefaultAutoAccept       bool
	// Search API Configuration (optional - for web_search tool)
	SearchAPIKey      string // API key for external search provider
	SearchAPIProvider string // Provider name: "tavily", "brave", "serper", etc.
	// Debug flags
	Debug bool // Enables DEBUG features like SSE event IDs
	// Logging configuration
	LogLevel           string // debug|info|warn|error (default varies by environment)
	LogToFile          bool   // When enabled, logs to both stdout and a session file
	LogDir             string // Directory for log files
	LogMaxFiles        int    // Max session log files to keep
	LLMStreamDebugLogs bool   // Enables very verbose provider streaming logs (redacted)
}

func Load() *Config {
	env := getEnv("ENVIRONMENT", "dev")
	tablePrefix := getTablePrefix(env)
	supabaseURL := getEnv("SUPABASE_URL", "")

	// Construct JWKS URL from Supabase URL
	jwksURL := supabaseURL + "/auth/v1/.well-known/jwks.json"

	return &Config{
		Port:                  getEnv("PORT", "8080"),
		Environment:           env,
		SupabaseURL:           supabaseURL,
		SupabaseKey:           getEnv("SUPABASE_KEY", ""),
		SupabaseDBURL:         getEnv("SUPABASE_DB_URL", ""),
		SupabaseJWKSURL:       jwksURL,
		BlockedProdIdentities: getEnvListNormalized("BLOCKED_PROD_IDENTITIES"),
		CORSOrigins:           getEnv("CORS_ORIGINS", "http://localhost:3000"),
		TablePrefix:           tablePrefix,
		DBMaxConns:            getEnvInt("DB_MAX_CONNS", 25),
		DBMinConns:            getEnvInt("DB_MIN_CONNS", 5),
		// LLM Configuration
		AnthropicAPIKey:               getEnv("ANTHROPIC_API_KEY", ""),
		OpenRouterAPIKey:              getEnv("OPENROUTER_API_KEY", ""),
		DefaultProvider:               getEnv("DEFAULT_PROVIDER", "openrouter"),
		DefaultModel:                  getEnv("DEFAULT_MODEL", "moonshotai/kimi-k2-thinking"),
		MaxToolRounds:                 getEnvInt("MAX_TOOL_ROUNDS", 10),
		SoftCancelTimeoutSeconds:      getEnvInt("SOFT_CANCEL_TIMEOUT_SECONDS", 300), // 5 minutes default
		LLMIdleTimeoutSeconds:         getEnvInt("LLM_IDLE_TIMEOUT_SECONDS", 120),    // 2 minutes default
		MaxConcurrentStreams:          getEnvInt("MAX_CONCURRENT_STREAMS", 3),        // Per-user concurrent stream limit
		CollabSnapshotIntervalUpdates: getEnvInt("MERIDIAN_COLLAB_SNAPSHOT_INTERVAL_UPDATES", 500),
		CollabAutoSnapshotTTLHours:    getEnvInt("MERIDIAN_COLLAB_AUTO_SNAPSHOT_TTL_HOURS", 168), // 7 days
		CollabCleanupIntervalMinutes:  getEnvInt("MERIDIAN_COLLAB_CLEANUP_INTERVAL_MINUTES", 60), // 1 hour
		CollabDefaultAutoAccept:       getEnv("MERIDIAN_COLLAB_DEFAULT_AUTO_ACCEPT", "true") == "true",
		// Search API Configuration (optional)
		SearchAPIKey:      getEnv("SEARCH_API_KEY", ""),
		SearchAPIProvider: getEnv("SEARCH_API_PROVIDER", "tavily"),
		// Debug flags - default to true in dev/test, false in production
		Debug: getEnv("DEBUG", getDefaultDebug(env)) == "true",
		// Logging configuration
		LogLevel:           getEnv("LOG_LEVEL", getDefaultLogLevel(env)),
		LogToFile:          getEnv("LOG_TO_FILE", "false") == "true",
		LogDir:             getEnv("LOG_DIR", "./logs"),
		LogMaxFiles:        getEnvInt("LOG_MAX_FILES", 10),
		LLMStreamDebugLogs: getEnv("LLM_STREAM_DEBUG_LOGS", "false") == "true",
	}
}

// getDefaultDebug returns the default debug setting based on environment
func getDefaultDebug(env string) string {
	if env == "prod" {
		return "false"
	}
	return "true" // Enable DEBUG in dev/test by default
}

func getDefaultLogLevel(env string) string {
	if env == "dev" {
		return "debug"
	}
	return "info"
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

func getEnvInt(key string, defaultValue int) int {
	value := os.Getenv(key)
	if value == "" {
		return defaultValue
	}

	// Parse int from string
	var intValue int
	if _, err := fmt.Sscanf(value, "%d", &intValue); err == nil {
		return intValue
	}

	// If parsing fails, return default
	return defaultValue
}

func getEnvListNormalized(key string) []string {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}

	seen := make(map[string]struct{})
	var result []string
	for _, value := range strings.Split(raw, ",") {
		trimmed := strings.ToLower(strings.TrimSpace(value))
		if trimmed == "" {
			continue
		}
		if _, exists := seen[trimmed]; exists {
			continue
		}
		seen[trimmed] = struct{}{}
		result = append(result, trimmed)
	}
	return result
}

// IsProdIdentityBlocked returns true only in production when userID/email
// matches any wildcard rule from BLOCKED_PROD_IDENTITIES.
//
// Rule format uses glob-style '*' wildcards, for example:
// - *@example.com
// - test-*@my-domain.com
// - cccccccc-cccc-cccc-cccc-cccccccccccc
func (c *Config) IsProdIdentityBlocked(userID, email string) bool {
	if c == nil || c.Environment != "prod" {
		return false
	}
	userID = strings.ToLower(strings.TrimSpace(userID))
	email = strings.ToLower(strings.TrimSpace(email))

	if len(c.BlockedProdIdentities) == 0 {
		return false
	}

	for _, pattern := range c.BlockedProdIdentities {
		if userID != "" && wildcardMatch(pattern, userID) {
			return true
		}
		if email != "" && wildcardMatch(pattern, email) {
			return true
		}
	}

	return false
}

// wildcardMatch performs case-sensitive glob matching where '*' means "zero or more characters".
// Inputs should be normalized by the caller when case-insensitive behavior is desired.
func wildcardMatch(pattern, value string) bool {
	p := 0
	v := 0
	star := -1
	match := 0

	for v < len(value) {
		if p < len(pattern) && pattern[p] == value[v] {
			p++
			v++
			continue
		}
		if p < len(pattern) && pattern[p] == '*' {
			star = p
			match = v
			p++
			continue
		}
		if star != -1 {
			p = star + 1
			match++
			v = match
			continue
		}
		return false
	}

	for p < len(pattern) && pattern[p] == '*' {
		p++
	}
	return p == len(pattern)
}
