---
status: future
priority: medium
featureset: infrastructure
---

# LLM Retry Strategies

## Overview

Implement intelligent retry logic for LLM API calls to handle transient failures and rate limits gracefully.

**Current Status**: Not implemented - all retries are manual.

## Exponential Backoff Strategy

### Basic Implementation

```go
// File: backend/internal/service/llm/retry.go

func (s *LLMService) GenerateWithRetry(ctx context.Context, req *llm.GenerateRequest) (*llm.Response, error) {
    maxRetries := 3
    baseDelay := 1 * time.Second

    for attempt := 0; attempt <= maxRetries; attempt++ {
        resp, err := s.client.GenerateResponse(ctx, s.provider, req)
        if err == nil {
            return resp, nil
        }

        // Check if retryable
        var llmErr *llm.LLMError
        if !errors.As(err, &llmErr) || !llmErr.Retryable {
            return nil, err  // Don't retry
        }

        // Last attempt failed
        if attempt == maxRetries {
            return nil, llmErr
        }

        // Calculate delay
        delay := baseDelay * time.Duration(1<<attempt)
        if llmErr.Category == llm.ErrorRateLimit {
            delay = 10 * time.Second * time.Duration(1<<attempt)
        }

        // Wait before retry
        select {
        case <-time.After(delay):
            continue
        case <-ctx.Done():
            return nil, ctx.Err()
        }
    }

    return nil, fmt.Errorf("max retries exceeded")
}
```

### Retry Decision Matrix

| Error Type | Retryable | Base Delay | Max Retries |
|------------|-----------|------------|-------------|
| Rate Limit | ✅ Yes | 10s | 3 |
| Timeout | ✅ Yes | 1s | 3 |
| Server Error (5xx) | ✅ Yes | 2s | 3 |
| Invalid Request (4xx) | ❌ No | - | 0 |
| Authentication | ❌ No | - | 0 |
| Network Error | ✅ Yes | 1s | 5 |

### Delay Calculation

**Standard errors:**
- Attempt 1: 1s
- Attempt 2: 2s (1s × 2^1)
- Attempt 3: 4s (1s × 2^2)

**Rate limit errors:**
- Attempt 1: 10s
- Attempt 2: 20s (10s × 2^1)
- Attempt 3: 40s (10s × 2^2)

## Advanced: Adaptive Retry

```go
type AdaptiveRetrier struct {
    successRate   float64
    currentDelay  time.Duration
    minDelay      time.Duration
    maxDelay      time.Duration
}

func (r *AdaptiveRetrier) CalculateDelay(err *llm.LLMError) time.Duration {
    if err.Category == llm.ErrorRateLimit {
        // Increase delay aggressively for rate limits
        r.currentDelay = min(r.currentDelay * 2, r.maxDelay)
    } else if r.successRate > 0.9 {
        // Decrease delay if success rate is high
        r.currentDelay = max(r.currentDelay / 2, r.minDelay)
    }

    return r.currentDelay
}

func (r *AdaptiveRetrier) RecordAttempt(success bool) {
    // Exponential moving average
    alpha := 0.1
    if success {
        r.successRate = alpha*1.0 + (1-alpha)*r.successRate
    } else {
        r.successRate = alpha*0.0 + (1-alpha)*r.successRate
    }
}
```

## Circuit Breaker Pattern

Prevent cascading failures by stopping retries when error rate is too high:

```go
type CircuitBreaker struct {
    failureThreshold int
    resetTimeout     time.Duration
    consecutiveFailures int
    state            string // "closed", "open", "half-open"
    lastFailure      time.Time
}

func (cb *CircuitBreaker) ShouldRetry() bool {
    switch cb.state {
    case "open":
        // Check if timeout elapsed
        if time.Since(cb.lastFailure) > cb.resetTimeout {
            cb.state = "half-open"
            return true
        }
        return false
    case "half-open":
        return true
    case "closed":
        return true
    }
    return false
}

func (cb *CircuitBreaker) RecordFailure() {
    cb.consecutiveFailures++
    cb.lastFailure = time.Now()

    if cb.consecutiveFailures >= cb.failureThreshold {
        cb.state = "open"
    }
}

func (cb *CircuitBreaker) RecordSuccess() {
    cb.consecutiveFailures = 0
    cb.state = "closed"
}
```

## Integration with Error Normalization

Retry logic depends on error categorization from the LLM library:

```go
// meridian-llm-go error types
type LLMError struct {
    Category  ErrorCategory  // RateLimit, Timeout, ServerError, etc.
    Retryable bool
    RetryAfter *time.Duration  // From Retry-After header
}
```

**See:** [`meridian-llm-go/docs/errors.md`](../../../../meridian-llm-go/docs/errors.md)

## User Experience Considerations

### Progress Indication

Show retry attempts to user during streaming:

```
SSE event:
{
  "type": "retry_attempt",
  "attempt": 2,
  "max_attempts": 3,
  "reason": "rate_limit",
  "retry_after": "10s"
}
```

### Graceful Degradation

If retries exhausted, provide helpful error message:

```
"The AI service is currently experiencing high load.
 Please try again in a few moments."
```

## Metrics and Monitoring

Track retry behavior for debugging and capacity planning:

```go
type RetryMetrics struct {
    TotalAttempts     int64
    SuccessfulRetries int64
    FailedRetries     int64
    AverageDelay      time.Duration
    CircuitBreakerTrips int64
}
```

## Implementation Phases

### Phase 1: Basic Exponential Backoff
- Fixed retry limits
- Simple delay calculation
- Error categorization

### Phase 2: Adaptive Retry
- Dynamic delay adjustment
- Success rate tracking
- Provider-specific tuning

### Phase 3: Circuit Breaker
- Failure threshold detection
- Automatic recovery
- Health check endpoints

## References

- Current error handling: `_docs/technical/backend/llm-integration.md`
- Error normalization: `meridian-llm-go/docs/errors.md`
- Exponential backoff: https://en.wikipedia.org/wiki/Exponential_backoff
- Circuit breaker pattern: https://martinfowler.com/bliki/CircuitBreaker.html
