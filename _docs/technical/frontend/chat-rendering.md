---
detail: minimal
audience: developer
---

# Chat Rendering: Streamdown Decision

**Purpose:** Document why Streamdown was chosen for chat message rendering over TipTap and react-markdown.

**See also:**
- `chat-rendering-guide.md` - Implementation guide and best practices
- `architecture/chat-rendering-research.md` - Full research and comparisons

## Decision

**Use Streamdown for chat message rendering.**

TipTap remains for document editing only.

## Why Streamdown

**Problem with TipTap:**
- Designed as rich text **editor**, not lightweight renderer
- Heavy memory/DOM overhead for 100+ message instances
- React performance issues without careful optimization
- Not optimized for read-only rendering

**Problem with react-markdown:**
- Assumes complete markdown documents
- Re-parses entire content on every token during streaming
- ~500 lines causes significant browser lag
- Exponential performance degradation with chat history
- Breaks on incomplete markdown syntax

**Streamdown advantages:**
- **Purpose-built for AI streaming** - handles incomplete/unterminated markdown
- **Memoized rendering** - only re-renders changed portions
- **Drop-in replacement** for react-markdown (same API)
- **Maintained by Vercel** - used in Vercel AI SDK
- Built-in security (rehype-harden)

## Key Capabilities

### 1. Extensibility

**Component override system** (identical to react-markdown):
```typescript
<Streamdown components={{ h1: CustomHeading, code: CustomCode }}>
  {content}
</Streamdown>
```

**Plugin support** (full remark/rehype ecosystem):
```typescript
<Streamdown
  remarkPlugins={[remarkGfm, customPlugin]}
  rehypePlugins={[rehypeKatex, customPlugin]}
>
  {content}
</Streamdown>
```

### 2. Streaming Performance

**Optimal update frequency:** 30-100ms intervals
- Below 30ms: unnecessary overhead
- Above 100ms: looks choppy

**Handles incomplete markdown gracefully:**
- `**bold text` (no closing)
- `` `code `` (unterminated)
- `# heading` (incomplete)
- `[link text](ht` (partial URL)

### 3. Architecture Pattern

**Wrapper approach** (recommended for Meridian):

```typescript
{turn.blocks?.map(block => {
  switch (block.block_type) {
    case 'text':
      return <Streamdown>{block.text_content}</Streamdown>;
    case 'thinking':
      return <ThinkingBlock>
        <Streamdown>{block.text_content}</Streamdown>
      </ThinkingBlock>;
    case 'tool_use':
      return <ToolUseBlock data={block.content} />;
  }
})}
```

**Why wrapper pattern:**
- Backend already sends structured `block_type` via SSE
- Streamdown handles markdown (text/thinking blocks)
- Custom React components handle structured data (tool blocks)
- Clean separation of concerns

## Quick Reference

| Feature | TipTap | react-markdown | Streamdown |
|---------|--------|----------------|------------|
| **Purpose** | Rich text editor | Static markdown render | AI streaming |
| **Streaming** | ⚠️ Has API, not optimized | ❌ Re-parses all content | ✅ Incremental |
| **Incomplete MD** | ❌ No | ❌ Breaks | ✅ Handles gracefully |
| **100+ messages** | ❌ Heavy | ⚠️ Needs optimization | ✅ Memoized |
| **Extensibility** | ✅ Extensions | ✅ Components/plugins | ✅ Components/plugins |
| **Bundle size** | Large (~2MB) | Medium (~125KB) | Medium (~similar) |

## Implementation

See `chat-rendering-guide.md` for:
- Buffering strategy (50ms intervals)
- Integration with SSE/TurnBlockDelta
- Code examples
- Performance optimization

## References

- **Streamdown GitHub:** https://github.com/vercel/streamdown
- **Vercel AI SDK cookbook:** https://ai-sdk.dev/cookbook/next/markdown-chatbot-with-memoization
- **Chrome rendering best practices:** https://developer.chrome.com/docs/ai/render-llm-responses
- **Backend SSE architecture:** `_docs/technical/llm/streaming/README.md`
- **Current frontend implementation:** `frontend/src/features/chats/components/ActiveChatView.tsx`
