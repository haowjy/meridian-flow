# Meridian Agent System Implementation Plan

## Delivery decision

Deliver one vertical root-Agent path before building delegation or distribution. The walking skeleton must prove Mars source to immutable definition to New Chat binding to model turn to Yjs edit to receipt and Undo. Each later phase extends a proven seam and deletes the mechanism it replaces.

```mermaid
flowchart LR
    Contract["0. Mars contract"] --> Skeleton["1. Root walking skeleton"]
    Skeleton --> Truth["2. Policy truth"]
    Truth --> Manage["3. Management + exchange"]
    Manage --> Harden["4. UX + cutover"]
    Harden --> Release["Release root Agent v1"]
    Release -. later .-> Children["Child Agents"]
    Children -. later .-> Distribution["Remote distribution"]
```

## Method, patterns, and stack

### Method

- **Walking skeleton first:** prove the full writer outcome before broad UI or extensibility.
- **Contract tests before consumers:** lock Mars normalization and negative cases before persistence/runtime depend on them.
- **Atomic cutover:** Phases 0 through 4 are internal milestones on one non-deployable cutover lane. None merges independently to `main`, and no deployable state has both slug/prompt-bake and revision/preparation paths.
- **Functional core, imperative shell:** pure compilation/digest/policy logic around thin persistence and execution effects.
- **Runtime probe as merge gate:** automated tests are necessary but do not replace Portless browser, log, stream, DB, and Yjs evidence.
- **Deletion in the owning PR:** schemas can change freely; no compatibility shims or dormant legacy paths.

### Structural patterns

- domain modules with deep public exports;
- ports/adapters only for compiler, repositories, gateway, and tool-operation binding;
- immutable revision references;
- one cross-domain application service for first Send;
- one `prepareAgentTurn` composition seam;
- one `EffectiveToolPolicy` for advertisement and dispatch;
- existing turn journal and Yjs change trail as lifecycle/evidence authorities.

### Existing libraries only

| Concern | Use |
|---|---|
| Web UI | React, TanStack Query/Router, existing Radix-based UI primitives, design tokens. |
| Forms/validation | Existing form patterns plus Zod. Do not add a form framework only for four fields. |
| Mars source | Existing `yaml` and `smol-toml` behind the compiler port; shared Mars fixtures define semantics. |
| Persistence | Drizzle and Postgres transactions. |
| Editing | TipTap, Yjs, and `@meridian/agent-edit`. |
| Model execution | Existing model gateway and turn runner. |
| Tests | Vitest, database suite, Playwright, existing event/log probes. |
| Tooling | pnpm, Nx, Biome, Portless. |

No runtime dependency is planned.

## Phase 0: publish the strict Mars subset

### Mars repository

1. Define package-level `CompiledAgentPackageV1`, `NormalizedAgentDefinitionV1`, and their normative field-presence/default rules.
2. Add semantic profile `actions` with the v1 identifiers `document.read` and `document.edit`; require at least read and define edit as implying read.
3. Define non-recursive digest envelopes, domain prefixes, canonical JSON, and canonical source-tree ordering.
4. Define deterministic wrapping of a standalone Agent Markdown file into `local-<slug>`.
5. Publish positive and negative fixtures for multi-Agent packages, standalone input, read/edit mapping, unsupported skills/tools, and export/import round-trip.
6. Mark policy-bearing semantic additions as contract-version changes or required features.

### Flow repository

1. Implement `MarsDefinitionCompilerPort` with a strict subset adapter using existing parsers.
2. Reject unsupported `sandbox`, approval, executable hooks, MCP servers, dependencies, arbitrary code, tools/disallowed-tools, skills, and ambiguous policy.
3. Normalize the first-party Writer and Critic sources to the contract.

### Gate

- Mars and Flow produce byte-identical canonical results for every fixture.
- Invalid values fail with stable, source-located diagnostics.
- Recompiling identical files 100 times produces the same digest.
- No Flow-specific runtime field is added to Mars source.

## Phase 1: prove the root walking skeleton

1. Replace package/definition persistence with the four-record model, including account/system catalog entries.
2. Seed one edit-capable Writer definition.
3. Implement `StartAgentChat` and the atomic first-Send endpoint.
4. Bind by exact `definitionRevisionId` and remove slug fallback.
5. Implement `prepareAgentTurn` and remove prompt-bake composition.
6. Route one real turn through the existing gateway and event stream.
7. Apply an edit through `@meridian/agent-edit` and Yjs.
8. Render the existing assistant prose, receipt, and Undo.

### Gate

A Portless probe demonstrates:

```text
Mars files
→ compiled immutable revision
→ Agent chosen in New Chat
→ atomic thread + Work + binding + first turn
→ model event stream
→ live Yjs edit
→ TurnEditsReceipt
→ Undo restores prior state
```

Inspect Postgres, logs/events, stream order, and Yjs state. Fault-injection database tests prove no partial first-Send aggregate.

## Phase 2: prove truthful policy differentiation

1. Add a read-only Critic definition.
2. Implement semantic operation projection for `documentAccess`.
3. Make catalog availability, model advertisement, and dispatch use one `EffectiveToolPolicy` result.
4. Reject direct API selection of unknown, unavailable, non-user-invocable, or wrong-project definitions.
5. Inject fabricated edit calls against Critic.

### Gate

- Writer sees and dispatches read/edit operations.
- Critic sees read operations only.
- Critic's fabricated edit reaches neither handler nor Yjs.
- Policy digests match across availability, advertisement, and dispatch tests.

## Phase 3: add management and local exchange

1. Add the flat account/system Agents list and concise detail route.
2. Add the four-field create/edit form.
3. Generate a new immutable Mars source/package revision on Save.
4. Add local multi-Agent package and standalone Agent import review plus export.
5. Define deletion as `removed_at` on the owned catalog entry while retaining referenced revisions.
6. Keep source/revision facts in Advanced or overflow, not primary list copy.

### Gate

- Create, edit, export, delete-from-catalog, and re-import work end to end.
- Export/delete/re-import produces the same compiled digest.
- Editing an Agent affects a new chat and not an existing one.
- Import errors name the file and field and persist no partial package.
- Name/logical-key collisions fail without overwriting and tell the writer to rename and re-import.

## Phase 4: finish the minimal experience and delete old paths

1. Keep Agent selection only in New Chat.
2. Hide Work selection for the default one-Work product state.
3. Show bound Agent once in existing chat.
4. Reuse current activity, assistant prose, receipt, and Undo.
5. Remove package launch cards and any launch/test actions outside New Chat.
6. Remove every item in the deleted UX and source inventory below.
7. Run desktop and 390 px accessibility/visual probes.

### Gate

- The [experience acceptance criteria](agent-ux-spec.md#acceptance-criteria) pass.
- Source search proves forbidden copy and controls are absent.
- `pnpm check` and `pnpm test:db` pass.
- The full root workflow passes a real Portless runtime probe.
- A same-machine 30-run mock-provider comparison keeps first Send to first event within 10% of baseline p95, and catalog query tests enforce the configured page bound and deterministic cursor.

## Post-v1 extension: add foreground child Agents

This work starts only after root Agent v1 has shipped. Child invocability and roster semantics are not present in the v1 contract or schema.

1. Extend the Mars contract with an exact declared child roster and shared fixtures.
2. Resolve child slugs to immutable definition revision edges at install time.
3. Reuse the current child coordinator only where it satisfies the new revision, context, and policy invariants; delete parallel legacy behavior.
4. Inherit Project and fixed Work.
5. Intersect parent effective policy, child requested policy, host support, and tree budget.
6. Start with foreground spawn-and-report and existing transcript output.
7. Add depth, concurrency, time, and credit enforcement at the coordinator.

### Gate

- Undeclared, unavailable, non-model-invocable, and over-budget children are rejected at launch.
- A child cannot broaden document access.
- Child execution cannot change Work.
- Parent cancellation terminates active children.
- The parent incorporates useful child output without helper UI or generic orchestration receipts.

Background continuation, resumable work, external effects, or a task center require a separate design based on observed need.

## Replacement and provenance inventory

| Affected area | Classification | Change |
|---|---|---|
| Current composer Agent control | **Existing pattern** | Keep as the New Chat selection affordance. |
| Current zero-turn rebinding and separate create/send behavior | **Deleted behavior** | Replace with atomic first Send and exact revision binding. |
| Current Work control | **Existing pattern, conditional** | Keep only when more than one eligible Work exists. |
| Current package/project launch cards | **Deleted behavior** | Remove; packages do not launch chats. |
| Agents inventory/editor/import | **Required addition** | Add account/system management with no launch action. |
| Current prompt bake and slug lookup | **Deleted behavior** | Replace with `prepareAgentTurn`. |
| Current activity and edit receipt/Undo | **Existing pattern** | Reuse without generic disclosure rows. |
| Child Agents, registry, external effects | **Later extension** | Do not scaffold into root v1. |

Delete or replace these concepts during the owning phase:

### Definition and persistence

- permissive arbitrary Agent metadata as executable policy;
- mutable definitions and per-project/user overlays;
- duplicated `mode`, skills, and subagent relationship authorities;
- unsupported `modelTier` and non-Mars effort values;
- active-revision lookup as existing-chat behavior;
- synthetic `General` fallback;
- slug-based binding.

### Runtime

- prompt baking outside `prepareAgentTurn`;
- tool registration and dispatch using different policy sources;
- dynamic skill invocation in the root first release;
- launch bundle/host negotiation structures that have no Flow consumer;
- parallel run/event/receipt stores.

### UI

- launch cards on Home or package pages;
- Agent switching in existing chats;
- duplicate Agent identity;
- redundant one-Work control;
- normal-state badges;
- premature search/filter;
- editor preview and section rail;
- generic attention/background/task-center UI;
- package compatibility ceremony;
- `Sources and effects`, `Helpers consulted`, and `Run details`;
- duplicate edit counts outside `TurnEditsReceipt`.

## Verification matrix

| Boundary | Test evidence | Runtime evidence |
|---|---|---|
| Mars compiler | Shared fixtures, property/determinism cases, negative semantics. | Import a real local package and inspect diagnostics/output. |
| Persistence | Repository and Postgres constraint tests, including bounded deterministic catalog pagination. | Inspect rows after create/edit/bind/delete-from-catalog. |
| First Send | Fault-injection DB suite. | Navigate optimistically, interrupt failures, confirm no empty thread. |
| Policy | Pure unit and dispatch-negative tests. | Compare model schema and actual denied call. |
| Gateway/journal | Existing contract suite plus preparation integration and the 30-run p95 comparison. | Inspect streams, sequence floor, settle/reload behavior. |
| Yjs/receipt | Existing edit and reversal tests. | Edit a real chapter, reload, Undo, inspect document state. |
| UX | Component accessibility and Playwright flows. | Desktop and 390 px screenshots, keyboard-only pass. |
| Deletion | Negative-space source checks. | No legacy route/control can reach a removed authority path. |

## Stop/go rules

- Do not start management UI until one root edit reaches receipt and Undo.
- Do not add more capability categories until read versus edit is truthful end to end.
- Do not add child semantics until root Agent v1 has shipped with one selection, binding, and policy authority.
- Do not add remote distribution until local Mars round-trip is deterministic.
- Do not add background execution until a foreground workflow proves why it is insufficient.
- Do not merge a phase with a dual legacy/new execution path.
