# features/agents — Agent identity, selection, and binding UI

This module owns focused agent identity and selection surfaces used by chat,
project provenance, and the Library. It keeps the capability-freeze rule out of
individual call sites: a picker is a control only when the next send can change
which agent handles that send.

## Contracts

### Synthetic default agent

`DEFAULT_AGENT_SLUG = "general"` is a client-side label for the platform-default
experience. It is not a server row and must not cross the wire.

- UI label: **General**.
- Server representation: no current-agent binding on the thread/create request.
- Choke point: `wireAgentSlug(slug)` returns `undefined` for `general`, `null`,
  and `undefined`; every thread-create write site must use it.
- Upgrade path: if builtin agents are seeded as real package-domain definitions,
  `general` becomes a real catalog row and this filter is removed.

Sending `general` to the server attempts to bind an agent definition that does
not exist. That is a bug in the caller, not a valid fallback.

### Capability-freeze UI rule

Thread capabilities are frozen at the first turn attempt by the runtime's
composed prompt bake. The frontend mirrors that constraint in where it renders
controls:

| Surface | Behavior |
|---|---|
| New/Home composer or deferred project new-chat | Interactive picker; selection changes the agent bound on first send. |
| Existing server-backed thread, zero turns | Interactive picker; rebinding is allowed until first send. |
| Existing server-backed thread after first send | Read-only selector state; selection would not change the frozen prompt, so it is not a control. |
| Idle existing thread with fork affordance | Picker opens only as **Continue in a new thread with…**; it creates a fresh thread. |
| Thread header / results provenance | Inert span; tooltip uses positive provenance: **Started with X**. |

Do not render a picker just because an agent label appears. A control must change the
next send, or it teaches the user that capability controls are unreliable.

### Identity vocabulary

Agents carry **no avatar mark** — identity is the name (plus an optional
source badge), styled through the shared `Badge`/`Button` primitives. Human
account imagery stays human-only; do not reintroduce initials circles or
`gradient-mark` discs for agents.

There is no shared `AgentChip` abstraction. Keep the surfaces honest and local:

| Surface | Shell | Use |
|---|---|---|
| `AgentSelector` | enabled/locked selector shell | Composer agent selection and frozen-thread state. |
| `AgentPicker` row | row-owned button with name + optional source `Badge` | Catalog choice inside the popover. |
| Results rail provenance | truncated `Badge neutral` inside the producing-thread button | Compact attribution, not a standalone control. |
| `AgentSummaryCard` | bordered card with name/source badge + description | Library list + editor previews. |

## Architecture

```mermaid
flowchart TD
  Catalog[useProjectAgents] --> Resolve[resolveAgentFromCatalog]
  Constants[DEFAULT_AGENT_SLUG + wireAgentSlug] --> Composer[ComposerAgentControl]
  Resolve --> Picker[AgentPicker]
  Resolve --> Summary[AgentSummaryCard]
  Resolve --> Results[Results rail badge]
  Composer --> Picker[AgentPicker]
  Picker --> Defaults[Project preferences defaultAgentSlug]
  Composer --> ThreadCreate[create thread with wireAgentSlug]
  Library[Test this agent] --> BoundThread[useCreateBoundProjectThread]
  BoundThread --> ThreadCreate
```

Key files:

| File | Role |
|---|---|
| `constants.ts` | Synthetic General/default-agent wire filter. |
| `AgentPicker.tsx` | Popover catalog grouped into installed/user and builtin sources; default-agent action and Library link. |
| `AgentSelector.tsx` | Enabled/locked selector shell for composer-facing current agent state. |
| `AgentSummaryCard.tsx` | Library/editor summary card for a browsable agent. |
| `ComposerAgentControl.tsx` | Applies the capability-freeze rule for composer chips and fork framing. |
| `use-create-bound-thread.ts` | Fresh agent-bound thread creation for fork and Test-this-agent. |

## Patterns

- Set defaults through `ProjectPreferences.defaultAgentSlug`; validate on the
  server against selectable catalog rows.
- Create a fresh thread for “Test this agent” and fork flows. Reusing a thread
  silently tests the old bake.
- Route Library navigation through the screen owner (`?screen=library`); docked
  chat paths use `onSelectDockThread` and must not steal screen ownership.
