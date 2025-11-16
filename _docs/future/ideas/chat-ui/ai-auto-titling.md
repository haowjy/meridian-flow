# AI Auto-Titling

**Current**: Chats titled with first few words of first message

**Future**: AI generates meaningful titles, updates as conversation progresses

## Requirements

- Cheaper AI provider (e.g., GPT-4o-mini, Claude Haiku)
- Smart title update logic (when to regenerate)
- User preference toggle (auto vs manual)

## Benefits

- Better chat organization
- Easier to find past conversations
- More professional appearance

## Implementation

### Title Generation Strategy

**On chat creation**:
```
Prompt: "Generate a concise title (max 5 words) for a conversation that starts with: '{first_message}'"
```

**Smart updates**:
- After 5 messages
- After 10 messages
- When topic shifts significantly
- Never update if user manually renamed

### Provider Selection

Use cheapest available provider:
- GPT-4o-mini (~$0.00015 per title)
- Claude Haiku (~$0.00025 per title)
- Gemini Flash (~$0.00010 per title)

### UI/UX

**Settings**:
```
[ ] Auto-generate chat titles
    Provider: [GPT-4o-mini ▼]
    [ ] Update titles as conversation progresses
```

**Inline**:
```
Chat title (auto-generated) [✏️ Edit]
```

## Priority

**High** - Significantly improves chat organization with minimal cost
