# Export Conversation

**Current**: No export functionality

**Future**: Export chats to various formats

## Formats

- **Markdown** (preserves formatting)
- **PDF** (for sharing)
- **JSON** (for archiving)

## Options

- Export single chat
- Export all chats
- Include/exclude thinking blocks
- Include metadata (timestamps, etc.)

## Benefits

- Share conversations
- Archive for reference
- Backup data

## Implementation

### Export Dialog

```tsx
<ExportDialog chat={chat}>
  <RadioGroup label="Format">
    <Radio value="markdown">Markdown</Radio>
    <Radio value="pdf">PDF</Radio>
    <Radio value="json">JSON</Radio>
  </RadioGroup>

  <Checkbox>Include thinking blocks</Checkbox>
  <Checkbox>Include timestamps</Checkbox>
  <Checkbox>Include metadata</Checkbox>

  <Button onClick={handleExport}>Export</Button>
</ExportDialog>
```

### Markdown Export

```typescript
const exportToMarkdown = (chat: Chat, messages: Message[]) => {
  let md = `# ${chat.title}\n\n`;
  md += `*Exported: ${new Date().toISOString()}*\n\n`;

  for (const message of messages) {
    md += `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n`;

    if (message.blocks) {
      for (const block of message.blocks) {
        if (block.type === 'thinking') {
          md += `> **Thinking**: ${block.content}\n\n`;
        }
      }
    }

    md += `${message.content}\n\n`;
    md += `---\n\n`;
  }

  return md;
};
```

### PDF Export

Use library like `jsPDF` or server-side generation:

```typescript
import { jsPDF } from 'jspdf';

const exportToPDF = (chat: Chat, messages: Message[]) => {
  const doc = new jsPDF();

  doc.setFontSize(20);
  doc.text(chat.title, 20, 20);

  let y = 40;
  for (const message of messages) {
    doc.setFontSize(14);
    doc.text(message.role === 'user' ? 'User' : 'Assistant', 20, y);

    doc.setFontSize(12);
    y += 10;
    doc.text(message.content, 20, y, { maxWidth: 170 });

    y += 20;
  }

  doc.save(`${chat.title}.pdf`);
};
```

### JSON Export

```typescript
const exportToJSON = (chat: Chat, messages: Message[]) => {
  const data = {
    chat: {
      id: chat.id,
      title: chat.title,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt,
    },
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      blocks: m.blocks,
      createdAt: m.createdAt,
    })),
    exportedAt: new Date().toISOString(),
  };

  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: 'application/json',
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${chat.title}.json`;
  a.click();
};
```

## Priority

**Medium** - Useful feature, relatively simple to implement
