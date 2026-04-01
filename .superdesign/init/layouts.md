# Layout Components

No layout components exist yet. Frontend-v2 is in Phase 2 (atoms). Layouts are Phase 6.

## Planned Layouts

### AppShell
- Contains Rail (48px left) + active mode layout
- All three mode shells mounted simultaneously, switched via CSS visibility

### StudioLayout (editor-primary)
- 4-pane: Rail | Explorer (~200px) | Editor (~60%) | Chat Sidecar (~40%)
- `react-resizable-panels` for all dividers

### ConverseLayout (chat-primary)
- 3-pane: Rail | Thread (~55%) | Editor (~45%, collapsible)

### AgentsLayout (orchestration)
- 3-pane: Rail | Work Dashboard | Thread Detail

### Rail
- 48px fixed width, 3 mode icons (Agents, Converse, Studio)
- 24px icons with tooltips
- Keyboard shortcuts: Cmd+1, Cmd+2, Cmd+3
