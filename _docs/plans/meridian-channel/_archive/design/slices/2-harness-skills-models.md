# Slice 2: Harness Adapters + Skill Registry + Model Discovery

**Required reading:**
- [`_docs/plans/meridian-channel/README.md`](../README.md) (always)
- [`_docs/plans/meridian-channel/design-philosophy.md`](../design-philosophy.md) (always, especially P7-P9, P11)
- [`_docs/plans/meridian-channel/architecture.md`](../architecture.md) (project layout)

**Effort:** 2 days
**Dependencies:** Slice 0 (domain newtypes), Slice 1 (SQLite for skill index).
**Model recommendation:** `gpt-5.3-codex`

## Description

Implement the HarnessAdapter Protocol and registry (P7), the skill registry (P8) with SQLite indexing and keyword search, SKILL.md frontmatter parsing, agent profile parsing, model guidance loading, and model-to-harness routing. Skills are discovered exclusively from `.agents/skills/`.

## Files to create

- `src/meridian/lib/harness/adapter.py` — HarnessAdapter Protocol, HarnessCapabilities
- `src/meridian/lib/harness/registry.py` — HarnessRegistry
- `src/meridian/lib/harness/claude.py` — ClaudeAdapter
- `src/meridian/lib/harness/codex.py` — CodexAdapter
- `src/meridian/lib/harness/opencode.py` — OpenCodeAdapter
- `src/meridian/lib/harness/direct.py` — DirectAdapter (Anthropic API + programmatic tool calling)
- `src/meridian/lib/config/skill.py` — SKILL.md parser, scanner, indexer
- `src/meridian/lib/config/skill_registry.py` — skill index CRUD, keyword/tag search
- `src/meridian/lib/config/model_guidance.py` — guidance loader with override precedence
- `src/meridian/lib/config/agent.py` — agent profile parser
- `src/meridian/lib/config/routing.py` — model -> HarnessId routing
- `src/meridian/lib/config/catalog.py` — built-in model catalog + models.toml override
- `src/meridian/lib/config/base_skills.py` — three base skills, injection rules
- `src/meridian/lib/ops/skills.py` — skills_search, skills_load, skills_list, skills_reindex operations
- `src/meridian/lib/ops/models.py` — models_list, models_show operations

## Key design decisions

Model-to-harness routing:
```python
# Claude: claude-*, opus*, sonnet*, haiku*
# Codex: gpt-*, o1*, o3*, o4*, codex*
# OpenCode: opencode-*, contains '/'
# Direct: any model when --mode direct (uses Anthropic API with code_execution)
# Fallback: Codex with warning
```

DirectAdapter — programmatic tool calling:
```python
class DirectAdapter(HarnessAdapter):
    """Calls Anthropic Messages API directly with code_execution.

    Generates tool definitions from Operation Registry with
    allowed_callers: ["code_execution_20260120"]. Claude writes
    Python code that calls these tools in a loop inside the sandbox.
    Tool results don't enter Claude's context — only final output does.
    """
    def build_tool_definitions(self) -> list[dict]: ...
    async def execute(self, prompt, model, ...) -> RunResult: ...
```

Skill registry (indexed in SQLite `skills` table):
```python
class SkillRegistry:
    def reindex(self, skills_dir: Path) -> IndexReport: ...
    def search(self, query: str) -> list[SkillManifest]: ...
    def load(self, names: list[str]) -> list[SkillContent]: ...
    def base_skills(self, mode: Literal["standalone", "supervisor"]) -> list[SkillContent]: ...
```

## Acceptance criteria

1. `HarnessAdapter` Protocol defined with all methods from P7
2. `HarnessRegistry` registers Claude, Codex, OpenCode, and Direct adapters at startup
3. `route_model()` matches current bash routing behavior
4. Parses SKILL.md YAML frontmatter correctly
5. Scans `.agents/skills/` exclusively
6. Skills indexed in SQLite with name, description, tags, content, path
7. `meridian skills list/search/show/reindex` CLI commands work
8. Model guidance loaded with override precedence
9. Agent profiles parsed from `.agents/agents/` markdown files
10. Three base skills loadable with correct injection rules per P9
11. `meridian models list/show` work with built-in catalog + models.toml overrides
12. Unit tests with fixture SKILL.md and agent files
