# Phase 2: Config Sub-Structs + Validation

## Scope and Intent

Split the flat `Config` struct (~35 fields) into domain-specific sub-structs with a `CompleteDefaults()` + `Validate()` pipeline. The goal: config groups fields by concern, validates early (fail-fast), and derives defaults explicitly rather than burying them in `Load()`.

This phase is independent of Phase 1 (domain merge) and Phase 3 (constructors). Can run in parallel with both.

## Files to Modify

- `backend/internal/config/config.go` — primary target: restructure Config + Load()
- All files that access `cfg.*` fields — mechanical updates (`cfg.Port` → `cfg.Server.Port`)

## Current State

`backend/internal/config/config.go` has:
- Flat `Config` struct with ~35 fields (lines 9-47)
- `Load()` function that reads env vars and returns `*Config` (lines 49-94)
- Helper functions: `getEnv`, `getEnvInt`, `getEnvListNormalized`, `getTablePrefix`, `getDefaultDebug`, `getDefaultLogLevel`
- `IsProdIdentityBlocked()` method with `wildcardMatch` helper

## Target Structure

```go
type Config struct {
    Server   ServerConfig
    Database DatabaseConfig
    Auth     AuthConfig
    LLM      LLMConfig
    Billing  BillingConfig
    Logging  LoggingConfig
}

type ServerConfig struct {
    Port        string
    Environment string
    CORSOrigins string
    Debug       bool // Enables DEBUG features like SSE event IDs
}

type DatabaseConfig struct {
    URL         string // SupabaseDBURL
    TablePrefix string
    MaxConns    int
    MinConns    int
}

type AuthConfig struct {
    SupabaseURL           string
    SupabaseKey           string
    JWKSURL               string // Derived from SupabaseURL
    BlockedProdIdentities []string
}

type LLMConfig struct {
    AnthropicAPIKey          string
    OpenRouterAPIKey         string
    DefaultProvider          string
    DefaultModel             string
    MaxToolRounds            int
    SoftCancelTimeoutSeconds int
    LLMIdleTimeoutSeconds    int
    MaxConcurrentStreamsFree int
    MaxConcurrentStreamsPaid int
    SearchAPIKey             string
    SearchAPIProvider        string
}

type BillingConfig struct {
    StripeSecretKey     string
    StripeWebhookSecret string
}

type LoggingConfig struct {
    Level           string // debug|info|warn|error
    ToFile          bool
    Dir             string
    MaxFiles        int
    LLMStreamDebug  bool
}
```

## Config Pipeline

```go
func Load() *Config {
    cfg := loadFromEnv()      // raw env var reading
    cfg.CompleteDefaults()     // fill derived values
    if err := cfg.Validate(); err != nil {
        // fail-fast: log error and exit
    }
    return cfg
}
```

### CompleteDefaults()

Move derived-value logic out of `Load()` into an explicit method:
- `AuthConfig.JWKSURL` derived from `AuthConfig.SupabaseURL + "/auth/v1/.well-known/jwks.json"`
- `DatabaseConfig.TablePrefix` derived from `ServerConfig.Environment` (if not manually set)
- `ServerConfig.Debug` default based on environment
- `LoggingConfig.Level` default based on environment

### Validate()

Fail-fast validation for required fields and invalid combinations:
```go
func (c *Config) Validate() error {
    // Database URL is always required
    if c.Database.URL == "" {
        return fmt.Errorf("SUPABASE_DB_URL is required")
    }
    // At least one LLM provider key required
    if c.LLM.AnthropicAPIKey == "" && c.LLM.OpenRouterAPIKey == "" {
        return fmt.Errorf("at least one LLM API key is required (ANTHROPIC_API_KEY or OPENROUTER_API_KEY)")
    }
    // Stripe keys required in production
    if c.Server.Environment == "prod" {
        if c.Billing.StripeSecretKey == "" || c.Billing.StripeWebhookSecret == "" {
            return fmt.Errorf("stripe keys are required in production")
        }
    }
    // Pool config sanity
    if c.Database.MaxConns < c.Database.MinConns {
        return fmt.Errorf("DB_MAX_CONNS (%d) must be >= DB_MIN_CONNS (%d)", c.Database.MaxConns, c.Database.MinConns)
    }
    return nil
}
```

### IsProdIdentityBlocked

Move to be a method on `AuthConfig` (or keep on `Config` and delegate):
```go
func (c *AuthConfig) IsProdIdentityBlocked(env, userID, email string) bool { ... }
// OR
func (c *Config) IsProdIdentityBlocked(userID, email string) bool {
    return c.Auth.isProdIdentityBlocked(c.Server.Environment, userID, email)
}
```

Keep the existing public API shape (`c.IsProdIdentityBlocked(userID, email)`) to minimize caller changes.

## Caller Updates

This is the mechanical part. Every access to a config field needs updating. The pattern is straightforward:

| Old | New |
|-----|-----|
| `cfg.Port` | `cfg.Server.Port` |
| `cfg.Environment` | `cfg.Server.Environment` |
| `cfg.CORSOrigins` | `cfg.Server.CORSOrigins` |
| `cfg.Debug` | `cfg.Server.Debug` |
| `cfg.SupabaseDBURL` | `cfg.Database.URL` |
| `cfg.TablePrefix` | `cfg.Database.TablePrefix` |
| `cfg.DBMaxConns` | `cfg.Database.MaxConns` |
| `cfg.DBMinConns` | `cfg.Database.MinConns` |
| `cfg.SupabaseURL` | `cfg.Auth.SupabaseURL` |
| `cfg.SupabaseKey` | `cfg.Auth.SupabaseKey` |
| `cfg.SupabaseJWKSURL` | `cfg.Auth.JWKSURL` |
| `cfg.BlockedProdIdentities` | `cfg.Auth.BlockedProdIdentities` |
| `cfg.AnthropicAPIKey` | `cfg.LLM.AnthropicAPIKey` |
| `cfg.OpenRouterAPIKey` | `cfg.LLM.OpenRouterAPIKey` |
| `cfg.DefaultProvider` | `cfg.LLM.DefaultProvider` |
| `cfg.DefaultModel` | `cfg.LLM.DefaultModel` |
| `cfg.MaxToolRounds` | `cfg.LLM.MaxToolRounds` |
| `cfg.SoftCancelTimeoutSeconds` | `cfg.LLM.SoftCancelTimeoutSeconds` |
| `cfg.LLMIdleTimeoutSeconds` | `cfg.LLM.LLMIdleTimeoutSeconds` |
| `cfg.MaxConcurrentStreamsFree` | `cfg.LLM.MaxConcurrentStreamsFree` |
| `cfg.MaxConcurrentStreamsPaid` | `cfg.LLM.MaxConcurrentStreamsPaid` |
| `cfg.SearchAPIKey` | `cfg.LLM.SearchAPIKey` |
| `cfg.SearchAPIProvider` | `cfg.LLM.SearchAPIProvider` |
| `cfg.StripeSecretKey` | `cfg.Billing.StripeSecretKey` |
| `cfg.StripeWebhookSecret` | `cfg.Billing.StripeWebhookSecret` |
| `cfg.LogLevel` | `cfg.Logging.Level` |
| `cfg.LogToFile` | `cfg.Logging.ToFile` |
| `cfg.LogDir` | `cfg.Logging.Dir` |
| `cfg.LogMaxFiles` | `cfg.Logging.MaxFiles` |
| `cfg.LLMStreamDebugLogs` | `cfg.Logging.LLMStreamDebug` |

Key files that access config (find all with `grep -rn "cfg\." backend/internal/ backend/cmd/`):
- `cmd/server/main.go` — heaviest user (~30+ accesses)
- `internal/handler/*.go` — many handlers take `*config.Config`
- `internal/service/llm/streaming/*.go` — LLM config fields
- `internal/service/llm/setup.go`
- `internal/middleware/*.go`
- `internal/config/logging.go` (if exists)

## Where Handlers Take Config

Many handlers receive the full `*config.Config` but only use `cfg.Debug` and `cfg.Environment`. For now, keep passing the full `*Config` — narrowing handler config is a future optimization. The sub-struct split is the important structural improvement.

## Constraints

- Do NOT change the set of environment variables — only the internal struct layout
- Do NOT change the `config.ParseLogLevel` or `config.SetupLogFile` functions (they're fine as-is)
- Keep the `Load()` function as the single entry point
- Keep `IsProdIdentityBlocked` accessible via `*Config` (don't break callers)
- Helper functions (`getEnv`, `getEnvInt`, etc.) stay unexported in config package

## Pattern Reference

Follow the existing config package style. The helpers (`getEnv`, `getEnvInt`, `getEnvListNormalized`) are well-written — keep them.

## Verification Criteria

- [ ] `cd backend && go build ./...` passes
- [ ] `cd backend && go test ./...` passes
- [ ] Config struct has 6 sub-structs (Server, Database, Auth, LLM, Billing, Logging)
- [ ] `CompleteDefaults()` handles JWKS URL, table prefix, debug default, log level default
- [ ] `Validate()` checks: DB URL required, at least one LLM key, Stripe in prod, pool config sanity
- [ ] `IsProdIdentityBlocked` still works via `*Config` method
- [ ] No direct env var access outside `config.Load()` / `config` package
- [ ] `grep -rn "cfg\.Port\b" backend/` returns nothing (all migrated to `cfg.Server.Port`)
