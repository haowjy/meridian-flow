# Message Threads & Branching

**Current**: Linear conversation

**Future**: Branch conversations, compare responses

## Features

- Create branch from any message
- Compare regenerated responses side-by-side
- Merge branches
- Visual tree of conversation branches

## Use Case

Explore multiple creative directions without losing previous responses

## Benefits

- Non-destructive editing
- Compare AI responses
- Explore alternatives

## Implementation

### Data Model

```typescript
interface Turn {
  id: string;
  parentTurnId: string | null; // Branch point
  branches: Turn[]; // Alternative responses
  selectedBranchId: string | null;
}
```

### UI

```
User message
├─ Assistant response A (selected)
├─ Assistant response B
└─ Assistant response C

[+ Generate alternative]
[⚖️ Compare branches]
```

### Branching Logic

```typescript
const createBranch = async (turnId: string) => {
  // 1. Get parent message
  const turn = await getTurn(turnId);

  // 2. Create new turn with same parent
  const newTurn = await createTurn({
    parentTurnId: turn.parentTurnId,
    messageId: turn.messageId,
  });

  // 3. Stream new response
  await streamTurnResponse(newTurn.id);
};
```

### Comparison View

```tsx
<ComparisonView>
  <BranchColumn branch={branchA}>
    <AssistantMessage message={branchA.message} />
  </BranchColumn>

  <BranchColumn branch={branchB}>
    <AssistantMessage message={branchB.message} />
  </BranchColumn>

  <BranchColumn branch={branchC}>
    <AssistantMessage message={branchC.message} />
  </BranchColumn>
</ComparisonView>
```

## Challenges

- Complex state management
- UI complexity
- Storage overhead

## Priority

**Low** - Complex feature, niche use case
