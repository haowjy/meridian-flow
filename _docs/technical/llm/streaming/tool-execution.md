---
detail: standard
audience: developer
---

# Tool Execution Flow

How LLM tool calling works in the streaming system.

## Complete Tool Call Cycle

```mermaid
sequenceDiagram
    participant Client
    participant Executor as StreamExecutor
    participant Provider as Anthropic
    participant Tool as Tool Executor
    participant DB as PostgreSQL

    Note over Provider: LLM decides to use tool

    Provider-->>Executor: StreamEvent{Delta (tool_use)}
    Executor->>Client: SSE: block_start {block_index, block_type: "tool_use"}
    Executor->>Client: SSE: block_delta {delta_type: "json_delta", json_delta: "{...}"}

    Note over Executor: Persist tool_use block when complete Block arrives

    Provider-->>Executor: StreamEvent{Block (tool_use)}
    Executor->>DB: INSERT turn_blocks<br/>(block_type: "tool_use", content: {...})

    Note over Executor: Execute tool (for client-executed tools)

    Executor->>Tool: ExecuteTool(name, input)
    Tool-->>Executor: ToolResult {output: "..."}

    Note over Executor: Create tool_result block

    Executor->>DB: INSERT turn_blocks<br/>(block_type: "tool_result", content: {...})
    Executor->>Client: SSE: block_start {block_index, block_type: "tool_result"}
    Executor->>Client: SSE: block_delta {delta_type: "text_delta", text_delta: "Result..."}
    Executor->>Client: SSE: block_stop {block_index}

    Note over Executor: Send tool result back to LLM (if provider expects it)

    Executor->>Provider: ContinueWithToolResult(result)

    Note over Provider: LLM continues with result

    Provider-->>Executor: StreamEvent{Delta (text)}
    Executor->>Client: SSE: block_start {block_index, block_type: "text"}
    Executor->>Client: SSE: block_delta {delta_type: "text_delta", text_delta: "..."}

    Provider-->>Executor: StreamEvent{Metadata}
    Executor->>DB: UPDATE turns SET status="complete"
    Executor->>Client: SSE: turn_complete
```

---

## TurnBlock Sequence with Tools

**Example turn with tool execution:**

```sql
-- Turn ID: abc-123
-- Assistant requests tool, tool executes, assistant continues

sequence | block_type  | text_content                    | content (JSONB)
---------|-------------|----------------------------------|----------------------------------
0        | thinking    | "I need to check the file..."   | {"signature": "4k_a"}
1        | text        | "Let me read the file."         | null
2        | tool_use    | null                            | {"tool_use_id": "toolu_1", "tool_name": "read_file", "input": {"path": "..."}}
3        | tool_result | null                            | {"tool_use_id": "toolu_1", "content": "file contents..."}
4        | thinking    | "Now I can see that..."         | {"signature": "4k_a"}
5        | text        | "Based on the file, I found..." | null
```

---

## Multiple Tool Calls

**LLM can request multiple tools in one response:**

```sql
sequence | block_type  | text_content               | content (JSONB)
---------|-------------|----------------------------|----------------------------------
0        | text        | "Let me check both files." | null
1        | tool_use    | null                       | {"tool_name": "read_file", "input": {"path": "a.txt"}}
2        | tool_use    | null                       | {"tool_name": "read_file", "input": {"path": "b.txt"}}
3        | tool_result | null                       | {"tool_use_id": "toolu_1", "content": "a.txt contents"}
4        | tool_result | null                       | {"tool_use_id": "toolu_2", "content": "b.txt contents"}
5        | text        | "Comparing both files..."  | null
```

---

## Tool Execution Phases

### 1. LLM Requests Tool

Provider streams `tool_use` block:
```json
{
  "block_type": "tool_use",
  "content": {
    "tool_use_id": "toolu_abc123",
    "tool_name": "read_file",
    "input": {
      "path": "/path/to/file.txt"
    }
  }
}
```

### 2. StreamExecutor Persists Tool Request

- `StreamExecutor.processCompleteBlock` persists the `tool_use` `TurnBlock` when the library emits a complete Block.

### 3. Consumer Executes Tool (Client-Side Tools)

- For client-executed tools (e.g., `bash`, `text_editor`, custom tools), the backend:
  - Inspects `tool_use` blocks.
  - Executes the corresponding tool in application code.
  - Writes a `tool_result` block with `content.tool_use_id` and `is_error`.

### 4. Provider-Executed Tools (Server-Side)

- For provider-executed tools (e.g., Anthropic web search):
  - Provider runs the tool; results arrive as `web_search_result` blocks.
  - Backend does not execute a local tool; it only persists the result blocks.

---

## Tool Result Propagation

**Flow:**
1. LLM requests tool
2. Executor executes tool synchronously
3. Tool result added to message history
4. LLM receives result and continues response

**Message history after tool execution:**
```json
[
  {"role": "user", "content": "Read file.txt"},
  {"role": "assistant", "content": [
    {"type": "text", "text": "Let me read the file."},
    {"type": "tool_use", "id": "toolu_1", "name": "read_file", "input": {...}}
  ]},
  {"role": "user", "content": [
    {"type": "tool_result", "tool_use_id": "toolu_1", "content": "file contents"}
  ]},
  {"role": "assistant", "content": [
    {"type": "text", "text": "Based on the file..."}
  ]}
]
```

---

## Error Handling

### Tool Execution Fails

```go
// Tool returns error
result := &ToolResult{
    ToolUseID: toolUseID,
    Content:   "",
    IsError:   true,
    Error:     "File not found: /path/to/file.txt",
}

// Still create tool_result block
block := TurnBlock{
    BlockType: "tool_result",
    Content: map[string]interface{}{
        "tool_use_id": result.ToolUseID,
        "is_error":    true,
        "content":     result.Error,
    },
}
```

LLM receives error and can adjust response.

### Tool Timeout

```go
ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
defer cancel()

result, err := tool.ExecuteWithContext(ctx, input)
if err != nil {
    if ctx.Err() == context.DeadlineExceeded {
        return &ToolResult{
            IsError: true,
            Error:   "Tool execution timed out after 30s",
        }, nil
    }
    return nil, err
}
```

---

## References

**Implementation:**
- Streaming: `backend/internal/service/llm/streaming/mstream_adapter.go`
- Backend tool handling: see `_docs/technical/backend/llm-integration.md`

**Related:**
- [Streaming Architecture](../architecture/streaming-architecture.md)
- [Turn Blocks](../chat/turn-blocks.md)
- [API Endpoints](api-endpoints.md)
