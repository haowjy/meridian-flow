# Copy-Paste Detection & Custom Blocks

**Current**: User pastes content directly into message

**Future**: Detect paste from documents, create collapsible blocks

## Features

- Detect paste from document editor
- Create reference block instead of inline text
- Show preview (first few lines)
- Collapse by default
- Link to source document

## Example

```
User message:
"Review this chapter for consistency:"

[Collapsed block: "Chapter 5" - 2,500 words]
  From: Documents/Chapters/Chapter 5
  [Expand to view content]
```

## Backend Changes

Add block type for document references:

```typescript
interface DocumentReferenceBlock {
  type: 'document_reference';
  documentId: string;
  content: string; // Full content
  preview: string; // First 200 words
  wordCount: number;
}
```

## Benefits

- Cleaner chat interface
- Reduced message clutter
- Context preserved with links
- Easy to reference source

## Implementation

### Detection

**Client-side**:
- Listen for paste events
- Check if source is document editor
- Extract document metadata

**API**:
```typescript
POST /api/messages
{
  content: "Review this chapter",
  blocks: [
    {
      type: "document_reference",
      documentId: "doc_123",
      content: "...", // Full text
      preview: "...", // First 200 words
      wordCount: 2500
    }
  ]
}
```

### UI Component

```tsx
<DocumentReferenceBlock
  documentId={block.documentId}
  preview={block.preview}
  wordCount={block.wordCount}
  onExpand={() => setExpanded(true)}
  onNavigate={() => openDocument(block.documentId)}
/>
```

## Priority

**Medium** - Nice UX improvement, requires backend changes
