# Features

## Story File Placement

Co-locate stories next to their component by default:

```
components/ui/button.tsx
components/ui/Button.stories.tsx
```

Move to a `stories/` subdirectory when stories need helpers, multiple files, or shared test utilities:

```
editor/Editor.tsx
editor/stories/Collaboration.stories.tsx
editor/stories/helpers/CollabEditor.tsx
editor/stories/helpers/mockContent.ts
```

Either way, the rules below apply.

## Story Development Rules

### Modify the component, not the story

When a story reveals a problem — wrong behavior, missing variant, bad styling — fix the **underlying component**. Stories are test harnesses, not the product. If you find yourself adding logic, wrappers, or overrides inside a story to make it look right, that's a signal the component needs work.

### Stories share the component's mock data

Each feature directory should have shared mock factories used by all its stories. Never create parallel mock data in individual story files — when the component changes, parallel mocks drift and the stories silently stop reflecting reality.

Bad:
```tsx
// BashDetail.stories.tsx — its own mock, different shape from ActivityBlock stories
const mockTool = { name: "Bash", input: { cmd: "ls" }, output: "..." }
```

Good:
```tsx
// ActivityBlock.stories.tsx — shared factories used everywhere
function bashTool(id: string, command: string, status: ToolItem["status"] = "done"): ToolItem { ... }

// Other stories import and reuse these factories
```

### Test through the real component tree

If a component is always rendered inside a parent (e.g., tool details inside ActivityBlock), stories should test it through that parent. Isolated stories that bypass the real rendering path don't catch integration issues and create a maintenance burden when the parent's API changes.

Exception: a component with its own complex API that genuinely works standalone (e.g., FloatingScrollLayout).

### When refactoring a component, update its stories in the same pass

Stories that compile but show stale behavior are worse than stories that break — they give false confidence. When you change a component's props, state management, or rendering behavior, update every story that touches it before moving on.

### Component self-containment over story wrappers

If every story wraps a component in the same `<div>` with the same padding/layout, that wrapper belongs inside the component (or as a `className` prop). The component should "just work" when imported.

Example: ActivityBlock renders its own response text below the card. Stories don't need to manually extract and render response text — that's the component's job.
