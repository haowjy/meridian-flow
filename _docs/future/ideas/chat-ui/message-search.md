# Message Search

**Current**: No search functionality

**Future**: Full-text search across all chats

## Features

- Search by content, date, chat title
- Fuzzy matching
- Highlight results
- Jump to message in chat

## UI

Search bar in chat list panel:

```
┌─────────────────────────────┐
│ [🔍 Search messages...]     │
├─────────────────────────────┤
│ Chat 1                      │
│ Chat 2                      │
│ ...                         │
└─────────────────────────────┘
```

## Benefits

- Find past conversations
- Reference previous discussions
- Better organization

## Implementation

### Search Strategy

**Client-side** (IndexedDB):
- Fast, works offline
- Limited to cached messages (last 100 per chat)

**Server-side** (PostgreSQL full-text search):
- Complete history
- More powerful queries

**Hybrid approach**:
- Search IndexedDB first (instant results)
- Then search API (comprehensive results)

### Backend

```sql
-- Add full-text search index
CREATE INDEX messages_content_fts ON messages
USING gin(to_tsvector('english', content));

-- Search query
SELECT * FROM messages
WHERE to_tsvector('english', content) @@ plainto_tsquery('search query')
ORDER BY ts_rank(to_tsvector('english', content), plainto_tsquery('search query')) DESC;
```

### Frontend

```typescript
const searchMessages = async (query: string) => {
  // 1. Search IndexedDB (instant)
  const localResults = await db.messages
    .filter(m => m.content.toLowerCase().includes(query.toLowerCase()))
    .toArray();

  setResults(localResults);

  // 2. Search API (comprehensive)
  const apiResults = await api.messages.search(query);
  setResults(apiResults);
};
```

### Search UI

```tsx
<SearchResults>
  {results.map(result => (
    <SearchResultItem
      key={result.id}
      message={result}
      query={query}
      onNavigate={() => openChat(result.chatId, result.id)}
    />
  ))}
</SearchResults>
```

## Priority

**High** - Essential for finding past conversations
