# Model gateway smoke guide

End-to-end checks for `@meridian/model-gateway` via the smoke mini-server (`tests/smoke/server.ts`).

## Prerequisites

**Environment** (repo-root `.env`; loaded automatically by the server):

| Variable | Required | Notes |
|----------|----------|-------|
| `DEEPSEEK_API_KEY` | Optional | Enables live DeepSeek scenarios |
| `ANTHROPIC_API_KEY` | Optional | Live Anthropic scenarios (adapter not in v1 spine yet) |
| `OPENAI_API_KEY` | Optional | Live OpenAI scenarios (adapter not in v1 spine yet) |
| `OPENROUTER_API_KEY` | Optional | Enables live OpenRouter scenarios |
| `MODEL_PROVIDER` | Optional | Set to `mock` to force in-process mock even if keys exist |
| `PORT` | Optional | Fixed listen port; default is OS-assigned ephemeral |

**Start the server** (from repo root):

```bash
pnpm exec tsx tests/smoke/server.ts
```

Note the printed URL, e.g. `http://127.0.0.1:38421`. For curls below:

```bash
export PORT=38421   # replace with your port
export BASE="http://127.0.0.1:${PORT}"
```

**Message format:** `content` is always `ContentPart[]` (array of parts), never a bare string.

---

## 1. Health check

**Description:** Verify the server is up, providers are registered, and a default model is advertised.

```bash
curl -sS "${BASE}/health" | jq .
```

**Example response:**

```json
{
  "status": "ok",
  "providers": ["mock"],
  "defaultModel": "mock-llm-v1"
}
```

**Pass:** HTTP 200; `status` is `"ok"`; `providers` is a non-empty array; `defaultModel` is a non-empty string.

**Fail:** Non-200, empty `providers`, or missing `defaultModel`.

---

## 2. Mock fallback (no real API keys)

**Description:** With no real provider keys (or `MODEL_PROVIDER=mock`), the server starts an in-process OpenAI-compatible mock. Proves the adapter pipeline without external network.

**Setup:** Ensure provider API keys are unset or dev placeholders (`dev-*`). Restart the server.

```bash
curl -sS "${BASE}/health" | jq .
```

**Example response:**

```json
{
  "status": "ok",
  "providers": ["mock"],
  "defaultModel": "mock-llm-v1"
}
```

**Pass:** `providers` contains `"mock"` only (or includes `"mock"` when no other providers configured).

**Fail:** Health fails or no mock provider when keys are absent.

---

## 3. Non-streaming generate

**Description:** Single-shot completion via `POST /generate`.

```bash
curl -sS -X POST "${BASE}/generate" \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Say hello in one short sentence." }] }
    ]
  }' | jq .
```

**Example response:**

```json
{
  "content": [{ "type": "text", "text": "Mock response to: Say hello in one short sentence." }],
  "toolCalls": [],
  "finishReason": "end_turn",
  "usage": { "inputTokens": 12, "outputTokens": 18 },
  "model": "mock-llm-v1",
  "provider": "mock"
}
```

**Pass:** HTTP 200; `content` includes at least one `"type": "text"` part; `finishReason` present; `usage.inputTokens` and `usage.outputTokens` > 0; `model` and `provider` set.

**Fail:** Non-200 or missing fields above.

---

## 4. SSE streaming

**Description:** Stream events over Server-Sent Events via `POST /stream`.

```bash
curl -sS -N -X POST "${BASE}/stream" \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Stream a brief greeting." }] }
    ]
  }'
```

**Example output (truncated):**

```
data: {"type":"start","model":"mock-llm-v1","provider":"mock"}

data: {"type":"text.delta","text":"Mock"}

data: {"type":"text.delta","text":" response"}

data: {"type":"end","result":{"content":[...],"finishReason":"end_turn","usage":{"inputTokens":10,"outputTokens":15},"model":"mock-llm-v1","provider":"mock",...}}
```

**Pass:** Lines begin with `data: `; JSON parses; includes `start` and at least one `text.delta`; final event is `end` with `result.usage.outputTokens` > 0.

**Fail:** No SSE lines, missing `start`/`text.delta`, or stream ends without `end`.

---

## 5. Tool calling

**Description:** Function tool with `toolChoice: "required"` returns a tool call.

```bash
curl -sS -X POST "${BASE}/generate" \
  -H 'Content-Type: application/json' \
  -d '{
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "What is the weather in San Francisco?" }] }
    ],
    "tools": [
      {
        "type": "function",
        "name": "get_weather",
        "description": "Get current weather for a location",
        "inputSchema": {
          "type": "object",
          "properties": { "location": { "type": "string" } },
          "required": ["location"]
        }
      }
    ],
    "toolChoice": "required"
  }' | jq .
```

**Example response:**

```json
{
  "content": [],
  "toolCalls": [
    {
      "id": "call_abc",
      "name": "get_weather",
      "arguments": { "location": "San Francisco" }
    }
  ],
  "finishReason": "tool_use",
  "usage": { "inputTokens": 20, "outputTokens": 12 },
  "model": "mock-llm-v1",
  "provider": "mock"
}
```

**Pass:** HTTP 200; `finishReason` is `"tool_use"`; `toolCalls` length ≥ 1; first entry `name` is `"get_weather"`; `arguments` is an object (parsed JSON).

**Fail:** `finishReason` is not `tool_use` or empty `toolCalls`.

---

## 6. Error handling (invalid model)

**Description:** Unknown model returns a structured error JSON body.

```bash
curl -sS -X POST "${BASE}/generate" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "does-not-exist-xyz",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "hi" }] }
    ]
  }' | jq .
```

**Example response:**

```json
{
  "error": {
    "code": "invalid_request",
    "message": "Unknown model: does-not-exist-xyz"
  }
}
```

**Pass:** HTTP 400; body has `error.code` and `error.message`.

**Fail:** HTTP 200 or missing `error` object.

---

## 7. DeepSeek live (optional)

**Requires:** `DEEPSEEK_API_KEY` set to a real key in `.env`. Restart server.

Repeat scenarios **3**, **4**, and **5** with `"model": "deepseek-chat"` in the JSON body.

```bash
curl -sS -X POST "${BASE}/generate" \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "deepseek-chat",
    "messages": [
      { "role": "user", "content": [{ "type": "text", "text": "Reply with exactly: pong" }] }
    ]
  }' | jq .
```

**Pass:** HTTP 200; `provider` is `"deepseek"`; `model` is `"deepseek-chat"`; text content present; usage tokens > 0.

**Fail:** Auth/network errors, or mock provider used instead of DeepSeek.

**Skip** if `DEEPSEEK_API_KEY` is unset.

---

## 8. Anthropic live (optional)

**Requires:** `ANTHROPIC_API_KEY` in `.env`.

**Note:** Anthropic adapter is scaffold-only in v1; `buildProviderConfigs` does not register Anthropic yet. Expect failure or skip until the adapter lands.

If enabled in a future release, repeat scenarios 3–5 with:

```json
"model": "claude-sonnet-4-20250514"
```

**Pass (when supported):** HTTP 200; `provider` reflects Anthropic; valid completion/stream/tool response.

**Skip** until adapter is implemented.

---

## 9. OpenAI live (optional)

**Requires:** `OPENAI_API_KEY` in `.env`.

**Note:** OpenAI Responses adapter is scaffold-only in v1; provider is not registered yet.

When supported, repeat scenarios 3–5 with a configured OpenAI model id.

**Skip** until adapter is implemented.

---

## Self-test runner

Automated quick check (health + one generate):

```bash
pnpm exec tsx tests/smoke/run.ts
```

Expect `smoke self-test passed` on stdout and exit code 0.
