# Phase 1: Yjs-first Editor

## Goal

Replace the controlled `value`/`onChange` editor contract with a Yjs-native one, keep the existing decoration/interaction stack intact, and leave Storybook running on the new API before any session/pool work starts.

## Dependencies

- None

## Parallelism

- `P1.1` must land first.
- `P1.2` depends on `P1.1`.
- `P1.3` and `P1.4` can run in parallel after `P1.2` because they touch different story/demo surfaces.

## Step Summary

| Step | Outcome | Risk | Recommended model |
|---|---|---|---|
| P1.1 | One shared Yjs-native extension builder replaces `createMeridianExtensions()` | Medium | `gpt-5.3-codex` |
| P1.2 | `Editor.tsx` becomes uncontrolled and creates its own local Yjs session when needed | High | `gpt-5.4` |
| P1.3 | Single-doc stories and helpers migrate to the new editor API | Medium | `gpt-5.3-codex` |
| P1.4 | Tabbed stories and remaining callsites stop using the deleted extension helper | Low | `gpt-5.3-codex` |

### Step P1.1: Replace Duplicate Extension Builders With One Yjs-native Stack

**Scope and intent**

Build a single `createEditorExtensions()` function that every editor surface uses. This step should keep the existing decoration, formatting, paste, and interaction behavior, but remove the CM6-history branch and the duplicate builder split between `Editor.tsx` and `extensions.ts`.

**Files to create or modify**

- `frontend-v2/src/editor/extensions.ts` - rename/rewrite to export the new `createEditorExtensions()` contract
- `frontend-v2/src/editor/collab/yjs-binding.ts` - split reusable CM6 binding helpers from doc-scoped session creation
- `frontend-v2/src/editor/collab/undo-manager.ts` - keep origin policy, remove the assumption that undo swaps between CM6 and Yjs
- `frontend-v2/src/editor/Editor.tsx` - consume the shared extension builder instead of assembling its own stack inline

**Interface contracts**

```ts
export interface EditorExtensionCompartments {
  readOnly: Compartment
  placeholder: Compartment
  livePreview: Compartment
  extra: Compartment
}

export interface CreateEditorExtensionsConfig {
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  compartments: EditorExtensionCompartments
  readOnly?: boolean
  placeholder?: string
  livePreview?: boolean
  extra?: Extension[]
}

export function createEditorExtensions(
  config: CreateEditorExtensionsConfig,
): Extension[]

export interface LocalEditorSession {
  ydoc: Y.Doc
  ytext: Y.Text
  awareness: Awareness
  undoManager: Y.UndoManager
  destroy(): void
}

export function createLocalEditorSession(): LocalEditorSession
```

**Patterns to follow**

- Keep the current import ordering and stack composition from `frontend-v2/src/editor/Editor.tsx`.
- Preserve the tracked-origin policy already encoded in `frontend-v2/src/editor/collab/undo-manager.ts`.
- Keep `Prec.high(keymap.of(yUndoManagerKeymap))` ahead of `defaultKeymap`.

**Constraints and boundaries**

- Do not change decoration behavior in this step beyond wiring it through the shared builder.
- Do not introduce `DocSession`, `SessionPool`, or transport code here.
- Do not keep a `createMeridianExtensions()` compatibility export. Rip the bandage off now while the callsite set is still small.

**Verification criteria**

- `rg "createMeridianExtensions" frontend-v2/src` returns no matches after all Phase 1 steps are complete.
- `pnpm run lint` passes in `frontend-v2/`.
- `pnpm run build-storybook` passes in `frontend-v2/`.
- Undo/redo still works in stories through `Y.UndoManager`, not CM6 history.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f .meridian/work/v1-launch/features/editor/editor-collab.md
-f frontend-v2/src/editor/Editor.tsx
-f frontend-v2/src/editor/extensions.ts
-f frontend-v2/src/editor/collab/yjs-binding.ts
-f frontend-v2/src/editor/collab/undo-manager.ts
```

### Step P1.2: Rewrite `Editor.tsx` Around `Y.Text`

**Scope and intent**

Change `Editor` from a controlled React wrapper into a thin Yjs-backed mount-once wrapper. When `ytext` is provided, the caller owns the Yjs resources. When it is not provided, `Editor` must create a local session and expose it through `sessionRef`.

**Files to create or modify**

- `frontend-v2/src/editor/Editor.tsx` - new props, internal local-session fallback, remove value reconciliation effect
- `frontend-v2/src/editor/EditorShell.tsx` - pass through the new editor props and stop expecting `value`/`onChange`
- `frontend-v2/src/editor/content/content-api.ts` - keep the pull-based API stable if any type updates are needed

**Interface contracts**

```ts
export interface EditorProps {
  ytext?: Y.Text
  awareness?: Awareness
  undoManager?: Y.UndoManager
  readOnly?: boolean
  placeholder?: string
  livePreview?: boolean
  extensions?: Extension[]
  className?: string
  contentApiRef?: React.RefObject<EditorContentAPI | null>
  sessionRef?: React.RefObject<{
    ydoc: Y.Doc
    ytext: Y.Text
    awareness: Awareness
    undoManager: Y.UndoManager
  } | null>
  onReady?: (view: EditorView) => void
}
```

**Patterns to follow**

- Preserve the current "create once, reconfigure via compartments" pattern from `frontend-v2/src/editor/Editor.tsx`.
- Preserve `contentApiRef` and the current update-listener-based word count path.
- Reuse the existing root/view refs and `EditorContextMenu` placement.

**Constraints and boundaries**

- No `value` prop.
- No `onChange` prop.
- No `collabSession` prop. The parent passes `ytext`, `awareness`, and `undoManager` directly.
- Do not solve persistence or websocket lifecycle in this step. Internal sessions are local-only and in-memory.

**Verification criteria**

- `Editor` mounts with no `ytext` prop and exposes a live session through `sessionRef`.
- Typing changes `sessionRef.current?.ytext?.toString()` without React state mediation.
- Existing content API consumers still read content/word counts successfully.
- No effect remains that replaces the full document from a React string prop.

**Context files (`-f`)**

```text
-f .meridian/work/v1-launch/features/editor/editor-refactor-design.md
-f frontend-v2/src/editor/Editor.tsx
-f frontend-v2/src/editor/EditorShell.tsx
-f frontend-v2/src/editor/extensions.ts
-f frontend-v2/src/editor/content/content-api.ts
-f frontend-v2/src/editor/collab/yjs-binding.ts
```

### Step P1.3: Migrate Single-doc Story Helpers And Stories

**Scope and intent**

Move the single-document stories off React `useState` document ownership. Story helpers should either let `Editor` create the session or explicitly create a Yjs session and observe it through `sessionRef`.

**Files to create or modify**

- `frontend-v2/src/editor/stories/helpers/StandaloneEditor.tsx` - stop keeping editor content in React state
- `frontend-v2/src/editor/stories/helpers/CollabEditor.tsx` - pass `ytext`, `awareness`, and `undoManager` directly
- `frontend-v2/src/editor/stories/Collaboration.stories.tsx` - keep the simulated server harness working with the new props
- `frontend-v2/src/editor/stories/LivePreview.stories.tsx`
- `frontend-v2/src/editor/stories/InteractionModel.stories.tsx`

**Interface contracts**

```ts
export interface StandaloneEditorProps {
  initialContent: string
  livePreview?: boolean
  withShell?: boolean
  className?: string
}
```

The helper may add a local `sessionRef`, seed initial content into the internal `Y.Text` once on mount, and then treat Yjs as the source of truth.

**Patterns to follow**

- Reuse the existing `SimulatedServer` pattern from `stories/helpers/SimulatedServer.ts`.
- Keep story chrome lightweight; verification belongs in the editor behavior, not in custom control scaffolding.

**Constraints and boundaries**

- Do not add production persistence or WS providers to Storybook in this step.
- Do not change the story catalog structure unless a story no longer makes sense under the new API.

**Verification criteria**

- `LivePreview`, `InteractionModel`, and `Collaboration` stories render in Storybook.
- `StandaloneEditor` no longer mirrors content through React `useState`.
- `CollabEditor` still shows remote cursors and synced typing via the simulated server.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/Editor.tsx
-f frontend-v2/src/editor/stories/helpers/StandaloneEditor.tsx
-f frontend-v2/src/editor/stories/helpers/CollabEditor.tsx
-f frontend-v2/src/editor/stories/Collaboration.stories.tsx
-f frontend-v2/src/editor/stories/LivePreview.stories.tsx
-f frontend-v2/src/editor/stories/InteractionModel.stories.tsx
-f frontend-v2/src/editor/stories/helpers/SimulatedServer.ts
```

### Step P1.4: Migrate Tabbed Stories And Remove The Old Export Surface

**Scope and intent**

Update the tabbed demo stories so nothing in `frontend-v2/src/editor/` still imports `createMeridianExtensions()` or the deleted controlled editor props.

**Files to create or modify**

- `frontend-v2/src/editor/TabbedEditor.stories.tsx`
- `frontend-v2/src/editor/stories/CollabTabs.stories.tsx`
- `frontend-v2/src/editor/TabbedEditorShell.tsx` if prop names need cleanup

**Interface contracts**

Use the `createEditorExtensions()` contract from `P1.1` and the uncontrolled `Editor` contract from `P1.2`. Do not invent a second tabbed-story-specific extension helper.

**Patterns to follow**

- Keep the current story layout and tab chrome.
- Reuse any remaining per-tab `EditorView` bootstrapping only as a temporary story concern; Phase 3 will replace it with `useDocumentSessions()`.

**Constraints and boundaries**

- This step is migration only. Do not start SessionPool/ViewController work here.
- It is acceptable for the tabbed stories to remain story-only scaffolding until Phase 3.

**Verification criteria**

- `TabbedEditor` and `CollabTabs` stories compile and render.
- `rg "value=" frontend-v2/src/editor/stories frontend-v2/src/editor/TabbedEditor.stories.tsx` shows no `Editor` value prop usage.
- `rg "createMeridianExtensions" frontend-v2/src/editor` returns no matches.

**Context files (`-f`)**

```text
-f frontend-v2/src/editor/TabbedEditor.stories.tsx
-f frontend-v2/src/editor/stories/CollabTabs.stories.tsx
-f frontend-v2/src/editor/TabbedEditorShell.tsx
-f frontend-v2/src/editor/extensions.ts
-f frontend-v2/src/editor/Editor.tsx
```
