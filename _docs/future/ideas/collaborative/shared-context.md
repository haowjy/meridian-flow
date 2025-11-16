# Shared Context

**Current**: Each user has separate chats

**Future**: Shared knowledge base

## Features

- Team workspace
- Shared document access
- Collaborative editing
- Activity feed

## Use Case

Writing teams, game dev teams

## Implementation

### Workspace Model

```typescript
interface Workspace {
  id: string;
  name: string;
  members: WorkspaceMember[];
  sharedDocuments: Document[];
  sharedChats: Chat[];
}

interface WorkspaceMember {
  userId: string;
  role: 'owner' | 'editor' | 'viewer';
  joinedAt: Date;
}
```

### Activity Feed

```tsx
<ActivityFeed workspace={workspace}>
  <Activity user="Alice" action="edited" target="Chapter 5" />
  <Activity user="Bob" action="commented on" target="Character: Elara" />
  <Activity user="Alice" action="created chat" target="Plot Discussion" />
</ActivityFeed>
```

## Priority

**Low** - Complex feature, requires workspace infrastructure
