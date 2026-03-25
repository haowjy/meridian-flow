# Personas

A persona defines how an agent behaves and what model it uses. Stored at `.agents/agents/<slug>.md` with YAML frontmatter.

## Key Decision: Per-Turn Resolution, Switchable

A thread gets a `persona` slug at creation time, but it can be changed on any subsequent turn. The persona's content (behavior instructions, skills, model, tools) resolves fresh each turn from the file. This supports natural workflows like switching between planning and editing modes within the same conversation.

- Pass `persona` on any turn request to switch
- Set to `null` to revert to default Meridian identity
- If current persona is deleted/invalid, turn fails with `422` -- caller switches to valid persona or clears it (recoverable, not permanent)

**Alternative considered**: Immutable persona per thread. Rejected because writers switch modes (plan -> edit -> review) within a single conversation.

## Frontmatter Specification

Field names align with the Claude Code agent/skill spec where semantics match.

```yaml
---
name: continuity-checker
description: Validates story continuity across chapters
model: claude-sonnet-4-20250514
provider: anthropic
user-invocable: false
disable-model-invocation: false
skills:
  - story-bible
  - timeline-tracker
allowed-tools:
  - str_replace_based_edit_tool
  - doc_search
  - skill_invoke
  - skill_list
temperature: 0.2
max_tokens: 8000
effort: high
---

You are a continuity checker for long-form fiction...
```

### Persona Fields (matches Claude Code agent spec)

| Field | Type | Required | Default | Notes |
|-------|------|----------|---------|-------|
| `name` | string | yes | -- | Unique identifier. Lowercase letters, numbers, hyphens (max 64 chars). |
| `description` | string | yes | -- | When to use this persona. Used for UI display and spawn routing. |
| `model` | string | no | `inherit` | Model identifier, alias (`sonnet`, `opus`, `haiku`), or `inherit` from parent. |
| `provider` | string | no | auto-detected | Provider override (`anthropic`, `openai`, `google`). Inferred from model if omitted. |
| `tools` | string[] | no | inherited | Tools this persona can use. Inherits all tools if omitted. |
| `disallowed-tools` | string[] | no | -- | Tools to deny, removed from inherited or specified list. |
| `skills` | string[] | no | `[]` | Skills loaded into context at startup. Personas don't inherit skills from parent. |
| `max-turns` | int | no | -- | Max agentic turns before the persona stops. Safety cap for runaway agents. |
| `background` | bool | no | `false` | Set `true` to always run this persona as a background task when spawned. |
| `effort` | string | no | inherits | Effort level override. Options: `low`, `medium`, `high`. |
| `temperature` | float | no | provider default | Must be in model's valid range. |
| `max_tokens` | int | no | provider default | Must be > 0. |
| `user-invocable` | bool | no | `true` | Whether this persona appears in the user's picker UI. |
| `disable-model-invocation` | bool | no | `false` | Set `true` to prevent other agents from spawning this persona. |
| `hooks` | object | no | -- | Hooks scoped to this persona's lifecycle. Deferred post-v1. |

### Visibility Combinations

| `user-invocable` | `disable-model-invocation` | Use case |
|---|---|---|
| true | false | General purpose -- user can pick it, agents can spawn it |
| true | true | User-only -- personal assistant, not delegatable |
| false | false | Worker -- hidden from user picker, only spawned by other agents |
| false | true | Draft/disabled -- not available to anyone |

Visibility flags control who can use a persona.

## Skill Visibility

Skills follow the same frontmatter pattern, aligned with Claude Code:

```yaml
---
name: story-bible
description: Maintains character/setting/timeline consistency
user-invocable: true                # user can add this to their conversation
disable-model-invocation: false     # personas can reference this skill
allowed-tools:                      # tools this skill can use without prompting
  - doc_search
---
```

| `user-invocable` | `disable-model-invocation` | Use case |
|---|---|---|
| true | false | General purpose |
| true | true | User-only -- personal writing aid |
| false | false | Internal -- tooling skill only agents use |
| false | true | Draft/disabled |

Both default to `true` / `false` respectively for backwards compatibility.

## Catalog Service

A3's agent catalog does not exist in code yet -- only skills. This design creates it.

```go
package agents

type Persona struct {
    Name                   string   `json:"name" yaml:"name"`
    Slug                   string   `json:"slug"`
    Description            string   `json:"description" yaml:"description"`
    Model                  string   `json:"model,omitempty" yaml:"model"`
    Provider               string   `json:"provider,omitempty" yaml:"provider"`
    Tools                  []string `json:"tools,omitempty" yaml:"tools"`
    DisallowedTools        []string `json:"disallowed_tools,omitempty" yaml:"disallowed-tools"`
    Skills                 []string `json:"skills,omitempty" yaml:"skills"`
    MaxTurns               *int     `json:"max_turns,omitempty" yaml:"max-turns"`
    Background             bool     `json:"background,omitempty" yaml:"background"`
    Effort                 string   `json:"effort,omitempty" yaml:"effort"`
    Temperature            *float64 `json:"temperature,omitempty" yaml:"temperature"`
    MaxTokens              *int     `json:"max_tokens,omitempty" yaml:"max_tokens"`
    UserInvocable          bool     `json:"user_invocable" yaml:"user-invocable"`
    DisableModelInvocation bool     `json:"disable_model_invocation" yaml:"disable-model-invocation"`
    SystemPrompt           string   `json:"-" yaml:"-"`
    SourcePath             string   `json:"source_path"`
}

type PersonaCatalog interface {
    ListPersonas(ctx context.Context, userID, projectID string) ([]Persona, []ValidationIssue, error)
    ListUserPersonas(ctx context.Context, userID, projectID string) ([]Persona, error)
    ListSpawnablePersonas(ctx context.Context, userID, projectID string) ([]Persona, error)
    ResolvePersona(ctx context.Context, projectID, slug string) (*Persona, error)
}
```

### Persona Application at Turn Creation

When `CreateTurn` is called on a thread with `persona` set, the streaming service:

1. Resolves the persona via `PersonaCatalog.ResolvePersona()`
2. Overrides model selection with `persona.Model`
3. Overrides temperature/max_tokens if persona specifies them
4. Filters tool registry to only include `persona.Tools`
5. Loads `persona.Skills` instead of client-provided `selected_skills`
6. Injects persona's markdown body into the **current user message** (not the system prompt -- see [streaming-integration](streaming-integration.md) for cache-aware split rationale)

The persona body is injected at LLM request time by `MessageBuilder` but NOT stored in the turn's DB record. This keeps history clean and allows hot-reloading persona changes.

If persona doesn't exist or is invalid: `422 Unprocessable Entity`. No silent fallback.

## Distribution

Git-based install, same as CLI. No separate mechanism for Flow.

**How it works today (CLI):**
- Sources in `agents.toml` -- git repos with agents + skills
- `meridian install` clones sources, copies into `.agents/`
- `agents.lock` pins commit hashes and content hashes

**How Flow uses it:**
- Project's document tree contains `.agents/` (same layout, same files)
- A3 reads personas/skills from this tree
- A3 has `POST /api/projects/{id}/agents/import-git` for adding sources
- Install state in dedicated table (not in document tree -- agents shouldn't access install metadata):

```sql
CREATE TABLE ${TABLE_PREFIX}agent_install_state (
    project_id UUID PRIMARY KEY REFERENCES ${TABLE_PREFIX}projects(id) ON DELETE CASCADE,
    lock_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    version INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency (CAS)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

One row per project. `lock_data` same shape as CLI's `agents.lock` JSON. Updates use compare-and-swap on `version`.

**Deferred (post-v1):** Marketplace UI, semantic versioning, breaking change detection, auto-update scheduling, conflict resolution for customized skills.
