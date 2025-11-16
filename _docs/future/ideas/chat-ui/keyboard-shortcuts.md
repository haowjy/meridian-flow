# Keyboard Shortcuts

**Current**: Enter to send, Shift+Enter for newline

**Future**: Comprehensive keyboard navigation

## Shortcuts

- `Cmd/Ctrl + K`: Copy message
- `Cmd/Ctrl + E`: Edit message
- `Cmd/Ctrl + R`: Regenerate
- `Cmd/Ctrl + N`: New chat
- `Up/Down`: Navigate message history
- `Esc`: Cancel edit mode
- `Cmd/Ctrl + /`: Show shortcuts help

## Benefits

- Power user efficiency
- Better accessibility
- Reduced mouse usage

## Implementation

### Shortcut Handler

```typescript
const useKeyboardShortcuts = () => {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const isMod = e.metaKey || e.ctrlKey;

      if (isMod && e.key === 'k') {
        e.preventDefault();
        copySelectedMessage();
      }

      if (isMod && e.key === 'e') {
        e.preventDefault();
        editSelectedMessage();
      }

      if (isMod && e.key === 'r') {
        e.preventDefault();
        regenerateSelectedMessage();
      }

      if (isMod && e.key === 'n') {
        e.preventDefault();
        createNewChat();
      }

      if (e.key === 'Escape') {
        cancelEditMode();
      }

      if (isMod && e.key === '/') {
        e.preventDefault();
        showShortcutsHelp();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
};
```

### Shortcuts Help Dialog

```tsx
<Dialog>
  <DialogTitle>Keyboard Shortcuts</DialogTitle>
  <DialogContent>
    <ShortcutList>
      <Shortcut keys="⌘K" action="Copy message" />
      <Shortcut keys="⌘E" action="Edit message" />
      <Shortcut keys="⌘R" action="Regenerate" />
      <Shortcut keys="⌘N" action="New chat" />
      <Shortcut keys="↑↓" action="Navigate messages" />
      <Shortcut keys="Esc" action="Cancel edit" />
      <Shortcut keys="⌘/" action="Show shortcuts" />
    </ShortcutList>
  </DialogContent>
</Dialog>
```

## Priority

**Medium** - Great for power users, simple to implement
