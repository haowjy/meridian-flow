# Multi-User Threads

**Current**: Single user per thread

**Future**: Multiple users in same thread

## Features

- Invite collaborators
- Show who's typing
- Real-time sync
- Per-user message colors

## Use Case

Team brainstorming, co-writing

## Challenges

- WebSocket infrastructure
- Conflict resolution
- Permissions

## Implementation

### WebSocket Architecture

```typescript
// Server
io.on('connection', (socket) => {
  socket.on('join_thread', ({ threadId, userId }) => {
    socket.join(threadId);
    socket.to(threadId).emit('user_joined', { userId });
  });

  socket.on('typing', ({ threadId, userId }) => {
    socket.to(threadId).emit('user_typing', { userId });
  });

  socket.on('message', ({ threadId, message }) => {
    socket.to(threadId).emit('new_message', { message });
  });
});
```

### Typing Indicator

```tsx
<TypingIndicator>
  {typingUsers.map(user => (
    <span key={user.id}>{user.name} is typing...</span>
  ))}
</TypingIndicator>
```

### Permissions

```typescript
enum ThreadPermission {
  Read = 'read',
  Write = 'write',
  Admin = 'admin',
}

interface ThreadMember {
  userId: string;
  permission: ThreadPermission;
  joinedAt: Date;
}
```

## Priority

**Low** - Complex infrastructure, niche use case
