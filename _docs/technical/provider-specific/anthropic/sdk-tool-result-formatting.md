# SDK Tool Result Formatting

## Go SDK Limitation

The `anthropic-sdk-go` helper for creating tool results only supports **text content**:

```go
func NewToolResultBlock(toolUseID string, content string, isError bool) ContentBlockParamUnion {
    toolBlock := ToolResultBlockParam{
        ToolUseID: toolUseID,
        Content: []ToolResultBlockParamContentUnion{
            {OfText: &TextBlockParam{Text: content}},  // ← Always text
        },
        IsError: Bool(isError),
    }
    return ContentBlockParamUnion{OfToolResult: &toolBlock}
}
```

**Source**: `anthropic-sdk-go@v1.17.0/message.go:838-847`

## Supported Content Types

`ToolResultBlockParamContentUnion` supports:
- `OfText` - TextBlockParam
- `OfImage` - ImageBlockParam
- `OfSearchResult` - SearchResultBlockParam
- `OfDocument` - DocumentBlockParam

**No `OfParsedJSON` field exists.**

## Our Use Case: Structured Tool Results

Our tools return structured data (search results, document trees, etc.), not plain text:

```json
{
  "count": 7,
  "has_more": false,
  "results": [
    {
      "id": "...",
      "name": "Aria Moonwhisper",
      "preview": "# Aria Moonwhisper...",
      "score": 0.182
    }
  ]
}
```

## Solution: Serialize to Pretty JSON

Convert structured data to JSON string before passing to SDK helper.

**See**: `backend/meridian-llm-go/providers/anthropic/adapter.go:106-112`

```go
// Priority order for tool result content:
// 1. TextContent field (backwards compat)
// 2. Content["content"] string (backwards compat)
// 3. Content["result"] (structured data - serialize to JSON)
// 4. Content["error"] (error message string)

if result, ok := block.Content["result"]; ok && !isError {
    // Serialize structured result to pretty JSON for LLM readability
    resultJSON, err := json.MarshalIndent(result, "", "  ")
    if err != nil {
        return nil, fmt.Errorf("failed to serialize tool result: %w", err)
    }
    resultContent = string(resultJSON)
}

blocks = append(blocks, anthropic.NewToolResultBlock(toolUseID, resultContent, isError))
```

## Result Format

API receives:

```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_01...",
  "content": [
    {
      "type": "text",
      "text": "{\n  \"count\": 7,\n  \"results\": [...]\n}"
    }
  ],
  "is_error": false
}
```

The LLM receives structured data as readable JSON text.

## Trade-offs

**Pros**:
- Works with current SDK
- LLM can read and understand the structure
- Pretty formatting improves readability

**Cons**:
- Extra serialization step
- Content is text, not native JSON (no semantic difference for LLM)
- Larger token count than compact JSON

## Alternative Approaches

### Manual Construction (Not Used)

Could bypass SDK helper and build `ToolResultBlockParam` manually, but offers no advantage since SDK ultimately serializes to JSON anyway.

### Wait for SDK Update (Future)

If SDK adds native support for structured content (e.g., `OfParsedJSON`), we could pass `interface{}` directly. Monitor SDK releases.

## Storage Format

In our database, tool results are stored as:

```json
{
  "tool_use_id": "toolu_01...",
  "is_error": false,
  "result": {
    "count": 7,
    "results": [...]
  }
}
```

**No pre-serialization**. Structured data preserved until API conversion.

**See**: `backend/internal/service/llm/streaming/mstream_adapter.go:471-482`
