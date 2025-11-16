# Document Reference Blocks

**Current**: Chat and documents separate

**Future**: Reference documents directly in chat

## Features

- @mention documents in chat
- Create reference blocks
- Show document preview
- Link to open in editor

## Example

```
User: "Review this against @Characters/Elara"

[Document block: Characters/Elara]
  Last updated: 2 hours ago
  [View in editor] [Add as context]
```

## Benefits

- Tight integration
- Easy context addition
- Reduced copy-paste

## Implementation

### @mention Autocomplete

```tsx
const MentionInput = () => {
  const [suggestions, setSuggestions] = useState<Document[]>([]);

  const handleInput = (text: string) => {
    if (text.includes('@')) {
      const query = text.split('@').pop();
      const matches = searchDocuments(query);
      setSuggestions(matches);
    }
  };

  return (
    <Textarea>
      {suggestions.length > 0 && (
        <Autocomplete>
          {suggestions.map(doc => (
            <AutocompleteItem onClick={() => insertMention(doc)}>
              {doc.name}
            </AutocompleteItem>
          ))}
        </Autocomplete>
      )}
    </Textarea>
  );
};
```

### Reference Block

```typescript
interface DocumentReferenceBlock {
  type: 'document_reference';
  documentId: string;
  documentName: string;
  lastUpdated: Date;
}
```

### Rendering

```tsx
<DocumentReferenceBlock
  documentId={block.documentId}
  documentName={block.documentName}
  lastUpdated={block.lastUpdated}
  onView={() => openInEditor(block.documentId)}
  onAddToContext={() => addToContext(block.documentId)}
/>
```

## Priority

**High** - Core feature for document-chat integration
