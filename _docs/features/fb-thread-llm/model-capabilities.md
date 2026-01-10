---
stack: backend
status: complete
feature: "Model Capabilities"
---

# Model Capabilities

**YAML-based model capability registry.**

## Status: ✅ Complete

---

## Implementation

**Registry**: `backend/internal/capabilities/registry.go`

**Config Files**:
- `backend/internal/capabilities/config/anthropic.yaml`
- `backend/internal/capabilities/config/openrouter.yaml`

---

## Capability Data

**Per Model**:
- Supported features (streaming, tools, thinking)
- Context window size
- Max output tokens
- Pricing (input/output per 1M tokens)

---

## API

**Endpoint**: `GET /api/models/capabilities`

**Methods**:
- `GetModelCapabilities(provider, model)` - Single model
- `ListProviderModels(provider)` - All models for provider

---

## Related

- See [providers.md](providers.md) for provider details
