---
detail: minimal
audience: developer
---

# Environment Gating

## Problem

LLM tools (search, bash, text_editor) are debug features. Running them in production has security and cost risks.

## Solution

Block tools in non-development environments.

| Environment | Tools Allowed? | Why |
|-------------|----------------|-----|
| `dev` | ✅ Yes | Local development and debugging |
| `test` | ✅ Yes | Automated testing |
| `prod` | ❌ **No** | Security: prevent arbitrary code execution<br/>Cost: prevent unexpected API usage |
| `staging` | ❌ **No** | Treat like production |
| Other | ❌ **No** | Default deny |

## Implementation

```go
// Environment gating: Reject tools in production
if s.config.Environment != "dev" && s.config.Environment != "test" {
    if len(params.Tools) > 0 {
        return nil, fmt.Errorf("%w: tools are only allowed in dev/test environments", domain.ErrValidation)
    }
}
```

**Location:** `backend/internal/service/llm/streaming/service.go:108-113`

**Tests:** `backend/internal/service/llm/streaming/service_test.go` (6 tests)

## Environment Variable

```env
# .env
ENVIRONMENT=dev  # or test, prod, staging
```

**Default:** If not set, tools are blocked (safe default).

## Error Response

When tools are sent in production:

```json
{
  "error": "validation_error",
  "message": "tools are only allowed in dev/test environments"
}
```

## See Also

- [LLM Integration Guide](llm-integration.md) - Complete backend integration patterns
- [Provider Routing](provider-routing.md) - Model string routing
- [Phase 2 Handoff](../../hidden/handoffs/phase-2-completion.md) - Implementation summary
