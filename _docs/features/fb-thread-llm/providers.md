---
stack: backend
status: complete
feature: "LLM Providers"
---

# LLM Providers

**Multi-provider support with unified abstraction.**

## Status: ✅ 3 Working, 3 Planned

---

## Working Providers

**Anthropic** - Claude models, streaming, tools, extended thinking
**OpenRouter** - Multi-provider proxy (200+ models)
**Lorem** - Mock provider for testing (no API key needed)

**Files**: `backend/internal/service/llm/adapters/`

---

## Planned Providers

❌ OpenAI - Code stubs only
❌ Bedrock - Code stubs only
❌ Gemini - Code stubs only

---

## Provider Features

**Unified Interface**: All providers implement same interface

**Auto-Mapping**: Minimal tool definitions → provider-specific

**Error Normalization**: Consistent error handling

**Streaming**: All providers support SSE streaming

**Files**: `backend/internal/service/llm/provider_factory.go`, `meridian-llm-go/providers/`

---

## Known Limitations

### OpenRouter + Anthropic Models

**Anthropic models via OpenRouter do NOT support tool continuation with thinking.**

OpenRouter's `reasoning_details` format loses Anthropic's cryptographic `signature` field, causing continuation requests to fail with:
```
Expected `thinking` or `redacted_thinking`, but found `text`
```

**Workaround:** Use direct Anthropic API for Claude models.

---

## Related

- See [model-capabilities.md](model-capabilities.md) for capability registry
- See `/_docs/technical/backend/llm-integration.md` for architecture
