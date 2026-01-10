# Auto-Collapse Large Messages

**Current**: All message content visible

**Future**: Automatically collapse messages over threshold

## Criteria

- Messages > 1,000 words
- Messages with large code blocks
- User preference setting

## UI

```
[Message preview - first 200 words...]

[Show more (800 words remaining)]
```

## Benefits

- Faster scrolling
- Less overwhelming interface
- User controls detail level

## Implementation

### Auto-Collapse Logic

```typescript
const shouldAutoCollapse = (message: Message) => {
  const wordCount = message.content.split(/\s+/).length;
  const hasLargeCodeBlock = message.content.includes('```') &&
                            message.content.split('```').length > 2;

  return wordCount > 1000 || hasLargeCodeBlock;
};
```

### Component

```tsx
const CollapsibleMessage = ({ message }: { message: Message }) => {
  const [isCollapsed, setIsCollapsed] = useState(
    shouldAutoCollapse(message)
  );

  if (!isCollapsed) {
    return <FullMessage message={message} />;
  }

  return (
    <div>
      <MessagePreview content={message.content} maxWords={200} />
      <Button onClick={() => setIsCollapsed(false)}>
        Show more ({getRemainingWordCount(message)} words)
      </Button>
    </div>
  );
};
```

### Settings

```
[ ] Auto-collapse messages over 1,000 words
    Collapse threshold: [1000 ▼] words
```

## Priority

**Low** - Nice-to-have, simple to implement
