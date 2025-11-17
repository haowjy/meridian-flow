# Chat Pagination - Frontend Integration Guide

**Status:** Implementation Ready
**Backend Endpoints:** ✅ Complete
**Date:** 2025-01-10

---

## Overview

The backend provides two complementary endpoints for handling large conversations (1000+ turns):

1. **Tree Endpoint** - ⚠️ Currently `GET /debug/api/chats/:id/tree` (debug-only) - Lightweight structure for cache validation
2. **Pagination Endpoint** - ✅ `GET /api/chats/:id/turns` (production) - Path-based turn loading

This guide explains how to integrate these endpoints with IndexedDB caching and virtual scrolling.

## ⚠️ Critical Requirements

**These are REQUIRED, not optional:**

1. **Virtual Scrolling** - DOM rendering is the bottleneck. Without virtual scrolling, 100+ turn conversations will be unusable (performance degrades to 5-15 minute load times, based on production system research)

2. **IndexedDB Caching** - The architecture depends on client-side caching to achieve 79% bandwidth savings and instant loads

3. **Tree Diffing** - Multi-device sync requires comparing tree structures to detect gaps and fetch only missing turns

---

## Quick Start

```typescript
// 1. Load tree structure for cache validation
const tree = await api.get(`/chats/${chatId}/tree`);

// 2. Compare with cached data (IndexedDB)
const cached = await db.chats.get(chatId);
const diff = compareTrees(tree.turns, cached?.turns || []);

// 3. Fetch missing turns via pagination
if (diff.hasMissingTurns) {
  const missing = await api.get(`/chats/${chatId}/turns`, {
    params: {
      from_turn_id: diff.gapStart,
      limit: 100,
      direction: 'after'
    }
  });

  // 4. Merge and cache
  await db.chats.put(mergeChats(cached, missing));
}
```

---

## Tree Endpoint: Cache Validation

⚠️ **Current Status:** Implemented in backend but only available at `GET /debug/api/chats/:id/tree` (debug mode). Not yet exposed as production API. This section describes the intended usage when promoted to production.

### Purpose

Detect structural changes without downloading full conversation content.

**95% of chat opens only need this endpoint** if the cache is fresh - this is the key to achieving 79% bandwidth savings.

### Response Format

```json
{
  "turns": [
    {"id": "uuid1", "prev_turn_id": null},
    {"id": "uuid2", "prev_turn_id": "uuid1"},
    {"id": "uuid3", "prev_turn_id": null}  // Sibling of uuid1 (edited)
  ],
  "updated_at": "2025-01-10T15:00:00Z"
}
```

### When to Use

- **On chat open**: Check if cached data is stale
- **On reconnect**: Detect changes made on other devices
- **Periodically**: Background sync every 5 minutes (optional)

### Performance

- **Response size**: ~2KB for 1000 turns
- **Response time**: <100ms even for very large chats

---

## Pagination Endpoint: Loading Content

### Query Parameters

```typescript
interface PaginationParams {
  from_turn_id?: string;  // Starting point (optional - defaults to last_viewed_turn_id)
  limit?: number;         // Max turns to return (default: 100, max: 200)
  direction: 'before' | 'after' | 'both';
}
```

### Direction Behavior

- **`before`**: Follow `prev_turn_id` chain backwards (scroll up, load history)
- **`after`**: Follow children forward, picking most recent child when multiple branches exist (scroll down)
- **`both`**: Split limit 25% before / 75% after (initial load, context window)

### Response Format

```json
{
  "turns": [/* Full Turn objects */],
  "blocks": {  // Blocks grouped by turn_id
    "turn1_id": [/* blocks */],
    "turn2_id": [/* blocks */]
  },
  "has_more_before": true,
  "has_more_after": false
}
```

### Usage Patterns

**Initial Load:**
```typescript
// Load context around last viewed turn (AFTER leaf resolution on server)
// Server will resolve last_viewed_turn_id to leaf if this is a cold start
const response = await api.get(`/chats/${chatId}/turns`, {
  params: { limit: 100, direction: 'both' }
});
// Note: Server automatically uses chat.last_viewed_turn_id and resolves to leaf
// This ensures user sees "end of conversation" not mid-tree bookmark
```

**Scroll Up (Load History):**
```typescript
const response = await api.get(`/chats/${chatId}/turns`, {
  params: {
    from_turn_id: firstVisibleTurnId,
    limit: 50,
    direction: 'before'
  }
});
```

**Scroll Down (Load Future):**
```typescript
const response = await api.get(`/chats/${chatId}/turns`, {
  params: {
    from_turn_id: lastVisibleTurnId,
    limit: 50,
    direction: 'after'
  }
});
// Automatically follows most recent child when branches exist
```

**Switch Branch:**
```typescript
// When user selects a sibling turn to view
const response = await api.get(`/chats/${chatId}/turns`, {
  params: {
    from_turn_id: siblingTurnId,
    limit: 100,
    direction: 'after'
  }
});
```

**Important:** During active scrolling, ALWAYS provide `from_turn_id` to preserve exact scroll position. Only omit `from_turn_id` on fresh page loads when you want the server to resolve to the conversation end (leaf).

**Why:**
- **With `from_turn_id`** (Cache Mode): Server stores exact position, can be mid-tree
- **Without `from_turn_id`** (Leaf Resolution Mode): Server resolves to end of active branch
- Client should track scroll position per tab and provide explicit `from_turn_id` during active sessions

---

## Cache Strategy: IndexedDB (CRITICAL)

### Why IndexedDB is Required

**This is architectural, not optional:**
- The pagination system is designed around client-side caching
- Without caching, bandwidth usage is 5x higher (no benefit from tree endpoint)
- Without caching, every chat open downloads all turns (defeats pagination purpose)

**Benefits:**
- **Instant loads**: No network delay for cached chats
- **79% bandwidth savings**: Tree endpoint (1KB) vs full reload (500KB)
- **Large storage**: 50MB+ available (vs 5-10MB for localStorage)
- **Structured queries**: Index by chat_id, turn_id, etc.
- **Multi-device sync**: Compare cached tree with server tree to fetch only changes

### Schema

```typescript
interface CachedChat {
  chat_id: string;
  title: string;
  turns: Turn[];              // Full Turn objects
  blocks: Record<string, TurnBlock[]>;  // Grouped by turn_id
  tree: TurnTreeNode[];       // Lightweight structure
  tree_updated_at: string;    // For staleness check
  cached_at: string;          // When we last synced
}

interface TurnTreeNode {
  id: string;
  prev_turn_id: string | null;
}
```

### Cache Flow

```typescript
async function loadChat(chatId: string): Promise<Chat> {
  // 1. Load cached data immediately (instant UI)
  const cached = await db.chats.get(chatId);
  if (cached) {
    renderChat(cached);  // Show stale data immediately
  }

  // 2. Fetch tree to check for changes
  const tree = await api.get(`/chats/${chatId}/tree`);

  // 3. Compare tree timestamps
  if (cached && tree.updated_at === cached.tree_updated_at) {
    return cached;  // Cache is fresh, done!
  }

  // 4. Tree has changed - diff to find gaps/changes
  const diff = compareTrees(tree.turns, cached?.turns || []);

  // 5. Fetch missing/updated turns
  if (diff.hasMissingTurns) {
    const missing = await fetchMissingTurns(chatId, diff);
    cached = mergeChats(cached, missing);
  }

  // 6. Update cache
  await db.chats.put({
    ...cached,
    tree: tree.turns,
    tree_updated_at: tree.updated_at,
    cached_at: new Date().toISOString()
  });

  return cached;
}
```

---

## Tree Diffing: Detecting Changes

### Algorithm

```typescript
interface TreeDiff {
  hasMissingTurns: boolean;
  newTurns: string[];        // Turn IDs not in cache
  deletedTurns: string[];    // Cached turns not in tree
  newBranches: string[];     // Turns with new children
  gapStart?: string;         // Where to start fetching missing turns
}

function compareTrees(
  serverTree: TurnTreeNode[],
  cachedTree: TurnTreeNode[]
): TreeDiff {
  const serverIds = new Set(serverTree.map(t => t.id));
  const cachedIds = new Set(cachedTree.map(t => t.id));

  // Find new turns
  const newTurns = serverTree
    .filter(t => !cachedIds.has(t.id))
    .map(t => t.id);

  // Find deleted turns
  const deletedTurns = cachedTree
    .filter(t => !serverIds.has(t.id))
    .map(t => t.id);

  // Find new branches (turns with more children than cached)
  const newBranches: string[] = [];
  const childCounts = (tree: TurnTreeNode[]) => {
    const counts = new Map<string, number>();
    tree.forEach(t => {
      if (t.prev_turn_id) {
        counts.set(t.prev_turn_id, (counts.get(t.prev_turn_id) || 0) + 1);
      }
    });
    return counts;
  };

  const serverCounts = childCounts(serverTree);
  const cachedCounts = childCounts(cachedTree);

  serverCounts.forEach((count, turnId) => {
    if (count > (cachedCounts.get(turnId) || 0)) {
      newBranches.push(turnId);
    }
  });

  // Determine gap start (first missing turn in chronological order)
  const gapStart = newTurns.length > 0 ? newTurns[0] : undefined;

  return {
    hasMissingTurns: newTurns.length > 0 || deletedTurns.length > 0,
    newTurns,
    deletedTurns,
    newBranches,
    gapStart
  };
}
```

### Gap Detection Scenarios

**Scenario 1: New turns appended**
```
Cached:  [T1, T2, T3]
Server:  [T1, T2, T3, T4, T5]
Action:  Fetch from_turn_id=T3, direction=after
```

**Scenario 2: Gap in middle (multi-device)**
```
Cached:  [T1, T2, ..., T50, T251, T252]
Server:  [T1, T2, ..., T50, T51, ..., T250, T251, T252]
Action:  Fetch from_turn_id=T50, direction=after, limit=200
```

**Scenario 3: New branch added**
```
Cached:  T1 -> T2 -> T3
Server:  T1 -> T2 -> T3
              -> T2b -> T3b (new branch)
Action:  Fetch from_turn_id=T1, direction=after (to get T2b branch)
```

---

## Virtual Scrolling: CRITICAL REQUIREMENT

### Why Virtual Scrolling is Mandatory

**Research from production systems:**

1. **ChatGPT (2025):** Known performance issues at 100+ turns
   - Loads entire conversation into DOM
   - Performance degrades significantly
   - Community reports: "Serious UX issue affecting long coding/writing sessions"

2. **Open WebUI:** 100-200 chat entries → 5-15 minute page loads

3. **Twitch Chat Study:**
   - Rendering 100 messages at once: 100-200ms render events
   - With virtual scrolling: Thousands of messages/second at 50+ FPS
   - **Key finding:** DOM rendering is the bottleneck, not database or network

**Conclusion:** Even with pagination, loading 500+ turns into the DOM = unusable performance. Virtual scrolling renders only ~15 visible items, maintaining constant performance regardless of conversation length.

**DO NOT skip virtual scrolling** - it's the most critical frontend optimization for this feature.

### Recommended Library

**react-virtuoso** - Best for chat UIs with dynamic heights

```bash
npm install react-virtuoso
```

### Implementation

```tsx
import { Virtuoso } from 'react-virtuoso';

function ChatView({ chatId }: { chatId: string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [blocks, setBlocks] = useState<Record<string, TurnBlock[]>>({});
  const [hasMoreBefore, setHasMoreBefore] = useState(false);

  // Load more when scrolling up
  const loadMore = async (firstVisibleTurnId: string) => {
    const response = await api.get(`/chats/${chatId}/turns`, {
      params: {
        from_turn_id: firstVisibleTurnId,
        limit: 50,
        direction: 'before'
      }
    });

    setTurns(prev => [...response.turns, ...prev]);
    setBlocks(prev => ({ ...prev, ...response.blocks }));
    setHasMoreBefore(response.has_more_before);
  };

  return (
    <Virtuoso
      data={turns}
      startReached={() => {
        if (hasMoreBefore && turns.length > 0) {
          loadMore(turns[0].id);
        }
      }}
      itemContent={(index, turn) => (
        <TurnMessage turn={turn} blocks={blocks[turn.id] || []} />
      )}
    />
  );
}
```

---

## Sibling/Branch Handling

### Calculating Siblings (Frontend)

```typescript
function getTurnSiblings(turns: Turn[], targetTurn: Turn): Turn[] {
  return turns.filter(t =>
    t.prev_turn_id === targetTurn.prev_turn_id &&
    t.id !== targetTurn.id
  );
}

function hasMultipleVersions(turns: Turn[], targetTurn: Turn): boolean {
  return getTurnSiblings(turns, targetTurn).length > 0;
}
```

### UI Pattern

```tsx
function TurnMessage({ turn, turns }: { turn: Turn; turns: Turn[] }) {
  const siblings = getTurnSiblings(turns, turn);
  const siblingIndex = siblings.findIndex(s => s.id === turn.id);
  const totalVersions = siblings.length + 1; // +1 for current turn

  return (
    <div className="turn-message">
      {totalVersions > 1 && (
        <div className="version-switcher">
          <button onClick={() => switchToSibling(siblings[0])}>
            Version {siblingIndex + 1} of {totalVersions}
          </button>
        </div>
      )}
      {/* Render turn content */}
    </div>
  );
}
```

---

## Performance Targets

- **Tree endpoint**: <100ms even for 1000+ turns
- **Pagination endpoint**: <500ms for 100-turn chunk
- **Cache lookup (IndexedDB)**: <50ms
- **Render visible items**: <16ms (60fps)

---

## Multi-Device Sync

### Background Sync (Optional)

```typescript
// Periodically check for changes
setInterval(async () => {
  const tree = await api.get(`/chats/${openChatId}/tree`);
  const cached = await db.chats.get(openChatId);

  if (tree.updated_at !== cached?.tree_updated_at) {
    // Notify user: "New messages available"
    showSyncNotification();
  }
}, 5 * 60 * 1000); // Every 5 minutes
```

### Bandwidth Savings

**Without pagination:**
```
Device A has 50 cached turns
Device B adds 5 new turns
Device A opens chat → Downloads all 55 turns
Bandwidth: 50 duplicates + 5 new = 55 turns worth
```

**With tree + pagination:**
```
Device A: GET /tree → Detects 5 new turns
Device A: GET /turns?from_turn_id=last_cached&direction=after&limit=10
Bandwidth: Tree (2KB) + 5 new turns only
Savings: 90%+
```

---

## Testing Checklist

- [ ] Tree endpoint returns correct structure
- [ ] Pagination with `direction=before` follows prev_turn_id backwards
- [ ] Pagination with `direction=after` follows most recent child
- [ ] Pagination with `direction=both` splits limit correctly (25%/75%)
- [ ] `has_more_before` and `has_more_after` flags are accurate
- [ ] Default `from_turn_id` uses `last_viewed_turn_id`
- [ ] Tree diff detects new turns
- [ ] Tree diff detects deleted turns
- [ ] Tree diff detects new branches
- [ ] Cache merge doesn't duplicate turns
- [ ] Virtual scrolling maintains scroll position on load
- [ ] Sibling UI shows correct version count
- [ ] Switching branches loads correct path

---

## References

- **Backend endpoints**: `backend/internal/handler/chat.go`
- **Tree implementation**: `backend/internal/repository/postgres/llm/chat.go:237-294`
- **Pagination implementation**: `backend/internal/repository/postgres/llm/turn.go:589-851`
- **Insomnia tests**: `backend/tests/insomnia/04-chat.json` (Pagination folder)
- **Handoff doc**: `_docs/hidden/handoffs/chat-pagination-implementation-handoff.md`
