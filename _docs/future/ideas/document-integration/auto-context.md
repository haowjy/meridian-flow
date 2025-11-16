# Automatic Context Detection

**Current**: User manually adds context

**Future**: AI suggests relevant documents

## Features

- Analyze message content
- Suggest related documents
- One-click add to context
- Learn from user preferences

## Example

```
User: "Is this scene consistent with Elara's character?"

[AI suggestion]
💡 Add Characters/Elara to context?
   [Add] [Ignore] [Always add]
```

## Benefits

- Faster context building
- Reduced friction
- Smarter assistance

## Implementation

### Detection Logic

```typescript
const detectRelevantDocuments = async (message: string) => {
  // 1. Extract potential document names
  const mentions = extractPotentialMentions(message);

  // 2. Search document tree
  const matches = await searchDocuments(mentions);

  // 3. Use AI to confirm relevance (optional)
  const relevant = await ai.filterRelevant(message, matches);

  return relevant;
};
```

### Suggestion UI

```tsx
<ContextSuggestion>
  <Icon>💡</Icon>
  <Text>Add {document.name} to context?</Text>
  <ButtonGroup>
    <Button onClick={handleAdd}>Add</Button>
    <Button onClick={handleIgnore}>Ignore</Button>
    <Button onClick={handleAlways}>Always add</Button>
  </ButtonGroup>
</ContextSuggestion>
```

### Learning Preferences

```typescript
interface ContextPreference {
  pattern: string; // e.g., "Elara"
  documentId: string;
  autoAdd: boolean;
}

// Save preference
const savePreference = (pattern: string, documentId: string, autoAdd: boolean) => {
  await db.contextPreferences.add({
    pattern,
    documentId,
    autoAdd,
  });
};

// Apply preferences
const applyPreferences = async (message: string) => {
  const preferences = await db.contextPreferences.toArray();

  for (const pref of preferences) {
    if (message.includes(pref.pattern) && pref.autoAdd) {
      addToContext(pref.documentId);
    }
  }
};
```

## Priority

**High** - Significantly improves UX, leverages document integration
