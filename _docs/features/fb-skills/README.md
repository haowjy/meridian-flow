# Skills Feature

**Status**: ✅ Complete (MVP)

**Stack**: Full-stack (backend API + frontend UI)

**Version**: 1.0 (h/skills branch)

## Overview

Skills are custom AI commands that writers can create and invoke in chat threads. They appear as first-class tree items alongside documents in the workspace, with dedicated editing UI and persistent storage.

## User Experience

### Discovery

- Skills appear in the document tree under a collapsible "Skills" section
- Sparkles icon (✨) indicates AI-powered functionality
- Count badge shows total number of skills
- "+" button allows creating new skills

### Creation

- Click "+" button in skills section
- Modal dialog with three fields:
  - **Command Name**: URL-safe name (e.g., `writing-coach`)
  - **Description**: Brief summary shown in list
  - **Instructions**: Full markdown content (edited after creation)
- Command name becomes the invocation handle: `/writing-coach`

### Editing

- Click skill in tree -> opens full-screen editor
- Three-field form at top:
  - Command name (with `/` prefix visual)
  - Description (flexible-height textarea)
  - Instructions (CodeMirror markdown editor)
- **Manual save** with Save/Cancel buttons in header
- Dirty state tracking: buttons appear only when changes exist
- Save status indicator shows "Saving...", "Saved", or error message

### Navigation

- Skills use URL pattern: `/projects/{slug}/skills/{name}`
- Deep linking works (bookmark/share skill URLs)
- Browser back/forward supported
- Clicking same skill toggles editor off

### Invocation (Not Yet Implemented)

- Type `/skill-name` in chat thread
- Skill instructions are injected into the conversation context
- AI responds according to skill instructions

## Technical Implementation

### Backend API

**Endpoints** (all under `/api/projects/{projectId}/skills`):
- `GET /` - List all skills for project
- `POST /` - Create new skill
- `GET /{skillId}` - Get skill with content
- `PUT /{skillId}` - Update skill (supports partial updates)
- `DELETE /{skillId}` - Delete skill

**Database Schema**:
```sql
CREATE TABLE project_skills (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  instance_folder_id UUID NOT NULL REFERENCES folders(id),
  name TEXT NOT NULL,         -- URL-safe command name (also the display label)
  description TEXT NOT NULL,
  position INTEGER NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  sync_state TEXT NOT NULL DEFAULT 'detached',
  is_dirty BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(project_id, name)
);
```

**Validation Rules**:
- Name: lowercase alphanumeric + hyphens only, max 50 chars
- Description: max 500 chars
- Content: max 10,000 chars

**Location**: `backend/internal/handler/project_skill.go`, `backend/internal/service/skill/project_skill.go`

### Frontend Implementation

#### Store Integration

**SkillStore** (`useSkillStore`):
- Manages skills list for current project
- Network-first loading (no IndexedDB caching for MVP)
- Actions: `loadSkills()`, `createSkill()`, `updateSkill()`, `deleteSkill()`
- Status tracking: `idle | loading | success | error`

**UIStore** (`useUIStore`):
- `activeSkillId: string | null` - Currently open skill editor
- Mutually exclusive with `activeDocumentId`
- Persists across sessions (remembers last-opened skill)

#### Component Architecture

**Tree Integration**:
- `CollapsibleSkillsSection` - Skills section in tree (root level)
  - Sparkles icon + count badge
  - "+" button for creation
  - Collapsible (starts expanded)
- `SkillTreeItem` - Individual skill in tree (leaf node)
  - Wrapped by `SelectableTreeItem` for selection feedback
  - Click -> opens `SkillEditorPanel`
  - Context menu -> rename/delete (to be implemented)

**Editor Panels**:
- `SkillEditorPanel` - Full-screen editor for existing skills
  - Shared `SkillForm` component for form fields
  - CodeMirror for markdown instructions
  - Manual save with dirty-state tracking
  - Save/Cancel buttons in header (appear when changes exist)
  - Network-first load (no cache)

- `SkillCreatePanel` - Full-screen panel for creating new skills
  - Same `SkillForm` component as editor
  - Create/Cancel buttons in header
  - Navigates to editor after successful creation

**Location**: `frontend/src/features/skills/`

#### Navigation Pattern

Uses same bidirectional URL-state sync as documents:

**Forward** (user clicks skill):
1. `openSkill(skillId, projectSlug, skillName)` helper called
2. Updates UI state immediately (instant feedback)
3. Navigates to `/projects/{slug}/skills/{name}`
4. WorkspaceLayout effect confirms state matches URL

**Backward** (browser back):
1. URL changes to `/projects/{slug}/skills/{name}`
2. WorkspaceLayout effect parses URL
3. Resolves skill name -> skill ID via skills store
4. Updates UI state to match URL
5. Editor opens

**Deep Linking**:
- Direct navigation to `/projects/{slug}/skills/{name}` works
- Shows "Loading skill..." while skills are loading
- Opens editor once skill is resolved
- Redirects to project if skill not found

**Location**:
- Helpers: `frontend/src/core/lib/panelHelpers.ts`
- URL sync: `frontend/src/features/workspace/components/WorkspaceLayout.tsx`

### Mutual Exclusivity

Skills and documents share the same editor area and cannot both be open:

**Enforcement**:
```typescript
setActiveSkill: (id) => {
  set({ activeSkillId: id, activeDocumentId: null })  // Clear document
}

setActiveDocument: (id) => {
  set({ activeDocumentId: id, activeSkillId: null })  // Clear skill
}
```

**Why?** Single editor area in the UI. Opening a skill closes the document editor and vice versa.

### Manual Save Implementation

**Pattern**: Dirty-state tracking with explicit Save/Cancel

```typescript
// Track if user has made changes vs saved baseline
const hasChanges = skill && (
  localName !== skill.name ||
  localDescription !== skill.description ||
  localContent !== skill.content
)

// Handle explicit save
const handleSave = useCallback(async () => {
  if (!skill || !canSave) return
  setSaveStatus('saving')

  const updates: { name?: string; description?: string; content?: string } = {}
  if (normalizedName !== skill.name) updates.name = normalizedName
  if (localDescription.trim() !== skill.description) updates.description = localDescription.trim()
  if (localContent.trim() !== skill.content) updates.content = localContent.trim()

  await updateSkill(projectId, skillId, updates)
  setSaveStatus('saved')
  setTimeout(() => setSaveStatus('idle'), 1500)
}, [skill, canSave, localName, localDescription, localContent, ...])

// Handle cancel - revert to saved values
const handleCancel = useCallback(() => {
  if (!skill) return
  setLocalName(skill.name)
  setLocalDescription(skill.description)
  setLocalContent(skill.content)
}, [skill])
```

**Why manual save?** Skills are typically edited less frequently than documents. Manual save gives users explicit control and avoids unnecessary API calls during composition.

### Save Status Indicator

Visual feedback shown in header (only when `hasChanges` or status is non-idle):

- **Saving...**: Text indicator during save
- **Saved**: Success text (fades after 1.5s)
- **Error message**: Shows API error (e.g., duplicate name conflict)

**Implementation**: Header trailing slot with conditional rendering based on `saveStatus` and `hasChanges` states.

## What's Not Implemented (Future)

### Skill Invocation
- Typing `/skill-name` in chat doesn't work yet
- Backend thread handler needs to detect skill commands
- Skill instructions need to be injected into conversation context

### Skill Management
- No rename in tree (must edit name in editor)
- No context menu on skill items
- No reordering/sorting skills

### Advanced Features
- No skill parameters/variables (e.g., `/summarize length=short`)
- No skill chaining/composition
- No skill versioning/history
- No skill sharing between projects
- No skill templates/library

### Performance Optimizations
- No IndexedDB caching (network-first only)
- No skill search/filtering
- No lazy loading for large skill lists

## Known Issues

### Race Condition: Deep Link Loading

**Symptom**: Navigating to `/projects/{slug}/skills/{name}` before skills finish loading shows "Select a document or skill to edit" briefly, then opens editor.

**Fix Applied**: DocumentPanel now shows "Loading skill..." skeleton when:
- `isLoadingSkills = true`
- `effectiveSkillName` is present (URL has skill name)
- `activeSkillId` is undefined (skill not resolved yet)

**Result**: Smooth loading experience for deep links.

### Validation Edge Cases

**Name validation**: Backend validates format (lowercase alphanumeric + hyphens), but frontend dialog doesn't show real-time validation. User must submit to see error.

**Recommendation**: Add real-time validation to SkillDialog (debounced, non-blocking).

## Testing Recommendations

### Integration Tests

- [ ] Create skill via panel -> appears in tree
- [ ] Edit skill -> save button appears, saves on click
- [ ] Edit skill -> cancel reverts to saved values
- [ ] Click skill -> opens editor with correct data
- [ ] Browser back after opening skill -> closes editor
- [ ] Deep link to skill -> shows loading, then opens editor
- [ ] Delete skill -> removes from tree and closes editor
- [ ] Duplicate skill name -> shows validation error in header

### State Management Tests

- [ ] Opening skill closes active document
- [ ] Opening document closes active skill
- [ ] Switching projects clears active skill
- [ ] Active skill persists across page refresh

### Navigation Tests

- [ ] Skill URL includes project slug + skill name
- [ ] Browser back/forward syncs editor state
- [ ] Same-skill click toggles editor off
- [ ] Bookmark/share skill URL works

### Manual Save Tests

- [ ] Save button disabled when no changes
- [ ] Save button disabled when validation fails
- [ ] Save button enabled when valid changes exist
- [ ] Cancel reverts all fields to saved values
- [ ] Save status shows correct indicator (saving -> saved -> idle)

## Related Documentation

- **Layout System**: `_docs/technical/frontend/architecture/layout-system.md`
- **Navigation Pattern**: `_docs/technical/frontend/architecture/navigation-pattern.md`
- **Backend Skills Handler**: `backend/internal/handler/skills.go`
- **Frontend Skills Components**: `frontend/src/features/skills/components/`
- **UI Store**: `frontend/src/core/stores/useUIStore.ts`

## Migration Guide (For Other Branches)

If merging h/skills branch into another branch that has diverged, follow these steps:

### 1. Database Migration
Run migration to add `skills` table (see `backend/schema.sql` for schema).

### 2. Theme Color Migration
The theme system was refactored from v2 -> v3:
- `accent` -> split into `favorite` (gold) and `primary` (sage)
- Search codebase for `accent` usage and replace with appropriate semantic color
- Update any custom themes to include `favorite` and `primary` colors

### 3. API Client
Ensure `frontend/src/core/lib/api.ts` includes skills endpoints:
```typescript
skills: {
  list: (projectId: string) => ...,
  get: (projectId: string, skillId: string) => ...,
  create: (projectId: string, data: CreateSkillRequest) => ...,
  update: (projectId: string, skillId: string, data: UpdateSkillRequest) => ...,
  delete: (projectId: string, skillId: string) => ...,
}
```

### 4. Routes
Add TanStack Router routes:
```typescript
// frontend/src/routes/_authenticated/projects/$slug/skills/$skillName.tsx
```

### 5. Store Setup
Ensure `useSkillStore` and `useUIStore` changes are merged (see `frontend/src/core/stores/`).

### 6. Testing
After merge, test all critical flows (see Testing Recommendations above).
