# Changelog

## [Unreleased]

- `apps/app`: the dev DebugOverlay now opens an LLM Calls dashboard that groups metadata-only gateway lifecycle events without verbose records consuming its query budget, summarizes latency, tokens, outcomes, retries, and stream-event aggregates, and loads model-request content only on explicit per-call expansion.
- `apps/server`: gateway calls now emit correlated open, first-output, retry,
  and close lifecycle events; development/test processes can opt into
  metadata-only chunk events with `OBS_VERBOSE=gateway.chunks`.
- `apps/server`: local JSONL diagnostics now bound pending writes to 5,000
  events, drop oldest under filesystem backpressure, and report loss through
  `observability.sink.dropped`.
- `apps/server`: observability events now receive stable IDs at emit time for
  use as incremental debug-feed cursors.
- `apps/server`: observability now provides a sanitized 5,000-record recent
  events ring, filtered query/subscription port, and multi-sink tee adapter.
- `apps/server`: authenticated development/test servers now expose filtered
  recent events at `/api/debug/events` and a live SSE feed at
  `/api/debug/events/stream`; production and disabled providers return 404.
  The dev DebugOverlay can toggle that server feed into its existing Streams
  trace ring, filters, and exports.
- Server debugging guidance now distinguishes authoritative stdout from the
  best-effort bounded JSONL mirror and documents query, SSE, and `jq` workflows.
- `apps/server`: fresh-project documents are now initialized exactly once in
  canonical Yjs storage, interrupted bootstrap seeding repairs on later entry,
  warm collaboration rooms reconcile with the seed, and AI causal-cut capture
  initializes missing authority heads without requiring an editor open (#317).
- `apps/app`: universal document identity bar — every open document shows a
  quiet breadcrumb (`Scratch › Untitled 4`) at the top of its canvas, sized to
  match the suggestion dropdown, with a permanent chip whose label graduates
  with the document (“Choose a home” in jade while untitled, quiet outline
  “Rename” once homed) and the device-only warning in the same slot (2s
  grace, tracked per document). The chip is the only edit entry — the
  breadcrumb is inert, reserved for per-segment navigation. Untitled drafts
  place themselves through an empty field with the content-derived name as
  ghost text and a destination browser that opens on the scheme roots. Homed
  documents use the same inline field, pre-filled and selected for immediate
  rename, with current-folder siblings and writable roots for moves. The field
  carries explicit ✓/× buttons mirroring Enter/Esc. Collisions surface the
  canonical locator with Open-existing recovery; intents queued on
  still-materializing drafts report failures instead of dropping them.
  Replaces the provisional-only untitled rename line.
- `apps/server`: context moves gain `clearProvisionalName` — the writer-facing
  move route ends provisional naming on every explicit placement (even when
  the name stays Untitled-N), while port-level system moves preserve it.
- `apps/server`, `@meridian/contracts`: context entries can move across folders,
  schemes, and Work scopes over HTTP; Scratch documents can be promoted to the
  Manuscript without changing their Yjs authority or provisional-name state.
  Move targets now have exact collision semantics, return a canonical collision
  locator for Open-existing recovery, and share reason-coded path normalization
  with client create/rename validation.
- `apps/server`: project-manifest reconciliation is now an explicit,
  cross-replica-serialized command; ordinary membership reads never reconcile
  or append membership history,
  concurrent cold starts create one seed update and one initial checkpoint,
  and the WebSocket membership gate heals legacy omissions on demand (#279).
- `apps/app`: collaborative document transport now waits for IndexedDB replay
  before connecting, avoiding redundant full-state uploads on reopen while a
  one-second fallback keeps connectivity available when local storage stalls.
- `apps/server`: live writer sync admission now uses Hocuspocus's single decoded
  `beforeSync` payload, a mutation-aware exact containment cache with a
  state-vector novelty fast path, and a narrow reusable writer-ingress
  capability instead of rebuilding a full document-authority facade per frame.
- `apps/server`: repeated project-manifest reads no longer append identical Yjs
  updates, stopping unbounded manifest history growth and eventual worker OOMs.
- `apps/app`, `apps/server`: cross-device working-set sync — reopening
  Meridian on another device resumes the same document, recent tabs, and
  chat thread (#217). One row per user·project (`project_user_working_sets`);
  debounced whole-snapshot PUTs with revision-checked acks; four-case
  hydration at project entry (server wins on true conflict); recovery paths
  (PUT failure, offline→online, sync re-enable) mark the baseline suspect
  and GET-before-PUT so stale offline state never overwrites newer devices.
  One toggle in Settings › Preferences: "Resume where I left off on any
  device" (default ON; fails closed when the preference can't be read).
  Device-local restore storage (`context-last-route`) is replaced by the
  canonical working-set store; local restore behavior is unchanged.
  Resume is optimistic: the remembered document's tab and a loading
  skeleton render immediately on entry instead of flashing the empty
  "Resume / New document" state while the file tree loads. Settings ›
  Preferences is split into "This device" (language, text size) and
  "Account" (sync toggle) tabs.
  The full tab desk persists device-locally: reload restores every open
  tab (including in-flight untitled docs) on all sync branches — inside
  the sync debounce, with sync off, or offline; a newer server snapshot
  still replaces the desk. Closing a background tab no longer erases the
  synced recent list; deleted documents drop out of it on next entry;
  clearing the desk then reloading default-opens instead of landing on
  an empty New-document canvas.
- `apps/server`: concurrent cold project loads now adopt one active manifest
  identity instead of failing the losing request with a uniqueness error.
- `apps/server`: reconnecting to a document no longer journals already-contained
  cached Yjs state or delete sets as fresh human edits.
- `apps/app`: the dev debug overlay gains a pop-out Streams trace viewer showing
  live client Yjs and agent-stream wire traffic as metadata-only records without
  blocking the editor;
  browser agents can query, filter, clear, and await those records through
  `window.__meridianTrace`; socket lifecycle records are queryable by message
  class or event name.
- `tools/dev`: local DB integration suites now create, migrate, and remove a
  unique per-run database without touching the worktree database; `dev:gc-dbs`
  preserves active runs and the reserved manual-test namespace while reclaiming
  stopped managed runs.
- `apps/server`, `apps/app`: work-scoped Scratch/Uploads documents now resolve
  project ownership and register in the live project manifest, so their Yjs
  editors can connect; the works bootstrap response also exposes the project's
  single default Work for chat-independent Scratch surfaces.
- `apps/app`: whole editor pane is click-to-focus — presses on the margins
  place the caret at the nearest text position (never a block boundary, so
  collab cursors can't render phantom rows between paragraphs); the pane
  shows the text cursor throughout.
- `apps/app`: returning to the Editor reopens the last-active document
  (restore now re-arms on every screen entry); fresh projects auto-open the
  first manuscript file instead of an empty state.
- `apps/app`: tab file icons use one muted ink (jade/streaming/destructive
  no longer spent on file-type metadata); read-only viewer header/footer
  stop painting muted bands; "Preview not available" fallback is a quiet
  empty state instead of a boxed card; rail↔chrome corner joins the shared
  radius.

- `@meridian/contracts/observability`: shared JSON-natural observability records
  now include stream references and document, branch, and Yjs correlation fields.
- `@meridian/yjs-inspect`: inspect complete Hocuspocus frames and summarize Yjs updates with merge-valid struct/delete spans and canonical correlation keys; invalid updates return safe identifying metadata, and the journal decoder rejects incomplete expanded records and handles CLI flags explicitly.
- `@meridian/yjs-inspect`: classify Hocuspocus durable-sync acknowledgements and
  close/ping/pong controls without exposing close reasons.
- `packages/agent-edit`, `apps/server`: destructive-write safety gate — agent
  writes that would structurally delete blocks a human concurrently edited are
  rejected before anything becomes durable (`rejected_response_requires_reread`);
  a per-(session, document) READ-REQUIRED fence blocks further writes until the
  agent re-reads. Other-agent edits never trip the gate.
- `apps/server`: new `notices` domain — typed safety notices (rejection,
  late sweep, checkpoint sweep, degraded awareness) drain into model context
  before every model call and deliver writer receipts below the editor
  toolbar; notices are transient, never persisted turns.
- `apps/server`: response commits settle process-local state (thread-peer
  cache, facade ownership, watermarks, lifecycle) against the actual Postgres
  transaction outcome via a response-commit unit-of-work; rollback leaves zero
  response-scoped residue and responses stay retryable. Proven by a
  real-Postgres 10-surface integration test.
- `apps/server`, `packages/agent-edit`: every safety-relevant `Y.applyUpdate`
  (response phase C, immediate commits, branch pushes, reversals) re-checks a
  synchronous live-doc snapshot immediately before apply; concurrent WS edits
  swept after durability are reported (late-sweep notice + fence), never silent.
- `packages/agent-edit`: agent mutations carry a `MutationActor`
  (agent/human/system); undo/redo of agent writes gates on affected human
  edits and fails closed without a baseline.
- Schema: `pending_notices` + `pending_notice_deliveries` tables; actor
  columns on `agent_edit_mutations` and `document_yjs_updates`; legacy
  `pending_undo_notifications` dropped (migrations 0038–0041).
- New look: an earthen value ladder — one warm grey-gold family separated by
  lightness. The left rail is the chrome's grey-gold one shade darker with
  the app's standard black ink (12.6:1); the tab band and right dock share
  the brighter chrome; the page is warm paper, always the brightest surface,
  rising from the chrome with rounded top corners matching the tabs. Jade stays the action color (send/save/new); no colored walls.
  The pinned chat composer uses the manuscript background with a border
  (works in dock and center). Region separation is tonal — no shell divider
  lines. Both rails carry faint floor atmosphere (shadow on the shelf,
  airlight on the dock). All rail text tiers verified ≥4.5:1.
- The dock's Chat/Changes switch is a contained segmented track (recessed
  well, paper active segment); the dock header shares the dock's own surface.
  Resize handles have no visible grip — cursor and focus ring only.
- The centered chat header's title is a real tab now — the chat page rises
  into the band, same grammar as document tabs. The switcher dropdown uses
  pressed-neutral active rows (no jade wash on routine selection; agent
  picker swept to match).
- The dock header always names the thread the chat body actually shows (it
  could sit on a static "Chat" before), the rename field can't overlap the
  view switch, its hover pill isn't clipped anymore, and the dock can't be
  resized below usable width.
- "No pending changes" in the dock is a proper empty state (icon, title,
  caption) instead of a bare sentence.
- Removed duplicate design tokens: `surface-warm`/`surface-subtle` (use
  `card`/`muted`), `ink-strong` (use `prose-foreground`),
  `status-streaming-ring-strong` (one ring token), `gradient-mark`,
  `gold-text`, `mark-from`; popovers share the card surface.
- Renaming a tracked document now keeps its persisted filetype aligned with the
  editor schema; cross-schema and tracked-to-binary renames are rejected clearly,
  and overlapping writes keep the same document identity.
- The editor chrome lost its lines: the tab strip separates by tone alone
  (recessed strip, canvas-colored active tab), and the formatting toolbar is a
  bare docked row aligned to the text column — shared exactly by tracked and
  temporary documents, so nothing shifts when switching tabs.
- Temporary documents warn “Only on this device” until saved, and saving can
  never discard words typed while the save was in flight.
- Saving a temporary document is one VS Code-style line: a single location
  field speaking the context-URI grammar (`manuscript://folder/name`), a
  folder browser that opens while the field is focused, and Enter to save.
  Picking a folder keeps the name and selects it for overtyping; new folders
  in the typed path are created on save.
- The save-location browser is navigable: clicking a folder descends into it
  (the list stays open), `..` climbs out — up to the scheme list — and files
  are listed alongside folders so existing names are visible before saving;
  clicking a file adopts its name. A trailing slash browses into that folder.
- Name collisions are caught while typing, in the same red note the file
  tree's rename uses — "A file named X already exists in this location." with
  an Open existing shortcut — and Save is disabled until the name is free.
  There is deliberately no overwrite path onto existing documents.
- Save-location browser keyboard flow: arrow keys rove the list — including
  the collision note's Open existing action — with a single Tab exiting it,
  Escape returns to the field, and clicking the field reopens the browser.
  Contexts show their identity icons instead of folder icons.
- Scheme identity icons re-derived: Manuscript gets a custom quill-and-scroll
  (no longer the same glyph as every file row), Knowledge Base a library
  shelf, Scratch a notebook pen (the old brain meant a scheme that no longer
  exists). User and Uploads unchanged.
- A save conflict from another device reopens the browser with the notice —
  never just a silent red border — and editing the name dismisses it. Saving
  can no longer double-submit when edited mid-flight.
- The editor tab bar keeps its “New tab” plus button available when no documents
  are open and identifies it on hover.
- Tabs are clickable across their whole surface, hover highlights the full tab,
  the active tab curves outward into the page at its base, and a divider sets
  the plus button apart from the open tabs.
- Clicking below the last line of any document places the cursor — tracked
  documents now match temporary ones.
- Corners are sharper everywhere: buttons, fields, menus, tabs, and the
  composer read semi-rectangular instead of pill-like.
- Focus is calm: clicking into a text field shifts its border to a soft jade
  hairline instead of flaring a glow ring, text selection inside fields is a
  light tint instead of a solid pill, and buttons show a focus ring only
  during keyboard navigation.
- The dock's Chat/Changes and Context/Changes switch is now static tabs in the
  same shape as document tabs — a recessed header band with the active view
  surfacing out of it — and the redundant section title is gone.
- Tracked writes can no longer replace storage-backed binary files, and one
  exhaustive filetype registry now drives editor-schema classification.
- Mobile context rows now honor server file metadata for image icons, including
  formats without a registered viewer extension.
- Tracked text creation now rejects binary-suffixed paths and directs writers to the upload flow.
- Bare names, unknown extensions, and plain-text files now open in the normal document
  editor; only explicit code filetypes use the code schema. Existing text journals need
  no repair because their code blocks remain legal document content.
- `packages/database`, `apps/server`: renamed the content-document kind from
  `manuscript` to `content`, separating stored document type from URI scheme.
- Fixed code documents gaining Markdown fences during checkpoint restore, branch reads, and review previews.

- `apps/server`: require manifest membership when composing production context
  storage, so project document creation and deletion cannot silently skip the live manifest.
- `apps/server`: documents created with initial content now survive their first
  open — content is seeded in the schema the editor mounts (code files get one
  verbatim code block), so client normalization no longer silently deletes it (#196).
- `apps/app`, `apps/server`: temp-document Save creates atomically; a name
  collision returns a typed conflict with Open existing / Rename recovery and
  never overwrites the existing file (#197).
- `apps/app`: new-tab controls now open local-only temporary documents that persist
  across reloads, yield to route-driven file opens, and are retired on save only
  when no newer local words exist (revision-guarded).

- `apps/server`: documents created in any context (Knowledge Base, User) now
  open a live editor — creations register in the project manifest for all
  schemes, so the websocket gate no longer denies non-manuscript documents
  and renders them permanently empty.
- `apps/app`: the empty editor now offers to resume the last document or start
  a new document — a temporary document whose location is chosen at save time
  from any context, replacing the manuscript-hardwired "New chapter".
- `apps/app`: the chat header switcher is now a searchable popover navigation
  surface with thread recency, attention, active-row rename, and new-chat access.
- `apps/app`: the persistent project sidebar now combines destination links
  with the file tree, removes the redundant chats list and embedded files
  panel, and presents the Context destination as Editor.
- Docs: local Postgres CLI examples now fail fast instead of prompting for passwords.
- `packages/agent-edit`, `apps/server`: whole-document create overwrites now
  reuse compatible ProseMirror block identities through inline and whole-block
  diffs, so concurrent writer text survives Yjs projection instead of being
  tombstoned by delete-all/insert-all updates. Unmatched blocks in a shrinking
  overwrite remain a documented concurrent-loss window pending canonical-state
  advancement detection and replanning.
- `packages/agent-edit`, `apps/server`: response commits now use exclusive
  `Buffered | Committing | Closed` ownership; late commits join one promise,
  staging/drop/rollback cannot race an owned commit, write apply→submit restores
  speculative runtime state or recovers durable projection, response IDs belong
  to one thread core, and write wiring/formatting/baseline ownership is narrowed.

- `packages/agent-edit`: ResponseCommitter hardening — staged idempotency cache hits
  re-validate open responses; concurrent `commitResponse` joins before journal append;
  commit snapshots buffer updates and defers `dropForThread` during in-flight commits;
  `onClaimDiscarded` observer throws cannot alter commit outcomes; dead
  `createResponseStaging` alias removed; `ResponseStaging` renamed to `ResponseCommitter`.
- `packages/agent-edit`: ResponseCommitter move-1 review fixes — full re-projection on
  retry (no resume-from-partial), observer throws cannot reclassify durable journal
  commits, live lifecycle state for staged-create outcomes, deduped first-stage
  transition, and `threadId` on commit/rollback/recovery emissions.
- `packages/agent-edit`: Response lifecycle values track observable commit phases;
  `write.ts` splits dispatch, idempotency, command handlers, and reversal endpoints.
- `packages/agent-edit`, `apps/server`: ResponseCommitter state machine — collapse
  `response-staging` + `mutation-commit` into one module with explicit phases
  (`buffered → journalCommitted → liveProjected → closed`) and structured `response_committer.*` EventSink events on every
  lifecycle branch.
- `apps/app`: turn reversal waits for refreshed lineage before settling, so
  refused Undo attempts immediately replace the stale Undo affordance.
- `apps/server`: project/work thread lists and snapshots now derive soft
  `waitingForUser` state from the same `active_leaf_turn_id` logical head, so
  tied turn timestamps cannot make sidebar lifecycle state flip on refetch.
- `apps/server`, `apps/app`: thread rows now expose closed attention states:
  pending `ask_user` interrupts require action, completed assistant replies are
  unread until the writer opens the thread, and all other rows carry no badge.
  Sidebar badges use gold-warning/action and jade/unread tokens with concrete
  hover explanations.
- `apps/server`: project/work thread lists and snapshots now use the same
  `active_leaf_turn_id` logical head, so tied turn timestamps cannot make
  sidebar lifecycle state flip on refetch.
- `apps/app`: a live document with a pending AI draft shows a review banner
  below the toolbar — Review opens inline review, Back to live returns to the
  banner. Same button grammar as the review header; jade dot = pending,
  primary = reviewing.
- `apps/app`, `apps/server`: new-document drafts carry `isNewDocument` end to
  end — the dock row shows the `New` badge and Review opens a synthesized tab
  before the document exists in the tree.
- `apps/app`: draft-only tabs follow their draft — apply keeps the tab on live
  content, discard closes it and repairs the route. No ghost tab, no dead URL
  after reload.
- `apps/server`: discarding a new-document draft removes its work-manifest
  entry, so a later apply in the same work can no longer resurrect it as an
  empty editable file.
- `apps/app`: applying a draft reauthorizes live sessions the registry had
  cached as denied — no more "Access lost · not saving to server" until reload.
- `apps/app`: context trees refresh within ~5s of turn end and after applies;
  agent-written documents appear in the tree without navigation or reload.
- `apps/app`: the Draft → Auto-apply switch counts only content-bearing drafts
  and stays disabled until the drafts list loads — no phantom-pending warning,
  no silent flip while pending state is unknown.
- `apps/app`: DraftDock gates mutating verbs and the bulk pump on `controller.isDisposing` so per-card Apply cannot overlap composer-strip dispositions.
- `apps/app`: draft accept paths drop the no-op `waitForDraftDocumentSync` stub — preview revision-token fetch is the disposition gate; server expands per-card closure from the single `operationId`.
- `apps/app`: export canonical `occupantOf` from project layout; DraftDock launcher and ProjectShell share it.
- `apps/app`: sync chat draft-review knowledge layers to branch-review model (drop deleted overlap/cannot_place protocols; fix draft-undoable path).
- One typographic hierarchy across writing surfaces: the manuscript editor rides the text-size preference at full scale, and chat reads exactly one tier below it (md→sm, sm→new xs, lg→md) — conversation is working material, the manuscript is the artifact. Editor prose color now matches chat prose (it was rendering a darker, visually heavier foreground at the same size).
- Markdown code and tables in chat join the reading scale: inline code uses the same code-surface chip as the editor and em sizing (was a fixed-size `bg-muted` chip that ignored the preference), block code and table cells ride the scale (cells were pinned to a fixed size while headers scaled), and view-change diff excerpts use the real reading scale (dead `text-prose` class).
- `apps/app`: FG-11 round-8 client fixes — write tool errors render from structured
  `tool_error` payloads; live-editor lineage invalidation attaches while Context is
  docked; Discard all pumps through a captured pending snapshot so stale work-drafts
  queries cannot abort after the first reject.
- `packages/agent-edit`, `apps/server`, `tools/dev`: FG-10d journaling
  observability — idempotency cache hits and undo-notification failures emit
  structured `EventSink` events; dev defaults `LOG_DIR` to `logs/events/`.
- `packages/agent-edit`, `apps/server`: FG-10c type tightening — `appendBatch`
  results require `journalCommitKind`, interaction-context merge rules live in one
  module, and successful `WriteOutcome` values carry `phase: staged | committed`.
  `dropForThread` loud discard on commit, `persistUndo` in-transaction undo
  guards, bounded response lifecycle tombstones, and sorted multi-doc push
  lock order.
- `apps/app`: failed `write` tool rows now show a failure verb and expanded error
  text instead of past-tense success; error status is screen-reader accessible.
- `apps/server`: mock gateway accepts optional `[[write <uri>]]` / `[[write <uri> overwrite]]`
  directives in user messages for gate probes without changing default mock behavior.
- `apps/server`: manuscript context tree no longer 502s during fresh-project manifest
  bootstrap — pre-seed membership resolution falls back to an unfiltered list.
- `apps/app`: turn Undo chip refetches lineage when the mounted live editor document
  mutates, so `cant_undo_dependent` surfaces as View change without waiting on stale cache.
- `apps/server`, `apps/app`, `packages/agent-edit`: draft branch sync now partitions
  agent journal deltas from unjournaled writer residuals, fences discarded
  generation replays, uses semantic Yjs update detection instead of byte length,
  and leaves failed inline-review room entry recoverable with retry/exit.
- `apps/server`: S1 branch peers now store their own snapshot schema version, keep hidden manifest identity rows out of manuscript content surfaces, and make the in-memory branch fixture enforce the same active-branch constraints as Postgres.
- `apps/app`: `/proto/dock-tabs` v2 — dock header row with segmented switch
  (replaces tab strip), chat thread select dropdown in center chat and dock,
  anchored/titled header-mode proto toggle, dock-width 240/360 for narrow
  testing; keeps Changes content, Review wiring, arrangement/badge toggles.
- `apps/app`: `/proto/dock-tabs` mockup — tabbed right dock with work-scoped
  Changes tab; chat-main vs context-main arrangements, badge on/off toggle,
  Review/change-row navigation wired with hardcoded fixtures.
- `apps/app`: agent identity is now name-forward — dropped the two-letter
  initials avatar and dissolved `AgentChip`, keeping each surface on the shared
  `Badge`/`Button` primitives it actually needs. The chat pane header shows a quiet
  "Writer │ Chapter 1" layout (muted agent label + hairline divider) instead of
  the avatar pill and middot.
- AI changes in draft mode now gather in one thin strip on top of the composer
  instead of scattered cards in the conversation. It shows what changed while
  the agent is writing, then settles into the list of documents to review, with
  Review / Apply / Discard right there. Expand it to walk each document, and it
  guides you to the next one until everything is reviewed, then disappears.
- Each turn in the conversation now carries a quiet one-line record of what it
  edited, and the whole draft/undo vocabulary is consistent everywhere: Review,
  Apply, Discard, Undo — no more Accept/Reject/Open.
- While you still have pending AI changes, the write mode stays on Draft; the
  Auto-apply option is disabled with "Review pending changes first".
- Inline draft review now handles every kind of content: scene breaks (`---`),
  lists, and other non-paragraph blocks show as whole-block changes — new block
  ringed green, removed block struck full-width. No draft falls back to a
  docked diff panel anymore; that panel is deleted.
- Discarding a removed-block proposal now works: the block stays in the draft
  and the card clears, instead of erroring with "That change is still in the
  draft".
- Moving a scene break or list (delete here, add there) always shows both
  changes in review — identical-looking blocks can no longer cancel each other
  out invisibly.
- After applying a draft, its "Undo apply" chat receipt steps aside while a
  newer draft is active on the same document, and returns once that draft is
  resolved.
- A "Can't place" draft heals automatically: when the manuscript changes enough
  for placement to succeed again, Apply comes back without reopening review.

- Draft undo restores the original review cards with their AI/You attribution intact, even after a later agent edit adds more draft changes.
- Accepting draft changes after undo keeps writer content safe: no deleted, duplicated, or misplaced text from stale draft history.
- When an AI proposal can no longer be placed because you reshaped that part of the manuscript, it becomes a clearly-marked "Can't place" card showing the full proposed text to copy — instead of silently failing, looping, or overwriting your edits. Applying the whole draft in that state keeps every one of your paragraphs.
- Later agent turns are told the current draft review state, including applied proposal counts and whether the writer can still undo.

- `apps/server`: undoing an AI draft Apply now restores the draft against the post-undo live document, so re-entering review shows the full diff and applying again writes a fresh live mutation.

- `apps/app`, `apps/server`: inline draft review. Reviewing an AI draft now
  opens the manuscript itself with Track-Changes-style highlights — green for
  AI proposals, gold for the writer's own edits, red strikethrough widgets for
  deletions. Authorship paints per span: writer text typed inside an AI
  proposal nests gold-in-green at exact boundaries, and locally typed text
  paints gold instantly (no server round-trip). A proposals sidebar shows one
  card per change — Renamed/Added/Removed/Rewrote title, "before" → "after"
  excerpt, region count, producing-turn ref, AI or You badge — with
  per-proposal Discard; discard is instant, Ctrl+Z brings it back. The writer
  edits the draft freely during review; Apply commits the curated result in
  one click. Every draft reviews inline.

- `apps/server`: drafts are now scoped to a Work instead of a thread — sibling
  threads in the same work see and contribute to one shared draft, and
  finalization invalidates in-flight responses work-wide. Migration remaps
  existing draft rows.

- `apps/server`: each draft is its own collaboration room (`draft:<id>`)
  persisted to the draft journal; the live manuscript room is untouched during
  review. Draft finalization closes the room and fences late writes.

- `apps/server`, `apps/app`: agent and writer edit the same draft concurrently
  during review. New AI edits appear live as additional proposals in the open
  review surface, while Apply still refuses unseen draft content and refreshes
  before retry.

- `apps/server`: Apply is fenced by the draft revision the writer actually
  reviewed — if the draft changed under them, Apply refuses and the review
  refreshes instead of committing unseen content.

- `apps/server`: historical Yjs journal reads are now bounded — a newer live
  checkpoint can no longer leak future state into a draft's base, overlap
  detection, or reject reconstruction.

- `apps/app`: every draft surface is one line with one primary action. The editor entry banner reads "AI drafted changes · Open AI draft" — opening jumps to the manuscript, collapses both side rails for full-width review, and restores them on exit. During review a slim bar shows "Reviewing draft · N operations · M regions · Cancel · Apply all". The chat draft card is a Cursor-style bar docked above the composer ("chapter-1 has changes · Discard / Apply / Review"); multiple active drafts collapse to one "N documents have AI changes" row at rest. Applied/discarded states remain document-scoped undo banners/receipts, but terminal draft history no longer stacks in the composer dock. Transcript receipts are muted one-liners ("Applied AI draft to \"chapter-1\"") with no internal ids. Undo state is server-backed and survives reloads.

- `apps/app`, `apps/server`: drafts are reviewable without a chat open. Draft list and accept/reject/undo routes are keyed by Work (`/api/projects/:id/works/:id/...`), the review provider mounts with the project, and the editor shows the draft banner whenever the open document has one — the producing thread is resolved server-side for transcript receipts.

- `apps/server`, `apps/app`: AI write mode lives on the Work (`works.ai_write_mode`). Switching to "Apply directly" is blocked — with the reason shown — while the work has active drafts or in-flight draft turns; switching to review mode is always allowed.

- `apps/server`: the AI can create new documents in draft mode. The new document arrives as a reviewable draft: Apply materializes it as a live document, Discard deletes it entirely. AI turns that fail mid-write clean up their half-created drafts and placeholder documents instead of leaving broken review state, and Apply refuses drafts whose originating create never committed.

- `apps/app`: threads with unreviewed AI drafts now show a count chip in the sidebar and Switch chat menu, so pending changes outside the focused conversation stay findable.

- `apps/server`, `apps/app`, contracts: runtime human pause is now an interrupt; checkpoint is reserved for Yjs restore snapshots. The blocked-thread badge says "Needs your answer", wire/status names moved to interrupt (`waiting_interrupt`, `kind: "form"`, `kind: "ask"`), and a migration updates the turn status constraint.

- Tests: billing free-tier grants use deterministic ledger time, and draft/write-mode route
  coverage now protects behavior without pinning route-core choreography.

- `apps/server`, `apps/app`: applying or discarding an AI draft no longer touches the conversation transcript. The producing assistant turn's draft card carries applied/discarded state + Undo, while later agent turns learn about draft lifecycle events through injected system context.

- `apps/server`: draft accept/reject is now DB-fenced. Concurrent accepts report in progress, stale draft responses cannot recreate closed drafts, and applied retry recovers the live Yjs doc after a crash between journal write and live apply.

- `apps/server`: reloading the page or a dropped WebSocket no longer cancels an
  in-flight agent turn. The run finishes server-side and a reconnecting client
  reattaches via the existing snapshot/resume path — long turns survive accidental
  reloads and flaky connections instead of losing the work and spent credits. Only
  an explicit Cancel (or a real provider error) stops a turn now. Removed the dead
  connection-token run-ownership seam left over from the old disconnect-cancel. (#104)

- `apps/app`: one font everywhere — **Inter** is now the single typeface across UI
  chrome, the editor, rendered markdown, conversation turns, and headings.
  Headings/emphasis differ by size + weight only. Dropped the Noto Serif prose
  face and the Cormorant Garamond display face (and their font downloads); the
  `--font-heading`/`--font-prose` tokens are gone. (`apps/www` keeps a Fraunces
  landing hero as an isolated marketing exception.)

- `apps/app`: toolbar list buttons work again — bullet/ordered list commands now
  target the renamed `list_item` node instead of throwing "no node type named
  'listItem'". Guarded by an editor command test.

- `apps/app`: pasting a GFM markdown table now inserts a real table instead of
  plain-text paragraphs. Plain prose paste is untouched (conservative
  header+delimiter detection only).

- `apps/app`: fenced code blocks now render on a distinct warm code surface with
  syntax highlighting, replacing the near-white unstyled box. Syntax colors are
  design tokens (no vendor highlight.js theme).

- `apps/app`: TipTap document schema now includes GFM table nodes, `strike`, and
  task-list `list_item.checked` state, with schema-parity coverage for table roles.

- `packages/markup`: markdown codecs now recognize the v3 `strike` mark and
  mdast GFM table/task-list shapes as codec inputs.

- `packages/prosemirror-schema`: schema version 4 adds GFM table nodes, a
  `strike` mark, and task-list state on `list_item` for markdown/Yjs
  round-tripping.
- Chat editing: find/replace now tolerates the `hash|` block prefixes that `read`
  emits. The model can paste `read` output straight into a `find` without it
  failing and triggering a "run read to re-sync" loop. The raw document is still
  matched literally, so genuine `|` content (tables, etc.) is unaffected.

- Chat editing: a block hash shown by `read` is now always resolvable. Displayed
  hashes extend just enough to stay a unique prefix of their block, so referencing
  a hash the model saw no longer silently fails when another block shares a short
  prefix. Lookups also accept any unique-length prefix, so a hash stays usable
  even as sibling blocks come and go.

- Chat editing: referencing an ambiguous block hash now reports it as ambiguous
  (not a misleading "not found"), and a `read` on an ambiguous hash shows every
  matching block with its full disambiguating hash so the model can re-target.

- Chat editing: when a concurrent edit lands mid-turn, the agent is now re-shown
  the changed block bodies with their current hashes after its write commits,
  instead of just a list of changed hashes — so it can keep editing against
  current content without a full re-read. Concurrent deletions are now surfaced too.

- Chat editing: a destructive whole-scope `replace`/delete addressed only by a
  scope (hash, index, range, or section) with no `find` is now refused with a
  "re-read and retry" prompt when the document changed since the agent's last
  read — so a stale address can't silently destroy a moved/reclaimed target.
  Content-confirmed (`find`-based) edits and all non-destructive ops still
  auto-resync silently.

- Chat editing: a destructive `replace`/delete targeting a hex-shaped `#hash`
  fragment no longer silently falls back to a same-named heading section when the
  hash is stale/missing — it returns not-found instead of editing the wrong
  section. Reads still resolve `file#hash` to a section by slug.

- Chat editing: `create` (and `create overwrite`) now checks existence and
  computes its overwrite from the canonical + staged view, not a stale replica —
  so an overwrite fully replaces canonical content, a duplicate create in the same
  turn is rejected, and a non-overwrite create no longer leaves stale phantom
  blocks attached to the session.

- Chat: assistant turns with many edits no longer stall the UI. An unstable
  checkpoint callback was defeating memoization and causing a render storm.

- Collab: undo/redo after retention compaction no longer corrupts the document.
  Reconstruction now reads from the compacted checkpoint instead of the original
  baseline, so undoing a still-retained write stops resurrecting edits that
  compaction folded away. Compaction now folds only a contiguous update prefix.

- Collab: pending undo/redo notifications coalesce deterministically (latest wins)
  even when several land in the same millisecond.

- Collab: live undo/redo planning now ignores draft-scoped agent-edit rows, so
  draft proposals cannot appear as reversible live writes before acceptance.

- Collab: grouped undo/redo notifications now carry each write handle's original turn id
  instead of collapsing mixed-turn groups onto the seed turn.

- Collab: grouped redo boundaries are now treated as atomic undo units; selecting one write from a grouped redo expands to every write in that redo so document content and reversal metadata stay in sync.

- Collab: undoing "the latest turn" now reverses every group that turn touched,
  even when a grouped reversal pulled in writes from an earlier turn. The scope
  loop pins to the selected turn instead of the representative reported turn, so
  it no longer stops early and leaves part of the turn reversed.

- Chat editing: after a writer undoes the agent's edits, the agent's next edit
  no longer fails with "run read to re-sync." The agent's document replica
  re-syncs automatically from canonical, so the model never spends a tool call
  re-reading just to keep editing.

- Chat editing: the message telling the model which edits a writer reversed now
  lists the specific reversed write ids per file, so the model can tell exactly
  what changed without re-reading.

- Collab: undo/redo now uses persisted reversal lineage instead of delete-set ownership guessing, so concurrent edits in other blocks or non-overlapping ranges survive repeated undo/redo cycles without corruption.

- Collab: reversal rows now persist the redo re-apply update seq so the next undo/redo lineage pass can stop guessing redo ownership. No planner behavior changes in this slice.

- Chat: assistant turns that edited documents now show a "N documents changed" footer.
  Expand it to see each document, click a document name to open it in the editor, and
  undo/redo per document or all at once. Already-undone or expired edits show the
  right state.
- Chat editing: when a writer undoes the agent's edits and then sends another
  message, the model is told which edits were reversed (net undo/redo state,
  injected once on the next turn) so it stops redoing unwanted work.

- Chat editing: turn-scoped undo/redo can now reverse every document a turn touched.
  The reverse API accepts `scope: "turn"` without `uri`, resolves affected
  documents from the agent-edit journal, and returns a shared per-document
  `TurnReversalOutcome` contract.

- Billing: stripped to a thin Stripe gateway + FIFO usage ledger. No "credits"
  anywhere — users see dollars (extra-usage balance, per-message cost) and a
  monthly-usage percentage; grant amounts stay server-side. Free tier is a $0/mo
  plan granting $2/mo of usage; paid plans are Standard $10 and Premium $25.
  Extra usage is a free-form top-up requiring no subscription — pick any amount
  from $5 to $500 (quick-pick chips + custom input, default $10). Deleted the
  custom payment-provider/subscription machinery and the `user_subscriptions`
  table; added `users.stripe_customer_id`. Model calls now meter at provider cost
  ×1.15. Checkout is unavailable in dev until Stripe test keys are set; free tier
  and consumption work regardless. The recent-activity feed shows friendly labels
  ("Monthly usage", "Extra usage") instead of leaking raw Stripe ids, and the
  usage meter reads as a remaining-percentage gauge.

- Preferences: projects store AI write mode (`direct`/`draft`) for future reviewable AI drafts.

- `packages/agent-edit`: the resolver→apply write core is now CRDT-neutral — it
  works on opaque `BlockRef`/`DocHandle` handles with all Yjs (and Tier-2
  ProseMirror construction) behind the model adapter, so the editing protocol no
  longer hard-codes the Yjs document model. No change to how edits, undo/redo, or
  echoes behave.
- `packages/agent-edit`: the agent `write` command schema is one Zod source. The
  `view` command is renamed to **`read`**; the model-facing tool schema is
  generated from the same schema; and validation is now strict — unknown or
  command-irrelevant fields are rejected instead of silently stripped.

- `packages/markup`: new `@meridian/markup` package — the codec (text ↔
  ProseMirror, markdown + MDX) extracted out of `@meridian/agent-edit` into a
  standalone leaf package with a composable builder/plugin API
  (`createMarkupCodec().use(mdx()).build()`) and `markdownCodec`/`mdxCodec`
  presets. MDX is the canonical format; MDX components are closure-captured by
  the `mdx()` plugin rather than threaded through context. `@meridian/agent-edit`
  now wraps it with a thin `AgentEditCodec` for hash-prefixed echo serialization,
  and the editor (`apps/app`) and collab server (`apps/server`) consume the codec
  directly. No behavior change — pure extraction.

- `packages/agent-edit`: simplified write echo to one per-block `v_pre` →
  `v_post` content-diff path with word-based context truncation, removed
  commit-time echo recomputation, and made undo/redo return the same structured
  metadata+echo blocks as writes.

- Dev tooling: added `pnpm dev:prune-worktrees` to safely clean merged worktrees, linked Meridian work items, dev processes/routes, and per-worktree databases with dry-run planning.

- Collab/DB integrity pass (branch `db-collab-integrity-fixes`):
  - `packages/agent-edit`: removed the durable sync-state cache before release;
    runtime sync state is memory-only, and restarts rebuild from live documents /
    the journal instead of trusting a persisted fast-start baseline.
  - `apps/server` collab: server journal `read()` guards against stale persisted
    schema versions — heads stamp the running `COLLAB_SCHEMA_VERSION` on upsert and
    `read()` throws `StaleDocumentSchemaError` instead of replaying CRDT bytes built
    for an older ProseMirror schema. Rebuild-from-markdown recovery stays a follow-up.
  - `@meridian/database`: added the `document_yjs_heads.latest_checkpoint_id` →
    `document_yjs_checkpoints.id` foreign key (`ON DELETE SET NULL`), replacing a
    comment that falsely claimed the FK already existed in custom SQL
    (migration `0006`).
  - Dev tooling: `migration-lint` now exempts the real `0000_` baseline (not
    `0001_`), cutting baseline noise from 125 warnings to 12 real follow-up
    warnings. It also gains `--strict` (warnings fail) and `--changed <ref>`
    (lint only migrations changed since a ref); a CI `migration-checks` job runs
    `drizzle-kit check` (always blocking) and scoped migration-lint on PRs
    (`--strict` only when merging to `main`/`staging`), and pre-commit lints
    staged migration SQL.
  - `apps/server` collab: head `schema_version` advances monotonically on upsert,
    so a downgraded server cannot stamp it backward and erase the stale-schema fence.
- Dev tooling: repo-pinned pnpm moves to 10.34.3 so Corepack pnpm
  commands no longer emit Node DEP0169 from pnpm's bundled package-arg
  resolver.
- Editor: document load no longer builds a throwaway TipTap editor before the
  real collaboration session is available.

- Chat editing: a writer can now reverse the agent's edits themselves, not just
  the agent. New authenticated endpoint reverses (undo/redo) at three
  granularities — a single write (`w<N>`), a whole turn, or the entire thread —
  and the reversal is attributed to the user. Reversing a turn/thread that was
  undone in several steps now restores the whole scope in one call instead of
  silently leaving part reversed.

- Collab: agent/user undo now correctly marks the edit reversed in Postgres.
  Previously the Drizzle journal matched reversal by the wrong key, so in
  production an undone write stayed flagged active and undo availability drifted;
  the document content reverted but the bookkeeping lied. A cross-adapter
  conformance contract now pins in-memory and Postgres to the same behavior.

- Dev (`pnpm dev`): Tailscale sharing works across multiple worktrees at once.
  `tools/dev` now owns the Tailscale-serve → app mapping on deterministic
  per-worktree ports, so each worktree's app/www gets its own stable
  `https://<node>.ts.net:<port>` instead of two worktrees fighting over `:443`
  and serving a proxy 404.

- Server DB: completed the Drizzle thread repository contract for usage/cost
  rollups. Threads now persist `total_cost_usd`; turns persist response count,
  latest model/provider, reasoning/cache tokens, request/response metadata; model
  responses persist reasoning/cache tokens; block rows persist provider metadata.
  Drizzle now maps the same thread/turn/model-response semantics as the
  in-memory conformance adapter, including decimal zero normalization.

- `packages/agent-edit`: undo/redo now runs on a single cold reconstruction path;
  the live `Y.UndoManager` ("hot") path is deleted. Behavior is unchanged for
  callers — agent undo still reverts only the agent's edits and preserves
  overlapping human edits. Public API drops `WriteTool.registry` and the
  `undoRegistry` option; adds an optional `createRuntimeDoc` so the host controls
  forward-write doc creation.

- Collab: a Yjs clientID band `[0,999]` is reserved for server-authored reversal.
  The browser editor and server docs draw their clientID outside the band, and
  inbound collaboration updates carrying a band clientID are rejected at ingest —
  so agent reversal authoring can never collide with a real collaborator's edit
  stream.

- Chat editing: the agent now edits documents through one `write(command=...)`
  tool (create / view / insert / replace / undo / redo) backed by
  `@meridian/agent-edit`. Edits land as real Yjs collaborator operations —
  character-level, position-anchored — so multiple people and the agent can edit
  the same document live, and undo/redo is native (never silently no-ops). The
  old `read`/`edit`/full-replace `write` tools are gone.

- `packages/agent-edit`: `write()` returns a structured `WriteOutcome`
  (`command`, `status`, `isError`, `text`); hosts read the envelope instead of
  parsing status out of the text. Package is host-agnostic: it requires an
  injected ProseMirror schema and carries no Meridian dependency
  (`@meridian/prosemirror-schema` is devDependency-only). Public API trimmed to
  the supported surface. Yjs+ProseMirror is the v1 content model; a swappable
  non-ProseMirror content model is deferred (GH #70).

- Server collab: full-document markdown engine extracted out of `composition.ts`
  into a focused module; `CollabDomain` split into narrow ports
  (`AgentEditAccess`, `MarkdownDocumentStore`, `DocumentProjectionRefresher`,
  `DocumentCheckpoints`, `DocumentAttribution`, `CollabTransport`).

- Runtime gateway: cancelled-call settlement moved behind a provider-neutral
  `Gateway.settleCancelledResult` hook; the orchestrator/loop no longer reference
  any model provider by name, so a new provider needs only a gateway adapter.

- Dev (`pnpm dev`): the per-worktree `DATABASE_URL` rewrite is injected directly
  into the tmux pane instead of trusting the launching shell's direnv state — a
  stale direnv cache no longer boots the server against the wrong database. The
  resolved DB name is logged at launch.

- Dev (`pnpm dev`): fail fast when the live database has drifted from the repo's
  migration baseline (compares applied vs expected migration hashes) instead of
  failing later, deep in feature code, on the first schema mismatch.

- `packages/agent-edit`: scaffold `@meridian/agent-edit` with port interfaces
  (`UpdateJournal`, `DocumentCoordinator`, `ActorSessionStore`, `Codec`,
  `DocumentModel`, `ComponentSpec`) — types only, no implementations yet.

- Dev tooling: clarified migration drift remediation (migrate/apply-functions
  for simple catch-up, reset for divergence), removed duplicate env/git helpers,
  and added `pnpm dev:gc-dbs` for stale worktree DB cleanup.

- Test suite pruning: deleted low-value contract/helper tests, in-memory
  conformance wrappers, skipped DB conformance wrappers, and duplicate golden
  coverage; collapsed broad runtime, gateway, MDX, turn-reducer, and WS suites
  to representative boundary cases.

- Brand mark: compass needle on a cream-jade disc with hairline ring (disc-cream-ring);
  replaces the bare needle and cinnabar seal-square favicon. Proto route at
  `/proto/logo-mark` for comparing discarded framing options.

- Docs: consolidated local setup in `DEVELOPMENT.md`; slimmed
  `tools/dev/.context/CONTEXT.md` to module contracts only; `AGENTS.md` points
  to `DEVELOPMENT.md` for setup and `tools/dev/AGENTS.md` when editing dev tools.

- Dev (`pnpm bootstrap`): run `direnv allow` automatically when direnv is
  installed so linked worktrees trust `.envrc` without a manual step first.

- Dev (worktree DB isolation): linked git worktrees rewrite `DATABASE_URL` to
  sibling databases on the local Postgres server (`meridian_<slug>`); the main
  checkout keeps bare `meridian`. `applyDevEnvToProcess`, `.envrc`, and
  `bootstrap` apply the rewrite so migrations and `db:reset` are worktree-scoped.

- Docs (app comments): retarget stale Warm Paper file-header comments in
  `globals.css` and `desktop-layout.ts` to Ink & Jade / Quiet Pro wording.

- Docs (Ink & Jade knowledge capture): updated DESIGN.md, design-tokens/app/root
  `.context`, and app AGENTS.md after the ink-jade-skin merge — Quiet Pro surfaces,
  ThreadCachePort decoupling, settings overlay, and unified authenticated providers.

- Frontend cleanup: dropped the placeholder Import workspace screen — removed
  `?screen=import` from nav (`SCREENS`), desktop `ImportPaneController`, phone
  import pane, `CorpusImportPanel`, and the unused corpus-upload client API.
  Server import endpoints stay for a future entry point.

- Docs (DB knowledge layer): promoted the DB schema map from the docs-repo work
  dir into the qi-layer as a durable, regenerate-on-demand artifact —
  `packages/database/.context/schema-map.md` (orientation text) +
  `schema-map/index.html` (interactive ER view). Converted all source links to
  paths relative to the `.context/` home, added staleness metadata (map
  regenerated 2026-06-18 vs. DB layer last changed 2026-06-16 `d864bab9`, derived
  from `git log -1 -- packages/database/src`), and wired both into
  `.context/CONTEXT.md` with the regenerate-on-demand convention.

- Test hardening (`tools/dev/dev-db.test.ts`): the `describe.skipIf(!DATABASE_URL)`
  integration block parsed `new URL(adminUrl)` at collection time, so a missing
  `DATABASE_URL` crashed the whole suite (`TypeError: Invalid URL`) instead of
  skipping. Build the throwaway URL lazily inside the test so the skip is actually
  protective.
- Docs (DB knowledge layer): added `packages/database/.context/CONTEXT.md`
  (qi-layer expected it; only `AGENTS.md` + `README.md` existed). Records the
  timestamp `mode` policy (default `Date` via `_shared.ts`; only `mode:"string"`
  exceptions are `users.{created_at,updated_at}` and `thread_works.created_at`),
  the "never bind a JS `Date` into a raw `sql` fragment" invariant with the
  canonical typed-comparator and `::timestamptz` round-trip patterns, the
  migration workflow, and a pointer to the `apps/server` transaction model.
- Docs (DB knowledge layer): corrected stale wording — `packages/database/AGENTS.md`
  said migrations were "squashed to single baseline" but the journal now has a
  baseline plus additive migrations (`0000_careless_rockslide` + `0001_tidy_siren`);
  and `domains/billing/.context/CONTEXT.md` pointed at a `lib/` shared module for
  the transaction helper whose real path is
  `apps/server/server/shared/drizzle-transaction.ts`.
- Frontend cleanup (R1, step 2): relocated `rename()` out of the thread store.
  Thread rename was a pure query-cache mutation with no store state living on
  `ThreadStoreActions`. Moved it to a `useRenameThread` hook beside
  `useProjectThreads` (`client/query/useRenameThread.ts`); `ChatThreadHeader`'s
  inline rename uses the hook. Dropped `rename` from the store action surface,
  the `selectThreadActions` selector, the `ThreadStoreActions` type, and the
  controller-test action mock. No behavior change.
- Frontend cleanup (R1, step 1): decoupled the thread store from React Query.
  Introduced a thin `ThreadCachePort` (`client/stores/thread-store/thread-cache.ts`)
  with `upsertThread` / `patchThread` / `invalidateThread`, backed by the existing
  `project-thread-cache` helpers. `createThreadStore` now takes a `threadCache`
  port instead of a raw `QueryClient`, so the store no longer mutates the query
  cache directly — the dual ownership behind the recurring `useThreadStore`/
  `QueryClient` fragility. The terminal-turn `queueMicrotask` invalidation moved
  into the port (render-safe deferral, documented there). No behavior change.
- Frontend cleanup (F6): minor settings/composer tidies. `SettingsDialog` now
  drives both the desktop rail and both presentations' section bodies from a
  single `SECTION_CONTENT` map keyed by `SETTINGS_SECTIONS` (killed the
  duplicated `profile|preferences|usage` triplets). Removed the never-set
  `dividerBefore` field from `PhoneSettings`. Removed the no-op attach paperclip
  from `Composer` (it was a visual placeholder with no upload wired) and updated
  its now-stale doc comments. Added a comment at `_authenticated.tsx`'s
  `<Outlet key={pathname}>` explaining the intentional per-route remount.
- Frontend cleanup (F5): removed the double viewport lock on `/billing`.
  `_authenticated.tsx` already owns the `app-frame` (`h-svh`/`overflow-hidden`)
  and the Outlet wrapper, so `BillingPage` re-locking with its own inner
  `app-frame` nested two `h-svh overflow-hidden` shells. The page now renders as
  a single `app-scroll` region (matching `HomeView`/`HomeScreen`), one scroll
  owner inside the layout-provided frame.
- Frontend cleanup (F4): unified the duplicated credit-balance UI behind a new
  `CreditBalanceCard` (`features/billing/`) with `compact`|`full` variants. The
  settings Usage section composes the `compact` box and `/billing` composes the
  `full` hero card with the usage bar; both share the one `useBillingBalance()`
  query + `creditsFromMillicredits` formatter instead of re-deriving the balance
  markup in two places. No visual change.
- Frontend cleanup (F3): collapsed the ~120-LOC near-duplicate between
  `LeftSidebar` (desktop rail) and `NavigationDrawer` (phone Sheet) into a shared
  `WorkspaceNavBody` + `ScreenNavItem` in `features/project/shell/`. Both
  sidebars are now chrome-only wrappers (collapse control / Sheet + wordmark);
  the body owns the screen nav, Chats controls, thread list, and account row. A
  `presentation` prop carries the desktop↔phone touch/spacing differences, and
  "close the drawer on select" stays a wrapper concern via wrapped callbacks —
  mirroring the SettingsDialog/PhoneSettings split. Behavior unchanged.
- Design tokens (S7): the remaining jade gradient/shadow lifts in `ink-jade.css`
  now derive from the existing OKLCH tokens — `--background-image-gradient-mark`
  references `var(--color-mark-from|-to)`, and `--shadow-button` uses
  `color-mix(in oklab, var(--color-mark-from) …%, transparent)` instead of
  re-encoding jade as raw hex/rgba. Jade is defined once (the OKLCH ladder).
  Verified the tokens still compile under Tailwind v4 with all `var()` references
  emitted. (`--color-cream*` left as-is.)
- Dev tooling (S7): `assertDevInfraReady` (`tools/dev/lib/dev-infra.ts`) now
  throws a typed `DevInfraNotReadyError` instead of calling `process.exit`,
  matching the throw-style of every `dev-db.ts` function and keeping the
  "reusable by CI/bootstrap" claim honest. The `dev-tmux.ts` entry point's
  existing `main().catch` prints the message and exits.
- Server hardening (S4): the observability error serializer
  (`unknownToEventPayload`) now copies Postgres driver diagnostics
  (`code`, `severity`, `detail`, `hint`, `constraint`, `column`, `table`, and a
  truncated `query`) under a `postgres` key when the error is postgres-js-shaped,
  so a driver/binding failure no longer surfaces as an opaque "Failed query".
  Defensive — reads fields by name and never throws.
- Server hardening (S6): made `@meridian/contracts/protocol` the canonical
  billing wire types — the credit-ledger domain port now aliases
  `CreditTransactionSummary`/`CreditBalanceBreakdown` to `BillingTransaction`/
  `BillingBalanceResponse` instead of re-declaring field-for-field duplicates, so
  the domain return shape and the HTTP response can't silently drift. Also fixed
  the stale checkout fallback URL (`/settings/billing` → `/billing`) in
  `billing-route.ts` and aligned its test.
- Server hardening (S3): collapsed the 5-way nested ternary that chose the
  credit-lot `onConflictDoNothing` target/where (with the insert boilerplate
  repeated per arm) into one `resolveLotConflictGuard(src, input)` dispatcher and
  a single insert site. Same conflict targets/predicates, no behavior change.
- Server hardening (S5): replaced the residual raw
  ``sql`${stripeSubscriptionId} <> ${id}``` comparators in the Drizzle
  subscription store with the typed `ne(...)` operator, so the store uses one
  canonical comparator style (matching the `gt`/`lt`/`lte`/`eq` Date fix).
- Server hardening (S1): wrapped the Drizzle subscription `upsert` (probe →
  newer-sibling guard → cancel-superseded UPDATE → insert/update) in
  `runInDrizzleTransaction`, matching `credit-ledger.grant`. A crash mid-flow can
  no longer leave a user's prior subscriptions cancelled with no replacement row;
  the multi-statement upsert now commits atomically. No behavior change on the
  happy path; billing route tests still pass.
- Server hardening (S2): lifted the subscription monotonic-replacement rule into
  one pure domain module (`billing/domain/subscription-policy.ts`:
  `isMonotonicReplacement` + `classifyActiveSibling` + `ACTIVE_SUBSCRIPTION_STATUSES`),
  killing two of the three drifting copies. The drizzle store keeps only its thin
  SQL projection (`monotonicUpdateWhere`) and the in-memory store now calls the
  shared predicates instead of re-implementing the loop — so a divergent (and
  previously Date-unsafe) SQL path can't re-enter through an adapter. No behavior
  change; billing route + in-memory ledger tests still pass.
- Frontend cleanup (F2): removed the throwaway `/proto/palette` explorer — its
  route (`routes/proto.palette.tsx`), its `features/proto/palette/**` feature
  (~736 LOC), and the proto-index link card. The chosen palette already lives
  in `packages/design-tokens/src/ink-jade.css`, so the live-override explorer is
  disposable. Route tree regenerated via the tanstackStart generator. The other
  `/proto/*` experiments (persistent-surfaces, spike-layout) are untouched.
- Frontend cleanup (F1): deleted the dead `AppShell` desktop-shell island
  (`components/app/AppShell.tsx`, `AppSidebar.tsx`, `ProjectListSection.tsx`,
  `ProjectRow.tsx`, `SidebarUndoPill.tsx`), its sole consumer the shadcn
  `components/ui/sidebar.tsx` primitive, and the now-orphaned
  `hooks/use-mobile.ts` (`useIsMobile`, used only by `ui/sidebar`). ~1,172 LOC,
  zero behavior change — the live desktop shell is `features/project/shell/`
  and the live viewport hook is `use-phone-shell`.
- Fix authenticated tailnet cold loads/reloads: SSR API seeding now uses the
  same-origin app `/api` proxy for `.ts.net` app hosts instead of falling back to
  the bare local server origin, which made browser-authenticated reloads render
  TanStack's `Request failed: 503` error page while client-side `/api` calls
  succeeded.
- Fix billing checkout 500 (`POST /api/billing/checkout-sessions`): the Drizzle
  subscription upsert compared `currentPeriodStart` via raw ``sql`… > ${date}```
  fragments, which bind the JS `Date` straight to postgres-js and throw
  `TypeError [ERR_INVALID_ARG_TYPE]` (the server logger surfaced it only as an
  opaque "Failed query"). Switched those comparisons to Drizzle's typed
  `gt`/`lt`/`lte`/`eq` operators so the timestamp column encodes the `Date` to an
  ISO string. Pre-existing bug, newly reachable now that `/billing` exposes
  Checkout. (`apps/server` subscription-store.)
- Settings overlay + unified provider tree (voluma-derived): collapsed
  `_authenticated.tsx` to ONE unconditional provider tree (AppQuery → project →
  thread → transport → copilot) for every authenticated route, deleting the
  pathname-based `usesWorkspaceProviders` light branch. That branch dropped
  `ThreadStoreProvider` on light↔workspace navigations (e.g. billing → project),
  throwing `useThreadStore must be used within ThreadStoreProvider`; the single
  tree makes that crash structurally impossible. Settings is now a URL-driven
  overlay (`?settings=<section>`, layout-owned `validateSearch`) with Profile /
  Preferences / Usage sections — the stub `SettingsDialog`/`PhoneSettings` are
  now real, the account menu + ⌘, open it, and the Usage section shows the
  credit balance with a link to purchase. Billing purchase moved from
  `/settings/billing` to a standalone `/billing` route (links + checkout return
  URLs updated). Removed the redundant sidebar credit-balance badge (deleted
  `CreditBalanceBadge`) — the balance now lives in the Usage section.
- Dev infra preflight: `pnpm dev` now fails fast when `DATABASE_URL` is unset or
  the dev Postgres is unreachable, instead of booting the app servers (whose DB
  connections are lazy) and only surfacing the failure as a runtime `HTTPError`
  on the first DB-touching request. Restores the database-readiness gate that
  was dropped when `dev-tmux.ts` was forked from voluma, reusing the existing
  `formatPgError` hints (`pnpm dev:infra` / credentials / `pnpm bootstrap`). Adds
  a read-only `pingDatabaseForUrl` probe and a shared `assertDevInfraReady`
  (in `tools/dev/lib/dev-infra.ts`) so the same gate can back CI/bootstrap. The
  check is read-only — it never starts the container or creates databases.

## Ink & Jade re-skin (2026-06-17, branch h/ink-jade-skin)

- Grounds + chrome (Quiet Pro): replaced the cream "Warm Manuscript" surface
  ladder with the cooler, low-chroma warm-grey "Quiet Pro" ladder (hue ~100,
  chroma ≤0.005) so nothing reads as parchment. Bright surfaces (cards, message
  bubbles, composer/search fields via `surface-warm`) now lift ABOVE the canvas
  while the rails/dock recede below it, divided by hairline borders — flush, not
  floating (dropped the rounded rail corners + rail shadows).
- Cinnabar pulled back to a scarce seal: routine selection is now neutral — the
  active sidebar row uses a warm-grey fill + a jade "you are here" marker (not a
  cinnabar tint/stripe) and the "Pinned" header is muted. Cinnabar is reserved
  for the brand mark, the pin/favorite star, and destructive deletions only;
  red was reading as "error". (Supersedes the earlier cinnabar-on-active-row.)
- Texture: added a barely-there fixed paper-grain overlay (`paper-grain` utility
  on `<body>`, ~0.02 opacity, pointer-events none) for the rice-paper tooth; the
  manuscript editor is raised above it so long-form prose stays pristine.
- Login: rebuilt the placeholder page as a branded split — a deep-ink hero with
  the glowing needle, Cormorant wordmark, italic tagline, faint jade ink-wash,
  and a corner cinnabar seal, beside a paper card with a jade primary call to
  action. Drives the existing flows only (WorkOS hosted sign-in and dev login);
  no new auth plumbing.
- Brand mark: replaced the off-brand gradient hexagon with the compass needle
  (cinnabar north / jade south, token-driven fills) and added an SVG favicon
  using the seal-square needle housing.
- Chrome accents: the active sidebar row now carries the cinnabar seal (faint
  cinnabar tint, cinnabar text, and a short rounded cinnabar marker instead of a
  full side-stripe), and the thread pin/favorite star plus its "Pinned" header
  read cinnabar. The composer send button picks up jade automatically from the
  primary token.
- Typography: load Cormorant Garamond (display), Noto Serif (prose), and Inter
  (UI chrome) via Google Fonts in both app and www roots; added a `--font-prose`
  token and repointed `--font-heading`/`--font-sans`. Applied the prose serif and
  a calm ~68ch measure with generous leading to the manuscript editor and the
  conversation/markdown surfaces; headings use the Cormorant display serif.
- Renamed the shared token file `warm-paper.css` to `ink-jade.css` and swapped
  the palette to the Ink & Jade direction: warm rice-paper grounds, near-black
  ink type, jade primary, and a new cinnabar seal accent (chrome only). Added
  `jade-text`, `cinnabar`, `cinnabar-tint`, `ink-deep`, `cream`/`cream-muted`
  tokens; shifted `destructive` to a cooler crimson so error never reads as
  favorite. Updated the app/www imports, the package export, the renamed
  `UserPreferences.ui.theme` enum value, and the manifest theme color.

## Editor cursor colors and cleanup (2026-06-19, branch h/mdx-manuscript)

- Fixed CollaborationCaret "unsupported color format" warning: replaced
  `var(--color-primary)` with concrete hex colors for cursor rendering.
- Cursor colors are now assigned by join order from a rotating 8-color palette
  (Google Docs style): each client picks the first palette color not already
  claimed by another connected user via awareness state.
- Deleted dead barrels, the skeleton agents domain export, stale project-shell
  components, the legacy agent route, and unused re-exports.

## MDX manuscript format — schema narrowing (2026-06-18, branch h/mdx-manuscript)

- Narrowed shared ProseMirror schema for markdown-representable subset: `image`
  forbids marks, table cells drop colspan/rowspan/colwidth, added `horizontal_rule`
  scene-break node. Bumped `COLLAB_SCHEMA_VERSION` to 2. TipTap editor parity preserved.
- MDX ingress: skip tilde-fenced code blocks in prose-escape pre-pass; reject
  boolean/shorthand `<Figure>` attrs (quoted strings only).
- MDX ingress: CommonMark-complete inline code span handling (N-backtick open/close)
  so `<`/`{` inside multi-backtick code is not backslash-corrupted; document
  Phase-1 limits for indented code and angle-bracket autolinks.

## Hocuspocus collab transport (2026-06-18, branch h/hocuspocus)

- Replaced the custom Yjs WebSocket transport with Hocuspocus v4 end-to-end:
  the server now owns every live `Y.Doc` (single owner), and the client uses a
  `HocuspocusProvider` bound to the existing editor session. Same editor
  experience, but with built-in heartbeat, reconnect, and per-document auth —
  the attributed update log is preserved (overload-dropped updates are not).
- Deleted the legacy transport stack: custom WS handler, `yjs-multiplex` wire
  protocol + message constants, the old client transport, the
  `DocumentSyncTransport` port, and the dead agent route.

- Fixed document session status when access is denied before first server sync:
  terminal/unauthorized transport states now pre-empt the initial-sync gate so
  the pill shows access-lost instead of stuck syncing.
- Tightened Hocuspocus terminal-denial classification to explicit 4401/4403 close
  codes and `onAuthenticationFailed` (per-doc denial), dropping loose reason
  substring heuristics that could misclassify transient closes.
- Added regression tests for denial-before-sync status, transport terminal
  classification, and registry union-of-openers retention lifecycle.
- Deferred document session teardown with a grace window so React strict-mode
  release→retain churn does not detach Hocuspocus providers on the shared socket.
- Versioned client IndexedDB persistence keys by `COLLAB_SCHEMA_VERSION` so schema
  bumps invalidate stale local Yjs caches and force server resync; best-effort GC
  deletes older per-document IndexedDB entries.
- Added a soft live-document session cap warning in `DocumentSessionRegistry`
  (no hard eviction).
- Added shared `COLLAB_SCHEMA_VERSION` in `@meridian/prosemirror-schema` and
  `schema_version` on `document_yjs_heads`; server journal writes stamp the current
  version on head upsert and `read()` throws `StaleDocumentSchemaError` when a
  stored head is older than the running schema (loud guard, not silent replay).
  Rebuild-from-markdown stale-schema recovery remains a planned follow-up.
- Extended collab persistence metrics with live document and open connection counts;
  shutdown drain emits the augmented payload.
- Fixed `storeDocument` checkpoint writes clobbering `latestUpdateSeq` via targeted
  `setLatestCheckpointId` updates on the document store port.
- Made Hocuspocus shutdown drain a quiescence loop so async close work cannot leave
  persistence queues or in-flight stores behind.

## Dev portless app stability (2026-06-17, branch h/v3)

- Fixed app dev websocket proxy startup when `MERIDIAN_API_ORIGIN` is present
  but blank in `.env`; the app now falls back to the portless server origin
  instead of crashing Vite on `/api/threads/ws`.

## TipTap v3 editor upgrade (2026-06-17, branch h/tiptap-v3-upgrade)

- Upgraded the shared TipTap editor stack to v3, including the collaboration
  extension rename to CollaborationCaret and the StarterKit undoRedo option.
- Kept the custom Meridian schema as the editor/server contract: removed the
  standalone Mathematics extension because v3 adds blockMath/inlineMath nodes
  that are not in the shared markdown-safe schema.

## Server architecture alignment (2026-06-17, branch h/v3)

- Ported Voluma-hardened server observability foundations: interrupt HTTP error handler registration, process-scoped deferred EventSink, request observability, safe-event redaction, and local stdout + optional JSONL event output.
- Split production server assembly so `app.ts` binds process resources while `compose.ts` owns adapter-port construction and runtime service wiring.

## Local Supabase removed + migration squash (2026-06-16, branch h/v3)
- Local Supabase CLI and `supabase/` directory removed. Dev Postgres is now a
  plain `postgres:16` Docker container (`pnpm dev:infra`, compose project
  `meridian-dev`, host port `54422`). No `supabase:*` npm scripts remain.
- All 13 migrations `0001`–`0013` collapsed into ONE baseline
  `0000_careless_rockslide.sql`. No migration references `auth.users`.
  `pnpm db:generate` works again (snapshot debt resolved).

## Fixes (2026-06-16, branch h/v3)

- "New chat" works from the default composer again. The client-only `general`
  default agent slug is no longer sent on thread create (it has no server agent),
  so the request no longer 400s with `Agent not found: general`.

## WorkOS auth (2026-06-16, branch h/v3)

- Authentication is now WorkOS AuthKit, not Supabase GoTrue/JWKS. Sessions are a
  sealed `wos-session` cookie; the API server and collab WebSocket authenticate
  from that cookie. No bearer JWT, no JWKS.
- Identity is app-owned: a `public.users` row keyed by the WorkOS user id,
  provisioned on first sign-in. The Supabase-managed `auth.users` table and its
  foreign keys are gone (squashed into single baseline).
- Dev sign-in is a real WorkOS password auth (`/api/auth/dev-login`), gated to
  non-production with dev creds present (`WORKOS_DEV_AUTOLOGIN=1`). `pnpm
  bootstrap` applies schema only (no user/project seed); identity provisioned on
  first sign-in, personal project auto-created on first login.
- `@supabase/supabase-js` is removed from both apps.
- `pnpm dev` now defaults to `--tailscale` sharing; opt out with
  `pnpm dev --no-tailscale` (or `pnpm dev:local`).

## Onboarding wizard removed (2026-06-16, branch h/v3)

- Onboarding wizard (`/onboarding` route + domain + `user_preferences.onboarding_state` column) deleted and replaced with voluma-style auto-creation: on first authenticated request `provisionAuthenticatedUser` → `ensureDefaultBootstrap` provisions the personal project, guard-railed by a cheap existence check. `GET /api/projects/home` resolves the landing project; `/` redirects to `/projects/$id/agent`. `/home` now renders the HomeView composer for creating additional projects.
- `user_preferences.onboarding_state` column dropped.
- Existing changelog claim "project created via onboarding" corrected to "personal project auto-created on first login".

## context-URI + model-gateway cleanse (2026-06-16, branch h/v3)

- Context addressing unified behind one port and one scheme vocabulary.
  `manuscript://` is the book and the bare-path default; `kb://` / `user://`
  durable; `work://<id>/…` and `uploads://<id>/…` work-scoped. `fs1://` and
  `work://.results` are gone.
- Threads address multiple Works (M:N `thread_works`); `threads.workId` dropped.
  Work-scoped browse requires membership.
- Move/delete are content-safe: a concurrent edit landing during a move/delete
  is rejected (revision CAS) instead of silently clobbering content.
- One model registry (config + pinned pricing). OpenRouter works again; cost
  comes from the provider when it reports one. The flat token-rate table is gone.
- Cancel is billing-correct: cancelling or disconnecting mid-turn drains partial
  usage and bills it once; a failed turn ends as an error instead of hanging on
  "streaming".
- Dev login no longer breaks when tests run: DB-backed tests use an isolated
  fixture identity, run only under `RUN_DB_TESTS` against a throwaway database,
  and can no longer truncate the dev database.

## v3 full-stack rebuild (2026-06-14, branch h/v3)

Ground-up TypeScript rebuild replacing the prior Go backend. Single squashed
commit (`de6269a0`) contains the full v3 codebase.

See `AGENTS.md` for architecture overview and `DEVELOPMENT.md` for setup.
