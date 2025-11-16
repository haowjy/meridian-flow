# Multi-User Chats

**Current**: Single user per chat

**Future**: Multiple users in same chat

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
  socket.on('join_chat', ({ chatId, userId }) => {
    socket.join(chatId);
    socket.to(chatId).emit('user_joined', { userId });
  });

  socket.on('typing', ({ chatId, userId }) => {
    socket.to(chatId).emit('user_typing', { userId });
  });

  socket.on('message', ({ chatId, message }) => {
    socket.to(chatId).emit('new_message', { message });
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
enum ChatPermission {
  Read = 'read',
  Write = 'write',
  Admin = 'admin',
}

interface ChatMember {
  userId: string;
  permission: ChatPermission;
  joinedAt: Date;
}
```

## Priority

**Low** - Complex infrastructure, niche use case
