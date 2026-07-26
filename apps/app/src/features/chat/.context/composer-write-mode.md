# Composer write mode

This page defines the Work-scoped composer write-mode and sizing contracts.

The Draft / Auto-apply selector lives in the composer footer beside the agent
pill because write mode is a property of the conversation's Work, not workspace
navigation. `ProjectView` resolves the displayed thread’s Work once at the project
composition boundary and passes that same Work identity to `DraftReviewProvider`
and `ChatView`; the dock and composer control therefore share one binding. If
either side of `thread → work` is absent, the control is not rendered. The
independent chat composition root performs the same resolution for its thread.
There is no first/default-Work fallback.

`ComposerWriteModeControl` owns the mutation and uses the dock-derived pending
count only to open confirmation quickly. Every Auto-apply selection sends an
unconfirmed request; the server-vended count of reviewable content branches is
the number shown in the confirmation. It is not a raw journal-row or active
branch count: manifest-membership bookkeeping does not represent prose waiting
for review. Moving Draft → Auto-apply with pending changes keeps Draft selected
and opens the **Drafts are waiting** popover. Cancel preserves the mode; Review
changes uses the same `useAiDraftLauncher` entry as every other review control;
Apply all and switch is the only action that sends `confirmedPush`. It asks the
server to apply the same canonical pending set, including any manifest companion
needed to publish new-document membership, and only then switch policy. A failed
push leaves Draft selected. The Auto-apply choice is never disabled, and the
sidebar has no write-mode control.

The dock projection is tri-state while its query loads: pending count and review
availability are `null`, distinct from loaded zero/false. If a client fast path
opens the confirmation before the authoritative response returns, the popover
keeps the existing **Checking pending changes…** copy and disables actions that
need the unresolved projection. Auto-apply remains selectable so its
unconfirmed request can ask the server; loading client state must never imply
that nothing is pending.

Home bootstrap is a distinct path: its optimistic thread has no Work while the
first message is handed off, and project plus default-Work creation occur
mid-handoff. That first turn therefore uses the new Work's `direct` default
before the composer can expose the mode control. In-project new threads already
have a Work and do not have this gap.

Each assistant turn durably records the Work write mode read when that turn is
created. Tool vocabulary and receipt interpretation use the turn's recorded
mode, not the Work's current mutable policy, so a later mode switch cannot
rewrite history after reload.

### Composer placeholder and sizing contracts

`placeholders.ts` owns the per-page-load compose and interject prompt pools as
Lingui `msg` descriptors. `selectPagePlaceholders()` advances localStorage once
per page load and freezes that selection; component re-renders do not consume
another entry. `useSyncExternalStore` supplies a stable first descriptor during
SSR and the rotated descriptor on the client, while locale resolution happens
inside the hook. Composer owns rotation; its `placeholder` prop remains the
explicit override used by the Home hero.

The base `Textarea` applies `field-sizing-content`, but Composer's JavaScript
resize loop requires `field-sizing: fixed`. Keep that override inline:
Tailwind merge does not reliably deduplicate `field-sizing-*` utilities.

For the shared pending projection and draft-review lifecycle, see
[draft review](draft-review.md).
