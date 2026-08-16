# Composer write mode

This page defines the Work-scoped composer write-mode and sizing contracts.

The compact current-value write-mode trigger lives in the composer footer beside
Agent and Work because write mode is a property of the conversation's Work, not
workspace navigation. It opens the toolbar's write-mode page for the Draft and
Auto-apply choices instead of spending persistent width on both choices.
`ProjectView` resolves the displayed thread’s Work once at the project
composition boundary and passes that same Work identity to `DraftReviewProvider`
and `ChatView`; the dock and composer control therefore share one binding. If
either side of `thread → work` is absent, the control is not rendered. The
independent chat composition root performs the same resolution for its thread.
There is no first/default-Work fallback.

`useComposerWorkBinding` owns Work interaction, mutation presentation, and
Undo. `useThreadDurableProjections` owns transport projection, while
`convergeThreadWorkBinding` owns all cache effects. `ComposerWorkControl`
renders the measured inline/overflow entry only in the composer; headers remain
chat identity surfaces. This rebind capability is present in the checkout but
diverges from the settled fixed-at-creation Work contract.

The row passes Agent, Draft / Auto-apply, and Work descriptors to the shared
measured `ComposerToolbar`. It observes the actual flex allocation left beside
Send and every mounted control's intrinsic width. Controls move behind one
compact ellipsis in Work, write-mode, then Agent order. Feature controllers
retain their state while the framework migrates their panel between inline and
overflow hosts. Chat headers display only chat identity. The Work controller
owns mutation, error, and live-convergence state, never placement. Switching
back is an ordinary picker selection; the toolbar has no sibling Undo action.

The shared toolbar owns popup topology, trigger policy, placement, and page-aware
focus; feature controls own domain state and page content. See the
[composer-toolbar contracts](../../../components/app/composer-toolbar/.context/CONTEXT.md).

`ComposerWorkControl` can currently rebind an idle existing thread. The
controller carries that legacy behavior through cache convergence and durable
projection, and writer and LLM adapters share one server transition. Treat this
as containment knowledge for removal, not as permission to add entry points.

The neutral `useSelectedWorkWriteModeToolbarControl` owns the selected-Work
mutation and uses the active-draft count only to open confirmation quickly.
Every Auto-apply selection sends an
unconfirmed request; the server-vended count of reviewable content branches is
the number shown in the confirmation. It is not a raw journal-row or active
branch count: manifest-membership bookkeeping does not represent prose waiting
for review. Moving Draft → Auto-apply with pending changes keeps Draft selected
and opens the **Drafts are waiting** popover. Cancel preserves the mode; Review
changes receives the project dock's `useAiDraftLauncher` entry from each
composer adapter, the same entry used by every other review control;
Apply all and switch is the only action that sends `confirmedPush`. It asks the
server to apply the same canonical pending set, including any manifest companion
needed to publish new-document membership, and only then switch policy. A failed
push leaves Draft selected. Loading draft data never disables the Auto-apply
choice; a nondismissible write-mode request temporarily disables page actions
while the toolbar retains a focusable dialog fallback. The sidebar has no
write-mode control.

The dock projection is tri-state while its query loads: pending count and review
availability are `null`, distinct from loaded zero/false. If a client fast path
opens the confirmation before the authoritative response returns, the popover
keeps the existing **Checking pending changes…** copy and disables actions that
need the unresolved projection. Auto-apply remains selectable so its
unconfirmed request can ask the server; loading client state must never imply
that nothing is pending.

The shared Work picker and selected-Work write-mode presentation live in the
neutral `components/app/work-composer-controls` boundary. Home and Chat adapt
that presentation to different commands: Home edits prospective creation state,
while Chat still contains the divergent durable-rebind adapter. Home's selected Work is
already durable, so its write-mode control reads and mutates that Work's real
policy before thread creation; it does not invent a provisional mode. Draft
review launch behavior is injected by each project-shell adapter rather than
imported into the neutral controls.

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
