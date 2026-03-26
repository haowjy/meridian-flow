package config

import (
	"fmt"
	"os"
	"strings"
)

// ServerConfig holds HTTP server settings.
type ServerConfig struct {
	Port        string
	Environment string
	CORSOrigins string
	Debug       bool // Enables DEBUG features like SSE event IDs
}

// DatabaseConfig holds database connection settings.
type DatabaseConfig struct {
	URL         string // Supabase DB connection URL
	TablePrefix string
	MaxConns    int
	MinConns    int
}

// AuthConfig holds authentication/identity settings.
type AuthConfig struct {
	SupabaseURL           string
	SupabaseKey           string
	SupabaseJWKSURL       string   // Derived: SupabaseURL + /auth/v1/.well-known/jwks.json
	BlockedProdIdentities []string // Comma-separated identities from BLOCKED_PROD_IDENTITIES
}

// LLMConfig holds LLM provider settings.
type LLMConfig struct {
	AnthropicAPIKey          string
	OpenRouterAPIKey         string
	DefaultProvider          string
	DefaultModel             string
	MaxToolRounds            int    // Fallback limit if resolver fails (default: 10)
	SoftCancelTimeoutSeconds int    // Timeout for soft cancel before forced cleanup (default: 300 = 5 minutes)
	IdleTimeoutSeconds       int    // Streaming idle timeout in seconds (default: 120 = 2 minutes)
	MaxConcurrentStreamsFree int    // Max concurrent streams for free users (default: 3)
	MaxConcurrentStreamsPaid int    // Max concurrent streams for paid users (default: 10)
	StreamDebugLogs          bool   // Enables very verbose provider streaming logs (redacted)
	SearchAPIKey             string // API key for external search provider (optional)
	SearchAPIProvider        string // Provider name: "tavily", "brave", "serper", etc.
	MaxSpawnDepth            int    // Maximum spawn recursion depth (default: 3)
	MaxConcurrentSpawns      int    // Maximum concurrent running spawns per work item (default: 5)
	SpawnTimeoutSeconds      int    // Foreground spawn timeout in seconds (default: 300 = 5 minutes)
}

// BillingConfig holds billing/payment settings.
type BillingConfig struct {
	StripeSecretKey     string
	StripeWebhookSecret string
}

// LoggingConfig holds logging settings.
type LoggingConfig struct {
	Level    string // debug|info|warn|error (default varies by environment)
	ToFile   bool   // When enabled, logs to both stdout and a session file
	Dir      string // Directory for log files
	MaxFiles int    // Max session log files to keep
}

// Config is the top-level application configuration.
// Sub-structs group related settings for clarity and narrower dependency injection.
type Config struct {
	Server   ServerConfig
	Database DatabaseConfig
	Auth     AuthConfig
	LLM      LLMConfig
	Billing  BillingConfig
	Logging  LoggingConfig
}

// Load reads environment variables into a Config and applies defaults and validation.
// Panics if configuration is invalid (fail-fast at startup).
func Load() *Config {
	env := getEnv("ENVIRONMENT", "dev")

	cfg := &Config{
		Server: ServerConfig{
			Port:        getEnv("PORT", "8080"),
			Environment: env,
			CORSOrigins: getEnv("CORS_ORIGINS", "http://localhost:3000"),
		},
		Database: DatabaseConfig{
			URL:      getEnv("SUPABASE_DB_URL", ""),
			MaxConns: getEnvInt("DB_MAX_CONNS", 25),
			MinConns: getEnvInt("DB_MIN_CONNS", 5),
		},
		Auth: AuthConfig{
			SupabaseURL:           getEnv("SUPABASE_URL", ""),
			SupabaseKey:           getEnv("SUPABASE_KEY", ""),
			BlockedProdIdentities: getEnvListNormalized("BLOCKED_PROD_IDENTITIES"),
		},
		LLM: LLMConfig{
			AnthropicAPIKey:          getEnv("ANTHROPIC_API_KEY", ""),
			OpenRouterAPIKey:         getEnv("OPENROUTER_API_KEY", ""),
			DefaultProvider:          getEnv("DEFAULT_PROVIDER", "openrouter"),
			DefaultModel:             getEnv("DEFAULT_MODEL", "moonshotai/kimi-k2-thinking"),
			MaxToolRounds:            getEnvInt("MAX_TOOL_ROUNDS", 10),
			SoftCancelTimeoutSeconds: getEnvInt("SOFT_CANCEL_TIMEOUT_SECONDS", 300),
			IdleTimeoutSeconds:       getEnvInt("LLM_IDLE_TIMEOUT_SECONDS", 120),
			MaxConcurrentStreamsFree: getEnvInt("MAX_CONCURRENT_STREAMS_FREE", 3),
			MaxConcurrentStreamsPaid: getEnvInt("MAX_CONCURRENT_STREAMS_PAID", 10),
			StreamDebugLogs:          getEnv("LLM_STREAM_DEBUG_LOGS", "false") == "true",
			SearchAPIKey:             getEnv("SEARCH_API_KEY", ""),
			SearchAPIProvider:        getEnv("SEARCH_API_PROVIDER", "tavily"),
			MaxSpawnDepth:            getEnvInt("MAX_SPAWN_DEPTH", 3),
			MaxConcurrentSpawns:      getEnvInt("MAX_CONCURRENT_SPAWNS", 5),
			SpawnTimeoutSeconds:      getEnvInt("SPAWN_TIMEOUT_SECONDS", 300),
		},
		Billing: BillingConfig{
			StripeSecretKey:     getEnv("STRIPE_SECRET_KEY", ""),
			StripeWebhookSecret: getEnv("STRIPE_WEBHOOK_SECRET", ""),
		},
		Logging: LoggingConfig{
			ToFile:   getEnv("LOG_TO_FILE", "false") == "true",
			Dir:      getEnv("LOG_DIR", "./logs"),
			MaxFiles: getEnvInt("LOG_MAX_FILES", 10),
		},
	}

	cfg.CompleteDefaults()
	if err := cfg.Validate(); err != nil {
		panic(fmt.Sprintf("invalid configuration: %v", err))
	}

	return cfg
}

// CompleteDefaults fills in derived fields that depend on other config values.
// Called by Load() after env vars are read but before Validate().
func (c *Config) CompleteDefaults() {
	env := c.Server.Environment

	// JWKS URL is derived from Supabase URL
	c.Auth.SupabaseJWKSURL = c.Auth.SupabaseURL + "/auth/v1/.well-known/jwks.json"

	// Table prefix: allow manual override, otherwise derive from environment
	c.Database.TablePrefix = getTablePrefix(env)

	// Debug default: true in dev/test, false in production
	if val := os.Getenv("DEBUG"); val != "" {
		c.Server.Debug = val == "true"
	} else {
		c.Server.Debug = env != "prod"
	}

	// Log level default: debug in dev, info everywhere else
	if val := os.Getenv("LOG_LEVEL"); val != "" {
		c.Logging.Level = val
	} else {
		c.Logging.Level = getDefaultLogLevel(env)
	}
}

// Validate checks that required configuration is present and sane.
func (c *Config) Validate() error {
	if strings.TrimSpace(c.Database.URL) == "" {
		return fmt.Errorf("config: SUPABASE_DB_URL is required")
	}

	env := strings.ToLower(strings.TrimSpace(c.Server.Environment))
	if env != "dev" && env != "test" &&
		strings.TrimSpace(c.LLM.AnthropicAPIKey) == "" &&
		strings.TrimSpace(c.LLM.OpenRouterAPIKey) == "" {
		return fmt.Errorf("config: at least one LLM API key is required (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)")
	}

	if env == "prod" {
		if strings.TrimSpace(c.Billing.StripeSecretKey) == "" {
			return fmt.Errorf("config: STRIPE_SECRET_KEY is required in prod")
		}
		if strings.TrimSpace(c.Billing.StripeWebhookSecret) == "" {
			return fmt.Errorf("config: STRIPE_WEBHOOK_SECRET is required in prod")
		}
	}

	// Pool sanity: MinConns must not exceed MaxConns
	if c.Database.MinConns > c.Database.MaxConns {
		return fmt.Errorf("config: DB_MIN_CONNS (%d) > DB_MAX_CONNS (%d)", c.Database.MinConns, c.Database.MaxConns)
	}

	return nil
}

// IsProd returns true when running in production environment.
func (c *Config) IsProd() bool {
	return c.Server.Environment == "prod"
}

// getDefaultLogLevel returns the default log level based on environment.
func getDefaultLogLevel(env string) string {
	if env == "dev" {
		return "debug"
	}
	return "info"
}

// getTablePrefix returns the table prefix based on environment.
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
	if c == nil || c.Server.Environment != "prod" {
		return false
	}
	userID = strings.ToLower(strings.TrimSpace(userID))
	email = strings.ToLower(strings.TrimSpace(email))

	if len(c.Auth.BlockedProdIdentities) == 0 {
		return false
	}

	for _, pattern := range c.Auth.BlockedProdIdentities {
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
