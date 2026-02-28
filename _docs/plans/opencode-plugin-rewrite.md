# OpenCode Plugin Rewrite — orchestrate.ts

**Status:** draft

## Context

The `.opencode/plugins/orchestrate.ts` plugin was written speculatively against a guessed API. Research confirms the actual OpenCode plugin contract (from `anomalyco/opencode`) is significantly different:

- Plugins are async factory functions `(input: PluginInput) => Promise<Hooks>`, not plain objects
- Hook handlers receive `(input, output)` and **mutate `output` in place** — return values are ignored
- No `additionalContext` field exists — context injection uses `output.system`, `output.messages`, `output.context`
- Session events go through the `event` hook, not named hooks like `"session.created"`
- Compaction uses `experimental.session.compacting` with `output.context` / `output.prompt`
- `tool.execute.before` output type is `{ args }` — can only mutate tool args, **not inject context**

The current plugin is non-functional.

### Key API constraints (from source + live session)

| Hook | Input | Output (mutate in place) | Use |
|---|---|---|---|
| `chat.message` | `{ sessionID, agent?, model?, messageID?, variant? }` | `{ message: UserMessage; parts: Part[] }` | **Observe incoming messages — detect skill loads** |
| `experimental.session.compacting` | `{ sessionID }` | `{ context: string[]; prompt?: string }` | **Reinject skills on compaction** |
| `experimental.chat.system.transform` | `{ sessionID?, model }` | `{ system: string[] }` | Fallback: append to system prompt |
| `command.execute.before` | `{ command, sessionID, arguments }` | `{ parts: Part[] }` | Could intercept `/unpin` commands |
| `event` | `{ event }` | (none — observe only) | Debug logging |
| `tool.execute.before` | `{ tool, sessionID, callID }` | `{ args }` | Not useful (args only, no context injection) |

### OpenCode storage model (from live session inspection)

OpenCode stores everything in **SQLite** at `~/.local/share/opencode/opencode.db`, not JSONL files.

| Table | Purpose |
|---|---|
| `session` | Session metadata, has `time_compacting` field |
| `message` | One row per user/assistant turn. `data` JSON has `role`, `agent`, `model` |
| `part` | Content chunks per message. `type` field: `text`, `reasoning`, `compaction`, `step-start`, `step-finish`, `patch`, `tool-invocation` |

**How skills appear:** Skills are loaded as **user messages** containing full SKILL.md text as `text` parts. No special part type — just plain text in a user message.

**How compaction works:**
1. User message gets a part with `{"type": "compaction", "auto": false}`
2. Assistant message with `agent: "compaction"`, `mode: "compaction"`, `summary: true`
3. The compaction summary is the assistant's text response

**No transcript file exists.** There is no JSONL transcript to scan. The shell script approach (grep patterns from a file) does not work for OpenCode.

## Goal

Rewrite `orchestrate.ts` to match the real OpenCode plugin API. Track skill activations in-memory via hooks and reinject them after compaction — no shell script delegation needed.

## Design Decisions

### In-memory skill tracking (not shell script delegation)

The Claude Code / Cursor approach scans a JSONL transcript file for skill activation patterns. OpenCode has no transcript file — data lives in SQLite. Rather than querying the database, the plugin tracks skill activations **in-memory** as they happen:

- The `event` hook or `chat.message` hook observes each user message
- When a message contains a skill's SKILL.md content, record that skill as active
- On compaction, reinject the active skills via `output.context`
- This is simpler, faster, and doesn't depend on storage format

The shell scripts remain the mechanism for Claude Code and Cursor (they have JSONL transcripts). The OpenCode plugin is self-contained.

### Skill detection via `chat.message` hook

The `chat.message` hook fires on every new message and provides `output.parts: Part[]` — the actual content parts. Skills appear as `text` parts containing the full SKILL.md content. Detection approach:
- Scan `output.parts` where `type === "text"` for activation patterns:
  - `"Base directory for this skill: .../skills/<name>"`
  - `"Launching skill: <name>"`
- Also detect unpin signals in text parts: `"/unpin <name>"`, `"SKILL_UNPIN:<name>"`
- Cross-reference against the allow-list from `.orchestrate/sticky-skills.conf`
- Track activations in a `Set<string>` — add on detection, remove on unpin

### EnterPlanMode blocking — dropped

`tool.execute.before` can only mutate `{ args }`, not inject context. CLAUDE.md already says "DO NOT ENTER PLAN MODE." **Decision:** Drop the `tool.execute.before` hook entirely.

### Source of truth for orchestrate.ts

The canonical source is `orchestrate/hooks/.opencode/plugins/orchestrate.ts` (in the orchestrate submodule). The live copy at `.opencode/plugins/orchestrate.ts` is produced by sync. Edit the submodule source, then sync propagates.

### Missing config file fallback

If `.orchestrate/sticky-skills.conf` doesn't exist: **no filtering** — all detected skills are allowed through. Graceful degradation, not a security boundary.

## Allow-List Centralization

The sticky skill allow-list is currently duplicated across three tools. Centralizing it means:
- Users edit one file to add/remove sticky skills
- No need to touch hook configs or plugin source code
- All three tools read the same list

**Config file:** `.orchestrate/sticky-skills.conf`
- One skill name per line, `#` comments and blank lines ignored
- Parsed with: trim whitespace, lowercase normalize, skip empty/comment lines
- Read by shell scripts via `load_allowed_skills <project_root>` helper in `lib.sh`
- Read by OpenCode plugin directly (same simple line parser in TS)

**Migration:**
- Remove `--allow` CLI arg from `.claude/settings.json` hook command
- `.cursor/hooks.json` does not currently pass `--allow` — no change needed
- Remove hardcoded `ALLOW_LIST` from `orchestrate.ts` — read config file directly
- Keep `--allow` flag as CLI override (flag wins if provided, config is default)

## Tasks

### 1. Research: confirm exact plugin types (DONE)

Research complete from two Codex runs + live session inspection (session `ses_35d2114ffffeYFCWKY692GuOFW`).

Confirmed:
- Plugin API signatures and mutation semantics
- OpenCode storage: SQLite, not JSONL — no transcript file to scan
- Skills appear as user message text parts
- Compaction: `{"type": "compaction"}` part triggers summary by `agent: "compaction"`
- Compaction hook input: `{ sessionID }` only

### 2. Rewrite orchestrate.ts

Edit `orchestrate/hooks/.opencode/plugins/orchestrate.ts`, then sync.

**Plugin structure:**
- Export async factory function matching `Plugin` signature
- Maintain in-memory state: `activeSkills: Set<string>`

**Hooks:**

`chat.message` — skill detection:
- Fires on every new message with `output: { message: UserMessage; parts: Part[] }`
- Scan `output.parts` where part type is `text` for skill activation patterns:
  - `"Base directory for this skill: .../skills/<name>"` → add `<name>` to `activeSkills`
  - `"Launching skill: <name>"` → add `<name>` to `activeSkills`
- Scan for unpin signals:
  - `"/unpin <name>"`, `"SKILL_UNPIN:<name>"` → remove from `activeSkills`
- Filter against allow-list before adding
- This runs in real-time as messages arrive — no transcript scanning needed

`experimental.session.compacting` — skill reinjection:
- Read allow-list from `.orchestrate/sticky-skills.conf` (inline TS parser)
- For each skill in `activeSkills`:
  - Read the skill's SKILL.md content from disk (resolve via `input.directory` or `PluginInput.directory`)
  - Push into `output.context` array
- Log to stderr which skills are being reinjected

`event` (optional, for debugging):
- Log session lifecycle events

**No shell script delegation.** The plugin is self-contained TypeScript.

**Error handling:**
- If config file missing → no filtering, all detected skills allowed
- If SKILL.md read fails for a skill → skip that skill, log warning
- Never crash — always degrade gracefully

### 3. Centralize the allow-list

- Create and commit `.orchestrate/sticky-skills.conf`:
  ```
  # Skills allowed to be sticky-reloaded across compacts/clears.
  # One skill name per line.
  orchestrate
  run-agent
  mermaid
  scratchpad
  ```
- Add `load_allowed_skills()` helper to `lib.sh`:
  - Signature: `load_allowed_skills <project_root>` — echoes comma-separated list
  - Reads `<project_root>/.orchestrate/sticky-skills.conf`
  - Trims whitespace, lowercases, skips `#` comments and blank lines
  - If file doesn't exist: echoes empty string (caller treats as "no filter")
- Update `session-start.sh` (Claude Code + Cursor copies):
  - **After** `PROJECT_ROOT` is resolved, if `ALLOW_LIST` is still empty, call `load_allowed_skills "$PROJECT_ROOT"` and populate `ALLOWED_SKILLS` from result
  - Existing `--allow` parsing and filter logic stays unchanged
  - Ordering: CLI parse → source lib.sh → resolve PROJECT_ROOT → load config if needed → parse stdin → scan transcript
- Remove `--allow orchestrate,run-agent,mermaid,scratchpad` from `.claude/settings.json` hook command
- Remove hardcoded `ALLOW_LIST` from `orchestrate.ts` — reads config file directly
- Keep `--allow` CLI flag as override for testing/debugging

### 4. Sync and propagate

- Update `orchestrate/hooks/scripts/lib.sh` (source of truth) with `load_allowed_skills()`
- Update `orchestrate/hooks/scripts/session-start.sh` (source of truth) with config-file loading
- Run sync to propagate changes to `.claude/`, `.cursor/`
- `.opencode/plugins/orchestrate.ts` propagated separately (plugin, not hook script)
- Verify all copies are consistent after sync

### 5. Verify

- Test plugin loads without errors in OpenCode
- Test skill detection: load a skill via user message, confirm it's tracked in-memory
- Test compaction reinjects tracked skills via `output.context`
- Test `session-start.sh` reads from `.orchestrate/sticky-skills.conf` when no `--allow` flag
- Test `--allow` flag still overrides config file
- Test missing config file → no filtering (all skills allowed)
- Test fresh worktree without `.orchestrate/` dir → graceful degradation

## Open Questions

1. ~~Which hook observes user messages in real-time?~~ **Answered:** `chat.message` — confirmed from `packages/plugin/src/index.ts` line 158. Provides `output: { message: UserMessage; parts: Part[] }`.
2. On compaction, should we reinject the full SKILL.md content or just a reload instruction (e.g., `"Load skill: /orchestrate"`)? Full content is self-contained but large; reload instruction is small but requires the model to invoke the Skill tool. **Leaning toward:** full content — self-contained, no round-trip needed.
3. Does the `event` hook fire with a useful event type when compaction starts/ends, or is `experimental.session.compacting` the only signal? **Low priority** — not blocking.

## Review Feedback Log

### Round 1 (2026-02-28) — Codex + Sonnet

**Codex (technical accuracy):**
- HIGH: Compaction hook only provides `sessionID`, not `transcript_path` → plugin must resolve path itself
- HIGH: `tool.execute.before` output is `{ args }`, not context injection → drop EnterPlanMode blocking
- MEDIUM: `execSync` + shell interpolation is fragile → use structured argv
- MEDIUM: Missing sync propagation task
- LOW: Config format parser spec needed

**Sonnet (design/UX):**
- HIGH: Two copies of `orchestrate.ts` — need to specify source of truth and sync flow
- MEDIUM: `load_allowed_skills()` calling convention (must accept `project_root`, must run after `PROJECT_ROOT` resolved)
- LOW: Missing config file fallback should be explicit
- LOW: Initial config file should be committed
- Approvable with revisions. UX improvement is real.

All Round 1 findings addressed.

### Round 2 (2026-02-28) — Live session inspection

Inspected real OpenCode session `ses_35d2114ffffeYFCWKY692GuOFW` with skills + compaction.

**Critical finding:** OpenCode stores data in SQLite, not JSONL. No transcript file exists. Shell script transcript-scanning approach is fundamentally incompatible with OpenCode.

**Decision:** Rewrote Task 2 — plugin tracks skill activations in-memory via message hooks, reinjects on compaction via `output.context`. No shell script delegation. Plugin is self-contained TS.
