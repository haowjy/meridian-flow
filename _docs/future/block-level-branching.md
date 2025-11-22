# Block-Level Branching

**Status:** Future enhancement
**Audience:** Developer
**Detail:** Standard

## Problem

Users cannot branch conversations mid-assistant-turn. They must wait for the assistant to complete before responding with an alternative direction.

**Current limitation:**
```
Turn 1 (assistant):
  Block 0: thinking "I'll use the search tool..."
  Block 1: tool_use (doc_search)
  Block 2: tool_result
  Block 3: text "Based on the search results..."
  ← User must wait until here to branch

Turn 2 (user):
  "Actually, don't search, just summarize what you know"
```

**Desired capability:**
```
Turn 1 (assistant):
  Block 0: thinking "I'll use the search tool..."
  Block 1: tool_use (doc_search)
  ← User interrupts here

Turn 1b (assistant, forked):
  Block 0: thinking "I'll use the search tool..."
  ← Stops here (blocks 1-3 removed)

Turn 2 (user):
  "Actually, don't search, just summarize what you know"
```

## Concept

Enable users to **branch from any block** in an assistant turn by:

1. **Forking the assistant turn** - Create sibling turn with blocks 0 through N
2. **Creating user turn** - User provides alternative direction
3. **Building context** - New assistant turn sees: Turn 1b → Turn 2 (user) → Turn 3 (assistant continues)

### Use Cases

- **Interrupt thinking** - "Don't overthink this, just answer"
- **Stop tool execution** - "Don't use that tool, try a different approach"
- **Redirect mid-response** - "Stop, you're going the wrong direction"
- **Explore alternatives** - Fork after tool_use to see different tool parameters

## Architecture Changes

### Database Schema

Add `branch_from_block_id` to `turns` table:

```sql
ALTER TABLE turns
ADD COLUMN branch_from_block_id UUID REFERENCES turn_blocks(id);
```

**Semantics:**
- `NULL` = Normal turn (includes all blocks from source turn)
- `UUID` = Forked turn (includes only blocks up to specified block)

### Message Building

Update `buildMessagesFromPath()` in `/backend/internal/service/llm/conversation/`:

```go
func (s *Service) buildMessagesFromPath(ctx context.Context, path []*models.Turn) ([]llm.Message, error) {
    var messages []llm.Message

    for _, turn := range path {
        blocks := turn.Blocks

        // If turn is branched, truncate blocks
        if turn.BranchFromBlockID != nil {
            blocks = filterBlocksUpTo(blocks, *turn.BranchFromBlockID)
        }

        messages = append(messages, llm.Message{
            Role:   turn.Role,
            Blocks: convertBlocks(blocks),
        })
    }

    return messages, nil
}
```

### API Changes

**Create Turn Endpoint** (`POST /api/chats/:chatId/turns`):

Add optional field:
```json
{
  "prev_turn_id": "turn-123",
  "branch_from_block_id": "block-456",  // NEW
  "role": "user",
  "blocks": [...]
}
```

**Branching Flow:**
1. User clicks "Branch from here" on Block 2 in Turn 1
2. Frontend calls `POST /api/chats/:chatId/turns/branch`:
   ```json
   {
     "source_turn_id": "turn-1",
     "branch_from_block_id": "block-2"
   }
   ```
3. Backend creates:
   - Turn 1b (assistant, sibling of Turn 1, references block-2)
   - Turn 2 (user, child of Turn 1b)
4. Frontend navigates to Turn 2 for user input

## Frontend Changes

### Block UI

Add "Branch from here" button to each block:

```tsx
// In AssistantTurn.tsx or block components
<BlockContainer>
  {block.content}
  <BlockActions>
    <button onClick={() => handleBranchFromBlock(block.id)}>
      Branch from here
    </button>
  </BlockActions>
</BlockContainer>
```

### Turn Navigation

Update `useChatStore` to handle forked turns:

```typescript
// When building turn path, respect branch_from_block_id
const buildTurnPath = (turn: Turn): Turn[] => {
  const path = []
  let current = turn

  while (current.prevTurnId) {
    const parent = getTurn(current.prevTurnId)

    // If current turn branches from specific block, truncate parent
    if (current.branchFromBlockId) {
      parent.blocks = parent.blocks.filter(b =>
        b.blockIndex <= getBlockIndex(current.branchFromBlockId)
      )
    }

    path.unshift(parent)
    current = parent
  }

  return path
}
```

## Implementation Complexity

**Estimated effort:** 2-3 days

**Breakdown:**
- Schema migration + models: 2 hours
- Backend message building: 3 hours
- API endpoints: 2 hours
- Frontend UI: 4 hours
- Testing: 4 hours
- Documentation: 1 hour

**Dependencies:**
- None (independent feature)

**Risks:**
- Confusing UX (need clear visual indication of forked turns)
- Database bloat (forked turns duplicate blocks)
- Catchup complexity (need to handle partial turn updates)

## Open Questions

1. **UI/UX:** How to visually show forked turns in chat history?
2. **Permissions:** Can users branch from other users' assistant turns?
3. **Limits:** Should there be a max fork depth to prevent tree explosion?
4. **Optimization:** Should we deduplicate blocks across forked turns?

## Related Docs

- `_docs/technical/backend/chat/turn-navigation.md` - Turn path traversal
- `_docs/technical/backend/chat/llm-providers.md` - Message building
- `_docs/plans/tool-continuation.md` - Related to tool_use branching use case
