**Status:** draft

# Agent Escalation Pattern

## Problem

Currently, agents run autonomously and either succeed or fail. There is no mechanism for:

1. **Agent → Orchestrator escalation**: When an agent encounters a design decision, ambiguous requirement, or blocker it cannot resolve autonomously, it has no way to pause and ask for guidance.
2. **Orchestrator → Human escalation**: When the orchestrator itself faces uncertain decisions (conflicting agent outputs, architectural choices, risk assessment), it cannot notify the human asynchronously.
3. **Decision tracking**: Design decisions made during execution are not captured for human review, leading to undiscovered bugs (e.g., the `--skills` flag bug shipped because no one questioned whether the CLIs actually support that flag).

## Observed Failure Modes

- **Silent wrong decisions**: Agent implements something incorrect because it assumed rather than asked (e.g., passing `--skills` to CLIs that don't support it).
- **Blocked execution**: Agent hits a blocker and either fails entirely or works around it poorly, when the orchestrator could have provided context.
- **Lost context**: Human returns to find 10 completed agent runs but no record of the design decisions made during execution.

## Design Goals

1. Agents can **pause and escalate** to the orchestrator without terminating.
2. The orchestrator can **autonomously resolve** agent escalations when it has sufficient context.
3. The orchestrator can **escalate to the human** for uncertain or high-impact decisions.
4. All escalations and decisions are **recorded** for audit trail.
5. Human can be **notified asynchronously** (WhatsApp, etc.) when their input is needed.

## Architecture

```
Agent (running)
  ├── encounters decision point
  ├── writes escalation to `.orchestrate/runs/<run-id>/escalation.json`
  ├── PAUSES execution (waits for resolution)
  │
  ▼
Orchestrator
  ├── detects escalation (poll or watch)
  ├── evaluates: can I resolve this autonomously?
  │   ├── YES: writes resolution to `escalation.json`, agent resumes
  │   └── NO: escalates to human
  │       ├── writes to shared escalation log
  │       ├── sends async notification (WhatsApp / webhook)
  │       └── waits for human response
  │
  ▼
Human
  ├── reviews escalation + context
  ├── provides decision
  └── orchestrator relays to agent, agent resumes
```

## Escalation Protocol

### Agent-Side

New convention: agents write an `escalation.json` to their run artifact directory when they need guidance.

```json
{
  "type": "design_decision",
  "severity": "medium",
  "question": "The Codex CLI does not support --skills. Should I (a) drop the flag silently, (b) compose skills into the prompt text, or (c) fail with an error?",
  "context": "Running `codex exec --help` shows no --skills flag. The current code passes it through, which causes a CLI error.",
  "options": [
    {"id": "a", "label": "Drop silently", "risk": "Skills are lost for codex runs"},
    {"id": "b", "label": "Compose into prompt", "risk": "Prompt gets longer, may exceed limits"},
    {"id": "c", "label": "Fail with error", "risk": "Blocks all codex runs with skills"}
  ],
  "recommendation": "b",
  "agent_run_id": "<run-id>",
  "timestamp": "2026-02-25T13:45:00Z"
}
```

**Severity levels:**
- `low` — Agent has a strong recommendation, just wants confirmation. Orchestrator can auto-resolve.
- `medium` — Multiple valid options, agent is uncertain. Orchestrator should evaluate.
- `high` — Architectural impact, potential breaking change, or security concern. Should reach human.

### Orchestrator-Side

New `escalation` skill for the orchestrator:

1. **Detect**: Monitor active runs for `escalation.json` files.
2. **Evaluate**: Based on severity and available context:
   - `low` → Auto-resolve using agent's recommendation, log the decision.
   - `medium` → Evaluate options against project context (CLAUDE.md, plans, prior decisions). Resolve if confident, escalate to human if not.
   - `high` → Always escalate to human.
3. **Resolve**: Write resolution back to `escalation.json`:
   ```json
   {
     "resolution": "b",
     "resolved_by": "orchestrator",
     "rationale": "Skills are already composed into prompt text by the prompt composition layer. Dropping the CLI flag is correct, but option (b) is already the existing behavior.",
     "timestamp": "2026-02-25T13:45:30Z"
   }
   ```
4. **Record**: Append to session-level `decisions.jsonl` for audit trail.

### Human Notification

New `notify` skill (or extension of escalation skill):

- **WhatsApp**: Send a message via WhatsApp Business API or Twilio with:
  - Summary of the decision needed
  - Link to the escalation file or a web UI
  - Quick-reply options (if the question is multiple-choice)
- **Webhook**: Generic HTTP POST for other integrations (Slack, Discord, email).
- **File-based**: Write to a known location that the human checks (fallback).

Human can respond via:
- Reply to the notification (WhatsApp quick reply)
- Edit the escalation file directly
- CLI command: `run-agent.sh resolve <run-id> --decision <option>`

## Decision Log

All escalations and resolutions are appended to a session-level decisions log:

```
.orchestrate/runs/sessions/<session-id>/decisions.jsonl
```

Each line captures: question, options, who resolved it (agent/orchestrator/human), the chosen option, and rationale. This becomes the audit trail for understanding why things were built the way they were.

## Implementation Phases

### Phase 1: File-Based Escalation (MVP)
- Agent writes `escalation.json` when blocked
- Agent polls for resolution (simple file watch)
- Orchestrator manually checks and resolves
- Decisions logged to `decisions.jsonl`

### Phase 2: Orchestrator Auto-Resolution
- Orchestrator `escalation` skill detects and evaluates
- Low-severity auto-resolved
- Medium-severity evaluated with context
- High-severity flagged for human

### Phase 3: Async Human Notification
- WhatsApp integration via Twilio/WhatsApp Business API
- Quick-reply support for multiple-choice decisions
- Webhook support for other platforms
- Timeout handling (if human doesn't respond within N minutes, orchestrator makes best-effort decision and flags it)

## Open Questions

- How does the agent "pause" in practice? Options: (a) sleep-poll loop, (b) process signal, (c) write checkpoint and exit, re-launch after resolution.
- Should the orchestrator be able to override high-severity and auto-resolve with a "confidence" flag?
- Rate limiting: how to prevent agents from escalating every minor uncertainty?
- Should decisions be project-scoped (persist across sessions) so the same question isn't asked twice?

## Related

- `_docs/plans/meridian-channel/e2e-integration-tests.md` — The bugs that motivated this pattern
- `_docs/plans/meridian-channel/flag-strategy-design.md` — Example of a decision that should have been escalated
