# Strategic Direction

**Status:** draft

---

## The Big Picture

```
meridian-flow          — the product (agentic writing platform, SaaS)
meridian-channel       — internal dev infrastructure + pattern laboratory
orchestrate plugin     — the workflow layer that ties channel into daily dev
```

**Meridian-channel is not a product. It's the forge.**

It exists to (1) make building meridian-flow massively productive, and (2) battle-test orchestration patterns that will be applied to meridian-flow's AI writing features.

The money is in meridian-flow — "Claude Code, but for writers." Channel is the infrastructure that lets one developer ship at the speed of a team.

---

## Meridian-Channel: Orchestrator for Agent Orchestrators

Claude Code, Codex, and OpenCode are already agent orchestrators — heavily tuned by their providers. Meridian-channel does not replace them. It coordinates them: launching runs, tracking state, composing prompts, enforcing safety, enabling cross-harness communication.

### Key constraints

- **Let agents be themselves at their best.** Meridian picks the right model for the task, gives it context and skills, and gets out of the way. Don't over-constrain agents with rigid formats or heavy scaffolding — their native strengths are the product. Model selection and routing is where meridian adds value, not micromanaging agent behavior.
- **No API keys.** Users run on subscriptions (Claude Pro, Codex, etc.), not PAYGO. Channel never calls model APIs directly.
- **No re-developing harnesses.** Providers optimize their harnesses aggressively. Channel leverages them as black-box executors.
- **Harness-agnostic communication.** Any harness talks to any other harness through channel's coordination layer (MCP tools, shared state, skills).
- **Local-first.** Single developer, repo-local state, no server required.

### Origin story

Born from wanting Claude Code's planning brain and Codex's implementation hands to work together. The orchestrate plugin was the first expression — `/orchestrate` fans out work to the right model with the right skills, evaluates results, iterates. Channel formalized that into a proper CLI + MCP server.

---

## Pattern Transfer: Channel → Flow

The patterns battle-tested in meridian-channel are directly applicable to meridian-flow's AI features. This is the strategic value of channel beyond dev velocity — it's a laboratory for production patterns.

### Multi-model routing

| Channel (coding) | Flow (writing) |
|-------------------|----------------|
| Claude for planning, Codex for implementation | Claude for brainstorming/world-building, GPT for prose generation, Gemini for consistency checking |
| Model selection based on task type | Model selection based on writing task type |
| Harness adapter abstraction | Provider adapter abstraction |

Writers won't care which model they're talking to. Flow picks the right one for the task, just like channel picks Claude vs Codex.

### Skill composition

| Channel | Flow |
|---------|------|
| Coding skills (reviewing, researching, smoke-test) | Writing skills (prose-style, character-voice, genre-conventions) |
| Markdown templates composed into prompts | Same pattern — markdown writing instructions composed into prompts |
| Skills discovered at runtime from `.agents/skills/` | Skills discovered from user's skill library |

Flow already has skills (`fb-skills` feature). Channel's composition engine (template vars, skill stacking, policy files) is a more mature version of the same idea.

### Safety and guardrails

| Channel | Flow |
|---------|------|
| Permission tiers (read-only → full-access → danger) | Edit tiers (suggest → auto-edit → restructure) |
| `--unsafe` gate for destructive operations | Confirmation gate for destructive document changes |
| Budget enforcement (token/cost limits per run) | Token budget per writing session |
| Guardrail scripts (pre/post execution checks) | Content guardrails (tone, consistency, style) |

### Space context

| Channel | Flow |
|---------|------|
| Pinned files persist across conversations | Pinned lore docs, character sheets, style guides |
| Compaction re-injection preserves skills after context loss | Same — preserve writing context after long sessions |
| Space summary for orientation | Project summary for AI orientation |

### Run tracking and observability

| Channel | Flow |
|---------|------|
| Run history in SQLite with status/cost/artifacts | AI interaction history with diffs/suggestions/costs |
| Report extraction from agent output | Suggestion extraction from AI responses |
| Cost tracking per run and per space | Token usage visibility per session |

---

## What This Means for Priorities

### Channel priorities (optimize for dev velocity)

1. **Security hardening** — fix CRITICALs so channel is safe for daily use (see security-hardening.md)
2. **DX polish** — CLI errors, docs accuracy, so less time fighting the tool (see dx-improvements.md)
3. **Space lifecycle** — hooks + session tracking for long orchestration sessions (see space-lifecycle.md)
4. **Code quality** — layering fixes to keep the codebase maintainable as patterns evolve (see code-quality.md)

### Flow priorities (informed by channel learnings)

1. **Multi-model routing** — apply harness adapter pattern to writing AI providers
2. **Skill composition** — mature the writing skills system using channel's template/composition engine as reference
3. **Safety tiers** — apply permission tier pattern to document editing safety
4. **Context persistence** — apply space context pattern to writing project context

### NOT priorities

- Monetizing channel (it's internal tooling)
- Making channel a product (it's a forge, not a sword)
- Hosted channel / team features (focus on flow for that)

---

## Strategic Path (Channel-Only)

Direction is not enough; channel needs execution gates that prove it is doing its job as a forge for flow.

### Phase 1 — Secure and Stable Core

Scope:
- Close CRITICAL security findings and the major permission/containment bypasses
- Add missing critical-path tests for security and TTY launch paths
- Resolve space lifecycle bugs that can lose session continuity

Exit criteria:
- SEC-1/SEC-2/SEC-3 fixed and covered by tests
- No known path traversal or env-leak vectors in default workflows
- Space resume succeeds after compact/clear events in repeated smoke runs

### Phase 2 — Operator-Grade DX

Scope:
- Remove misleading CLI/MCP behavior
- Align docs and schemas so tool usage is predictable
- Reduce avoidable debugging overhead in daily use

Exit criteria:
- DX-1 and DX-2 resolved (schema parity + unknown command handling)
- CLI help is descriptive for high-traffic commands
- Timeout and common failure modes return stable, actionable errors

### Phase 3 — Transfer Proof to Flow

Scope:
- Apply channel patterns into flow deliberately (not by analogy)
- Capture and document concrete pattern-transfer wins

Exit criteria:
- At least 2 pattern transfers implemented in flow (e.g., routing, skills composition, safety tiers, context persistence)
- Each transfer has a short note documenting before/after behavior and tradeoffs
- No net increase in operational fragility from the transfer

### Phase 4 — External Proof Artifacts

Scope:
- Publish reproducible artifacts that demonstrate channel outcomes
- Show velocity/reliability improvements, not just architecture

Exit criteria:
- Repeatable demo + setup path that works from a clean repo checkout
- At least one technical case study showing measurable improvement from channel-enabled workflow
- Ongoing cadence of concise public build artifacts (demo clips, postmortems, benchmark notes)

### Channel KPIs

- Run success rate for orchestrated tasks (target trend: up and stable)
- Mean time to recover from interrupted space sessions (target trend: down)
- Time-to-first-success for new repo/worktree setup (target trend: down)
- Share of flow features that reuse channel-proven patterns (target trend: up)
- Frequency of externally consumable proof artifacts (target: consistent weekly cadence)

### Channel vs Flow Decision Rules

- If a proposed channel feature does not improve flow velocity, reliability, or pattern transfer within 2 weeks, defer it.
- If channel hardening work blocks flow implementation, prioritize the minimum fix set required for safe daily use, then return to flow.
- Prefer improvements that strengthen both CLI and MCP surfaces through shared operations (avoid one-off interface work).
- Treat "interesting devtool ideas" as backlog unless they directly strengthen the forge mission.

---

## Competitive Landscape (Feb 2026)

### For channel (dev tooling — informational only)

| Tool | Approach | What we learn |
|------|----------|---------------|
| **GitHub Agent HQ** | Unified agent workflow in GitHub | IDE/PR integration patterns |
| **OpenHands** | Full platform with delegation, MCP, cloud | Sub-agent delegation API design |
| **DeerFlow** | Super-agent with memory, sandboxes | Long-horizon task decomposition |
| **Claude-flow** | Multi-agent swarm around Claude Code | Turnkey orchestration presets |
| **cc-switch** | Desktop control for CLI switching | Fast model switching UX |

### For flow (writing product — competitive intelligence)

This is a different landscape (AI writing tools, not dev tools). Channel learnings give flow an architectural advantage over writing tools that use simpler AI integration patterns.

### Standards to track

| Standard | Status | Relevance |
|----------|--------|-----------|
| **MCP** | Strong, channel supports it | Core surface for channel; potential integration point for flow |
| **A2A** | Maturing, Linux Foundation | Cross-provider communication — relevant for flow's multi-model routing |
| **AGENTS.md** | Emerging convention | Already aligned in channel |

---

## Sources

- GitHub Agent HQ GA: github.blog/changelog/2026-02-26
- OpenHands: github.com/OpenHands/OpenHands
- DeerFlow: github.com/bytedance/deer-flow
- Claude-flow: github.com/ruvnet/claude-flow
- cc-switch: github.com/farion1231/cc-switch
- A2A: github.com/a2aproject/A2A
- MCP: modelcontextprotocol.io
