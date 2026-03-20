# File-First Agents & Skills

## Problem

Current skill storage uses a dual model: DB table (`project_skills`) for content + metadata, hidden folder (`/.meridian/skills/<name>/`) for references. This creates:
- Sync complexity (`sync_state`, `is_dirty`, `source_template_version_id`)
- Two sources of truth that can diverge
- Import/export requires translation between DB and file formats
- Not portable — can't just copy files to another harness

## Decision

Collapse to **one storage model**: `.agents/` folder in the project document tree, using the industry-standard layout. The files ARE the configuration. The `project_skills` DB table is removed in two phases — see Migration Path below.

## Design

### Storage

`.agents/` is a regular folder in the project's document tree. Its contents follow the standard layout:

```
.agents/
├── agents/
│   ├── writing-coach.md      # YAML frontmatter (model, description, skills) + system prompt
│   ├── continuity-checker.md
│   └── editor-voice.md
└── skills/
    ├── story-bible/
    │   ├── SKILL.md           # YAML frontmatter (name, description) + instructions
    │   └── resources/
    │       └── example-bible.md
    └── prose-analysis/
        ├── SKILL.md
        └── resources/
```

### Two Views

1. **Explorer** — hides `.agents/` (filtered out like `.git`). Writers don't see it in their file tree.
2. **Settings UI** — dedicated "Agents & Skills" panel accessible from project settings or nav rail. Reads `.agents/` folder and renders a management interface:
   - List installed agents and skills
   - Toggle enabled/disabled
   - Edit model selection, description, permissions (writes YAML frontmatter)
   - Toggle model invocation / user invocable flags
   - View/edit skill instructions (opens in editor or inline)
   - Import from git button

### The Settings UI Is a View Over Files

Every interaction in the settings UI maps to a file operation:

| UI Action | File Operation |
|-----------|---------------|
| Toggle skill enabled | Set `enabled: false` in SKILL.md frontmatter |
| Change agent model | Update `model:` in agent .md frontmatter |
| Edit skill instructions | Update SKILL.md body content |
| Add reference doc | Create file under `resources/` |
| Delete agent | Delete the .md file |
| Import from git | Clone repo's `.agents/` into project's `.agents/` folder |
| Reorder skills | Update `position:` frontmatter field |

### Import from Git

1. User pastes a git URL (or picks from marketplace later)
2. Backend clones/fetches the `.agents/` directory from the repo
3. Files are created as documents in the project's `.agents/` folder
4. Settings UI immediately reflects the new agents/skills
5. No DB migration, no sync state, no import pipeline — it's just files

### What Gets Removed (Phase 2 — deferred)

The `project_skills` DB table and all its machinery are removed in Phase 2 (Round 2+), after the Settings UI exists to verify migration:
- `project_skills` table (content, position, enabled, metadata, sync_state, is_dirty, etc.)
- `SkillImportService`, `SkillPackagePolicy`, `ComponentHandler` registry
- Dual-namespace export (`.meridian/skills/` + `.agents/skills/`)
- `skill_invoke` tool's DB lookup — replaced with file read from `.agents/skills/<name>/SKILL.md`

### What Stays

- Skill invocation in LLM streaming — reads from `.agents/skills/` in document tree instead of DB
- Skill-scoped resources — already stored as documents under the skill folder
- Hidden folder filtering — `.agents/` hidden from explorer (same mechanism as `/.meridian/`)

### Backend Changes

- New document tree filter: hide `.agents/` from explorer API responses
- Skill resolver: read `SKILL.md` from document tree instead of `project_skills` table
- Agent resolver: read agent `.md` from document tree, parse YAML frontmatter for model/config
- Git import endpoint: `POST /api/projects/{id}/agents/import-git` — clone + create documents
- Migration: move existing `project_skills` data into `.agents/skills/` documents, drop table

### Frontend Changes

- Explorer: filter `.agents/` from tree display
- New "Agents & Skills" settings panel
  - Lists agents and skills from `.agents/` folder
  - YAML frontmatter editor for config fields
  - Inline SKILL.md editor or link to full editor
  - Import from git flow (URL input, preview, confirm)
  - Enable/disable toggles

## Portability

A Meridian project's `.agents/` folder is directly compatible with:
- Claude Code (`.agents/` in repo root)
- Any harness that reads the standard format
- CLI ↔ Flow convergence (same files, two interfaces)

Export is just: zip the `.agents/` folder. Import is just: unzip into the document tree.

## Migration Path

Migration is two-phase to match the implementation plan (A3):

### Phase 1 — Round 0: Backfill + Dual-Read

1. Read all `project_skills` rows
2. For each: create `.agents/skills/<name>/SKILL.md` document with frontmatter + content
3. Move references from `/.meridian/skills/<name>/references/` to `.agents/skills/<name>/resources/`
4. Update skill resolver to dual-read: try file first (`.agents/skills/<name>/SKILL.md`), fall back to `project_skills` DB row if file not found

**Do NOT drop `project_skills` table yet** — dual-read ensures no regressions while the file-based system is validated.

### Phase 2 — Round 2+: Drop Table

After the Settings UI (F12) can display and verify all skills from the file tree:

5. Confirm all skills round-trip correctly through the Settings UI
6. Drop `project_skills` table and all associated machinery
