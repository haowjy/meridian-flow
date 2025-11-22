# Anthropic Provider Documentation

Provider-specific requirements, quirks, and SDK behaviors for Anthropic (Claude) integration.

## When to Read This

- Implementing tool use with Anthropic API
- Debugging tool execution issues
- Understanding message structure requirements
- Working with the anthropic-sdk-go

## Documents

### [Tool Use Message Structure](./tool-use-message-structure.md)
**Critical API requirement**: Where tool_use and tool_result blocks must appear in message flow.

**Key takeaway**: tool_result blocks MUST be in USER messages (not assistant messages), even though we store them in assistant turns in our DB.

### [SDK Tool Result Formatting](./sdk-tool-result-formatting.md)
Go SDK behavior for formatting tool results.

**Key takeaway**: The `NewToolResultBlock()` helper only supports text content. For structured data, serialize to JSON string.

## General Notes

Most requirements documented here are **Anthropic-specific** API constraints, not general LLM patterns. Other providers may have different rules.
