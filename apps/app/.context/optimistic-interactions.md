# Optimistic interaction contract

This specification governs writer-initiated state changes in `@meridian/app`.
It standardizes what the writer sees, how pending work is identified, and how
late or failed requests reconcile. It does not impose one state store or one
rollback policy.

The source inventory covers `fix/optimistic-recents` at `c82605345`, including
PR #566. Re-run the inventory when a new mutation surface lands.

## Decision

Use TanStack Query directly for server-authoritative command lifecycles. Do not
wrap `useMutation` in a Meridian mutation framework and do not create a second
global intent registry. TanStack's `MutationCache`, mutation keys, `meta`,
`useMutationState`, and query-cache operations are the shared transient
mechanism.

A domain keeps its real state owner:

- React Query cache for server projections.
- Zustand for live interaction state such as thread turns.
- IndexedDB or browser continuity records for durable device state.
- Yjs for collaborative document content.

TanStack may execute a synchronization request for those owners. It does not
become their canonical store merely to make the implementation uniform.

## Interaction profiles

Every writer-initiated command chooses one profile before implementation.

| Profile | Use when | Immediate display | Failure policy | Durability |
|---|---|---|---|---|
| **P0 Server-confirmed** | External authority, destructive action, or frequent refusal | Show intent and pending state, not completed success | Keep the current value; attach failure to the control or destination | Server |
| **P1 Speculative cache update** | Existing server entity, common success, reversible field or row change | Project the requested value into the cache | Definitive rejection reverts or invalidates; ambiguity retains until checked | Memory unless separately persisted |
| **P2 Speculative create** | The client can mint stable identity and navigate before materialization | Insert the entity and navigate immediately | Definitive rejection marks the destination failed; ambiguity retains and reconciles | Optional |
| **P3 Durable acknowledged submission** | Losing a shown intent on reload is unacceptable | Render from a durable local intent | Retry with the same idempotency key; bridge local and server identity | Durable outbox or journal |
| **P4 Local-first replica** | The local write is authoritative and peers merge later | The local write is the state | Never roll back because transport failed; show sync or conflict status | Replica |
| **P5 Device-local reconciler** | Device continuity is canonical and a server list supplements it | Render the device record first | Apply the record's explicit precedence rule | Browser storage or IndexedDB |

P4 and P5 are not optimistic overlays. Calling them optimistic leads to wrong
rollback and error behavior.

## User-visible contract

1. **Reflect safe intent immediately.** A writer does not wait for a network
   round trip to see a rename, send, local edit, navigation, or continuity
   update when the chosen profile permits local projection.
2. **Pending is visible where it matters.** The requested value may render, but
   the affected row, field, turn, or destination must not claim settled success
   while the command is pending. Derived bookkeeping such as a recents touch
   does not need per-row pending chrome.
3. **Failure belongs to the thing.** Definitive failure appears beside the
   affected entity with a useful retry, edit, undo, or dismiss action. A live
   announcement complements visible error UI; it does not replace it.
4. **Ambiguity is not rejection.** Timeout, disconnect, and response loss retain
   the projected intent until lookup, idempotent retry, or authoritative
   reconciliation establishes the result.
5. **Navigate first.** Destination changes commit immediately. Materialization
   and admission continue at the destination; failure never returns the writer
   to the previous screen. If the public address is server-assigned and no
   neutral pending destination exists, keep the command P0 and resolve the
   address design instead of mounting a fake route.
6. **Late data cannot move intent backward.** Every optimistic or local-first
   surface states how it fences stale responses and overlapping commands.
7. **Do not lose a shown first send.** A chat submission displayed to the
   writer must have a durable witness before the network can become ambiguous.
8. **External authority stays honest.** Auth, billing, destructive recursive
   operations, and other frequently refused actions use P0 unless the domain
   provides a safe projection and reconciliation contract.
9. **Accessibility is part of settlement.** Pending entities expose their state
   in semantics and copy. Visible failures use the shared `InlineErrorRow` or an
   equally local `role="alert"`; `AnnouncementRegion` and `announceError`
   announce the same change but never replace visible error UI. Focus returns
   to the failed entity when the interaction moved it.

## TanStack Query contract

### Use it directly

A server-authoritative mutation is a normal `useMutation` call. Shared code may
provide key factories, cache patch helpers, selectors, and error parsers. It
must not hide TanStack's lifecycle behind a callback-heavy wrapper.

```ts
const rename = useMutation({
  mutationKey: mutationKeys.project.rename(projectId),
  meta: {
    profile: "cache-update",
    scope: { accountId, projectId },
    entities: [{ kind: "project", id: projectId }],
  },
  mutationFn: renameProject,
  onMutate: projectRenameProjection,
  onError: reconcileProjectRenameFailure,
  onSettled: repairProjectList,
});
```

This is an illustrative shape, not a new wrapper API.

### Mutation metadata

New P0 through P3 mutations that own visible pending or error state declare:

```ts
type MeridianMutationMeta = {
  profile: "server-confirmed" | "cache-update" | "create" | "acknowledged-submission";
  scope: {
    accountId: string;
    projectId?: string;
    workId?: string;
  };
  entities: readonly {
    kind: string;
    id: string;
  }[];
  idempotencyKey?: string;
};
```

Register the type through TanStack's `Register.mutationMeta` when adoption
starts. Keep mutation keys in domain key factories. `useMutationState` may then
select pending or failed work by key, scope, or entity without another store.

This type sketch is a target for direct TanStack registration, not adopted API.
Verify `Register.mutationMeta` and mutation `scope` against the installed
TanStack version when the first two migrations need cross-component state.
Existing mutations migrate when touched. Do not create a flag-day conversion.

### Error classification

The command owner classifies failures emitted by the existing
`client/api/http-client.ts` boundary:

- A typed refusal result, validated conflict, or `MeridianApiError` whose
  endpoint contract proves the write was not applied is **rejected**.
- A network exception, timeout after dispatch, or unknown 5xx write outcome is
  **ambiguous** unless the endpoint proves otherwise.
- `MeridianApiError.retryable` permits retry; it does not by itself prove
  whether the first write committed.
- `HttpResponseError.status` supports endpoint-specific classification for
  unstructured responses. Do not build a second HTTP error hierarchy.
- An `AbortError` caused by account or route teardown is **abandoned**, not a
  writer-visible refusal.

Expected server refusals may be typed results rather than thrown errors. The UI
still maps them to rejected. TanStack does not infer this classification;
endpoint adapters or command owners must do it explicitly.

### Overlap and stale-response rule

Before using snapshot rollback, answer whether two commands can overlap on the
same entity. Choose exactly one policy:

- **Serialize:** use a per-entity command queue or TanStack mutation `scope`.
- **Version:** retire or revert only when the completing intent is still current.
- **Recompute:** rebuild projections from canonical state plus remaining intents.
- **Invalidate:** discard unsafe inverse patches and refetch authority.
- **Merge:** use the domain's CRDT or monotonic reducer.

Blindly restoring a whole-list snapshot is forbidden when another command may
have changed that list after the snapshot.

Query cancellation protects a projection from an older refetch. It does not
cancel a mutation or make retries idempotent.

### Lifetime rule

Mutation metadata names the account and project scope. Query and mutation keys
include the account where a provider can survive account replacement. Account
close aborts transports that support cancellation and prevents late callbacks
from writing into the next account. Durable records carry their own user stamp
and generation fence.

Per-call `mutate` callbacks are not lifecycle owners because they can disappear
when their component unmounts. Navigate-first creation, durable submissions,
and cross-route recovery live in a store, cache owner, or journal whose lifetime
outlasts the initiating component.

## Profile-specific implementation

### P0 Server-confirmed

Use `useMutation` for request state. Keep the current canonical value visible or
show an honest destination placeholder. Pending and error remain entity-scoped.
Do not invent an optimistic success state for Stripe, WorkOS, server-executed
reverse operations, recursive folder deletion, or Work authority transitions.

### P1 Speculative cache update

Cancel conflicting reads, register the intent, and apply the smallest field or
entity projection. Reconcile using serialization, versioning, or invalidation.
Store enough context to retire only this intent. Render its pending and failure
state through the owning row or field.

`thread-user-state-commands.ts` is the current reference: base plus projected
value, per-entity serialization, a revision, a stale-feed barrier, and a
field-local error.

### P2 Speculative create

Mint the stable ID before navigation. Insert a local entity using that same ID,
navigate, and materialize in the background. Keep the failed destination and
attach recovery there. Never depend on a server-assigned route ID after the
writer has already navigated.

### P3 Durable acknowledged submission

Persist `{intentId, accountId, payload fingerprint, state}` before dispatch.
Reuse the intent or idempotency key for every retry. Acknowledgement explicitly
bridges local and server identity. On startup, resume or reconcile unresolved
intents before declaring them failed.

### P4 Local-first replica

Write to Yjs or the local replica directly. Connectivity and server admission
are separate status surfaces. Undo is a new local/replicated action, not a
network-error rollback. External side effects launched from a document still
choose P0 through P3 independently.

### P5 Device-local reconciler

Define one precedence reducer for local records and server snapshots. Persist
account identity with the record. State which source may add, update, remove,
or tombstone an entity. A server omission is not deletion unless the domain
explicitly makes it so.

Working-set and recents remain separate records because their precedence and
acknowledgement rules differ.

## Backend capabilities

The frontend profile determines which backend support is required:

- P2 creation uses client-generated stable IDs.
- P2 and P3 retries use an idempotency key or naturally idempotent set command.
- Ambiguous commands expose lookup or replay by intent ID when a blind retry is
  unsafe.
- Acknowledgements return the intent ID and canonical entity identity.
- Versioned entities return a revision or sequence suitable for stale-response
  rejection.
- Domain refusals use structured codes distinct from transport failure.

Do not add these capabilities to endpoints whose profile does not need them.

## Current interaction inventory

Status meanings:

- **Conforms:** the current behavior follows the selected profile.
- **Partial:** the core projection exists but a required pending, error,
  durability, or fence behavior is missing.
- **Intentional P0:** waiting for authority is correct.
- **TODO:** local projection or navigate-first behavior is desirable and absent.

### Projects, Home, and Works

| Interaction | Profile | Status | Follow-up |
|---|---:|---|---|
| Account Home project plus first chat creation | P0 pending address design | **TODO**: waits for server-assigned slug; it cannot mount an unresolved `/p/` address or reuse the standalone-chat route | `OPT-001` |
| Independent quick-chat project creation | P2 | Conforms: client IDs, immediate standalone route, background materialization | Hidden cache residue is bounded cleanup only, not a visible phantom row |
| Existing-project first chat creation | P2, target P3 | Partial: navigate-first, only same-tab continuity | `CHAT-001` |
| Project rename and soft-delete store | P1 | **TODO**: optimistic machinery is unwired and has no complete API/UI owner | `OPT-002` |
| Work create and metadata save | P0 | Intentional P0: dialog or field draft owns pending and inline errors | None |
| Work archive, restore, delete, and write-mode change | P0 | Intentional P0: authority revision and behavior scope require confirmation | None |
| Home or Work chat favorite | P1 | Partial: queue and stale protection conform; stored error is announcement-only | `OPT-004` |

### Chat and draft review

| Interaction | Profile | Status | Follow-up |
|---|---:|---|---|
| Existing-thread send | Acknowledged submission, currently memory-only | Partial: identity, ambiguity, and stale guards conform; row looks settled and intent is lost on reload | `CHAT-001`, `CHAT-003` |
| New-thread first send | P2, target P3 | Partial: sessionStorage survives same-tab transitions but not tab close or reload | `CHAT-001` |
| Ambiguous send lookup and retire | P2/P3 | Partial: classification must align, while existing-thread Check/Start over and first-send turn Retry remain intentionally different presentations | `CHAT-003` |
| Thread rename | P1 | **TODO**: cache-only success is lost on reload; no server write | `CHAT-002` |
| Thread Work rebind | P0 with reconciliation | Conforms: server arbitration and unconfirmed outcome handling | None |
| Stop generation | P0 | Intentional P0: server event owns terminal state | Optional pending copy only |
| Interrupt response | P0 | Intentional P0: agent owns resolution; pending/error presentation is incomplete | `CHAT-004` |
| Draft apply and discard | P0 with outcome recovery | Conforms for server/Yjs authority; the awaiting-live recovery journal is in memory and its affordance resets on reload | No durability work unless that affordance must survive reload |
| Turn or document reverse | P0 over P4 | Conforms: server command, Yjs applies content | None |

### Context, editor, and continuity

| Interaction | Profile | Status | Follow-up |
|---|---:|---|---|
| Yjs document editing | P4 | Conforms | None |
| New editable document | P4 plus durable P3 namespace intent | Conforms | None |
| Document rename, move, filing, and delete | P3/P4 | Conforms: durable local projection and repair | None |
| Folder create | P2 candidate or P0 | **TODO** only after choosing a stable client-known tree identity; otherwise keep server-confirmed | `CTX-001` |
| Folder rename/move | P1 candidate | **TODO**: inline input is pending, tree waits for the server | `CTX-001` |
| Folder recursive delete and work-scoped authority changes | P0 | Intentional P0 | None |
| Binary/non-document create and upload intake | P0 | Intentional P0 until renderable metadata exists | None |
| Image upload slot | P2 inside P4 | Conforms: bytes and progress are intentionally ephemeral; an ownerless post-reload slot offers Remove, never a dead Retry | None |
| Editor tab membership | Device-local | Conforms: immediate and sessionStorage-scoped by design | None |
| Working-set continuity | P5 | Conforms | None |
| Account recents | P5 | Conforms after PR #566 | Existing bounded follow-ups stay in `context/.context/FUTURE.md` |
| By-ID document doors | Navigate-first | **TODO**: both a local open and a cold authority lookup can precede destination change | `CTX-002` |
| Local recents draft reopen | Navigate-first/local resource | Future: missing handle is a silent dead click and this path lacks the shared latest-attempt fence | `context/.context/FUTURE.md` |
| Availability-driven rename/delete | P5 reconciliation | Conforms | None |

### Account, preferences, billing, and auth

| Interaction | Profile | Status | Follow-up |
|---|---:|---|---|
| Theme, locale, text size, and pane layout | P5 device preference | Conforms | None |
| Cross-device working-set preference | P1 | Partial: immediate switch, silent rollback and no inline retry | `OPT-003` |
| Billing checkout and portal | P0 | Intentional P0; failure and return-path UI are incomplete | `OPT-005` |
| Login, logout, callback, and profile | P0 | Intentional P0 | None |
| Root/default-project resolution | P0 navigation | Server identity is required; retained shell or cached destination may improve latency | Future measurement, not an optimistic mutation TODO |
| Thread trash/archive UI | Not present | API support exists but there is no writer surface | No TODO until the product adds the interaction |
| Agent steering | Not present on this branch | Reuse acknowledged submission if introduced | No second send mechanism |

## Required verification

Each changed interaction adds only the profile-relevant contract tests.

### All P1 through P3 flows

- The projection or destination is visible before the request resolves.
- A definitive refusal follows the declared retire/revert/invalidate rule.
- An ambiguous failure follows the declared retain/lookup/retry rule.
- A late read or response cannot move state behind a newer intent.
- Account or project replacement cannot admit a late result.
- Pending and failure are visible and accessible on the affected entity.

### P2 creation

- Client identity remains stable through materialization.
- Navigation occurs before persistence resolves.
- Failure remains on the destination.

### P3 durable submission

- The durable intent exists before dispatch.
- Reload resumes or reconciles it.
- Repeated dispatch with the same key does not duplicate the effect.

### P4 local-first replica

- Local state survives disconnect and reload where promised.
- Transport failure changes status, not document content.
- Concurrent peers converge according to the replica contract.

### P5 reconciler

- Local state paints before the server list.
- A stale snapshot cannot erase newer local state.
- Account mismatch rejects persisted and in-flight data.
- Removal and identity authority match the declared precedence rule.

Use controlled deferred promises for timing tests and a real browser probe for
navigation, reload, focus, and entity-scoped presentation. A passing final
assertion without evidence that the intended request was delayed is not a valid
optimistic-interaction probe.

## Adoption

1. New mutations classify themselves before implementation.
2. Existing flows migrate when touched, except TODO items marked as current
   product-contract violations.
3. Add typed TanStack mutation metadata and key conventions when the first two
   P1/P2 migrations need cross-component pending state. Do not add them only to
   satisfy this document.
4. Fix durable first-send before claiming reload/offline chat continuity.
5. Keep P4 and P5 owners separate from TanStack mutation state.
6. Delete unwired optimistic code or connect it to a real command; do not count
   dormant reducers as product behavior.

## Rejected designs

- A Meridian wrapper around `useMutation`.
- One global optimistic data store.
- Whole-list snapshot rollback under overlapping writes.
- Treating every thrown request error as definitive rejection.
- Client retries without idempotency or lookup.
- Optimistic overlays for Yjs edits.
- Moving device preferences into server state merely for consistency.

## Research basis

The source study and full inventory are retained in the work item
`optimistic-interactions-study`. Primary references:

- [TanStack Query optimistic updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
- [Apollo Client optimistic UI](https://www.apollographql.com/docs/react/performance/optimistic-ui/)
- [Relay mutations](https://relay.dev/docs/api-reference/use-mutation/)
- [RTK Query optimistic updates](https://redux-toolkit.js.org/rtk-query/usage/optimistic-updates)
- [Automerge conflicts](https://automerge.org/docs/reference/documents/conflicts/)
- [Replicache rebase model](https://doc.replicache.dev/concepts/how-it-works#rebase)
- [ElectricSQL write patterns](https://electric-sql.com/docs/guides/writes)
- [Stripe idempotent requests](https://docs.stripe.com/api/idempotent_requests)
