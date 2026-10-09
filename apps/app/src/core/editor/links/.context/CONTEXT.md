# The link system — contracts

Reference depth. Read [`AGENTS.md`](../AGENTS.md) first.

## The classification seam

```ts
export type LinkTarget =
  | { kind: "scheme"; uri: string }      // manuscript://…, scratch://…
  | { kind: "relative"; path: string }   // chapter-213.md, ../notes/kael.md
  | { kind: "external"; url: string };   // http, https, mailto

classifyLinkTarget(href: string): LinkTarget | null
normalizeLinkHref(input: string): string | null
linkTargetHref(target: LinkTarget): string
linkTargetAddress(target: LinkTarget, baseUri: string | null): string | null
```

There are no wikilinks: `[[name]]` is text wherever it appears, and only a
paste converts it ([Pasted `[[Name]]`](#pasted-name)). The two
internal kinds reach `POST /api/projects/:projectId/links/resolve` as
`{ ref, href }`, the href spelled by `linkTargetHref`. `baseUri` is the URI of the document holding the link;
only `relative` needs it and only the caller knows it. `linkTargetAddress`
resolves either kind to its canonical Context URI through `resolveDocumentHref`
(`@meridian/contracts`), the one href module both resolvers use;
`link-address.ts` also holds the filename rule (`documentFileName`) and the
address of a new document beside its holder, or at a folder path from its
area root (`linkAheadAddress`).

Two directions, one fence. `classifyLinkTarget` reads an href already in the
document — from the markdown parser, an LLM, or this module — and asks what it
is. `normalizeLinkHref` reads what a writer typed and asks what to store; the
one thing it adds is the missing `https://`, last, so a Context URI and a
relative path keep their own meaning. The difference shows on a bare
hostname: `example.com` in an href is a path (markdown never adds a scheme),
and `example.com` in the form is a website.

| href | classify | normalize |
|---|---|---|
| `manuscript://appendix/charter` | scheme | unchanged |
| `scratch://@revision-pass/notes.md` | scheme | unchanged |
| `chapter-213.md`, `../notes/kael.md` | relative | unchanged |
| `example.com` | relative | `https://example.com` |
| `/chapter.md` | relative (resolves to nothing) | null (there is no project root) |
| `https://…`, `mailto:…`, `//host/p` | external | unchanged (`//` gains `https:`) |
| `javascript:`, `data:`, `ftp://` | null | null |

`null` is the refusal. It is NOT the unresolved state: an internal target that
resolves to no document is a normal, rendered state (§5.5), while `null` means
the href is nothing the editor will act on.

## The behavior matrix

| Gesture | Target | What happens |
|---|---|---|
| Click | external | new tab (`noopener,noreferrer`) |
| Click | internal, navigator registered | in-app, same pane |
| Click | internal, no navigator | falls through: the caret lands |
| Click | unclassifiable | falls through: the caret lands |
| Alt+Click, or a press that travelled ≥ 4px | any | caret, never a follow |
| Right-click | any link | link menu at the pointer, on the range the pointer hit |
| Middle click, or Ctrl/Cmd+click | any | follow, disposition `new-tab` |
| Shift+click | any | caret, because Shift extends a selection |
| Right-click | plain prose | unclaimed: the browser's menu, and spellcheck with it |
| Hover, settled | any classified link | destination hint below the link |
| Ctrl+K | selection | form with display text and destination |
| Ctrl+K | bare caret | display text and destination, inserts a finished link |
| Ctrl+K | caret in a link | pre-filled display text and destination; explicit Remove link |
| Alt+Enter | caret in a followable link | follows |
| Enter | focused link | follows immediately |
| Context-menu key / Shift+F10 | focused link or caret in link | context menu without navigation |

Every follow cancels the browser's own navigation first, unconditionally, on
`click` and on `auxclick` alike — the middle button is the one path where a raw
href would otherwise reach the browser's own URL resolution, and an internal
spelling resolved that way lands on a page with nothing to do with the
manuscript. A follow also puts the selection back where the press found it: the
writer returns from that new tab to the sentence they left, not to the middle
of the link they pressed.

External ignores the disposition — §5.5 sends it to a new tab either way. It is
the internal family where `current` and `new-tab` are different places, and the
navigator receives it so the app can decide.

The external guard is ruling 9: none. Mockup 06 state F records the alternative.

## Surviving a write that lands underneath

`LinkAnchor` is this module's instance of the editor-wide contract in
[`../../.context/CONTEXT.md`](../../.context/CONTEXT.md): a remote change
rebuilds the whole document, so a surface that holds raw positions across a
peer edit or an AI write is pointing at nothing. `anchorLinkRange` pins a
range through Yjs relative positions, `resolveLinkAnchor` finds it again, and
the ProseMirror mapping stays the fallback where there is no shared document.

Both link surfaces hold one. The menu's is its whole target; the form's is its
draft, because a form the writer is typing in has the same exposure and two
mechanisms for one problem is how they drift.

Position is half of it. `relocateLink` re-reads the mark at the resolved
position and compares it by attributes, so a link deleted and replaced by other
text, and an href a peer changed, both close the surface rather than re-aim it.
The menu closes; the form closes; neither acts on words the writer never
pointed at.

## The resolution port

Two registrations, both the app's, both absent until it mounts
`ProjectLinkRuntime`:

```ts
type InternalLinkNavigator = (request: {
  target: LinkTarget;
  ref: string | null;                 // the mark's ref, read from the mark, never the DOM
  disposition: "current" | "new-tab";
}) => void;
getLinkSurface(editor)?.registerNavigator(navigate);      // returns an unregister

type LinkKey = { ref: string | null; href: string };
type LinkQuestion = { ref: string | null; target: LinkTarget };
type LocalLinkAnswer =
  | { kind: "answered"; answer: LinkAnswer }              // final; the server is not asked
  | { kind: "unasked" }                                   // cannot be asked here; cached as failed
  | { kind: "ask"; provisional: DocumentAnswer | null }; // shown at once while asking
type InternalLinkResolver = {
  index?: LinkAssignmentIndex | null;                     // what it answers from, and assigns against
  local?: (question: LinkQuestion) => LocalLinkAnswer;    // synchronous, at ask time
  remote: (
    questions: readonly LinkQuestion[],                   // only what `local` sent on; at most 200
  ) => Promise<readonly (LinkAnswer | null)[]>;           // request order; null = failed
};
getLinkAnswerCache(editor)?.registerResolver(resolve, { baseUri, projectId });
linkKeyOfMark(attrs): LinkKey   // the only reading of a mark's ref and href ("" ref = none)
linkCacheKey(key): string       // the only cache key
```

The navigator is where a follow goes. The resolver is where every rendered
internal link's state comes from, and the two share one cache, so a click on a
link the writer can already see resolved opens the document with no round trip.

The link store also takes `registerFollowHandlers({ dismiss, retry })`. The
follow-outcome dialog mounts through the chrome host, not beside the follower,
so its Close, Cancel, and Try again reach the follower through
`dismissFollow()` and `retryFollow()`; only the follower knows which follow
owns what is shown. With nothing registered, `dismissFollow()` just clears.

`createLinkAnswerCache` (named apart from contracts' `LinkResolution`) keys answers by the link's whole identity, its ref and
`linkTargetHref(target)` (the classifier's own spelling), so two links sharing
an href but naming different documents never share an answer. Four states are
answers, named as the resolve API names them (`pending`, `document`,
`missing`, `gone`; the API's `unresolvable` is no answer) and a fifth outcome is
not: a request that THROWS caches nothing, and the link draws as a filled chip
in its own family, because a link the editor could not ask about must never be
drawn as a link that does not exist. `gone` is a ref whose document the reader
can no longer reach (deleted, discarded, unreadable); it never falls back to
the address. Addresses are unique, so there is no "several documents" state: a
link names one document or none.

Each question meets the port's `local` half first, synchronously, so what
the scope can answer without the network is cached before any request goes
out and no failed request can touch it. The rest go to `remote` in batches:
the decoration scan's `request()` queues every unanswered link and pumps
once, so one scan is one batch of up to 200; a click's `resolve()` pumps at
once. Four batches are in flight at most, and a batch that throws fails only
its own questions. A provisional local answer stands through the request and
is replaced only by `gone` or a different document (`settledOver`). A click
on a provisional link waits for that request, or asks again if it failed, so
the server's `gone` or other document wins for a click as it does for the
chip. Any change to a cached entry publishes, a failure included.

The registration's options and the port's own `index` are also the editor's
assignment scope (`resolution.assignment`): the holder's address, its project,
and the local document index that `link-assignment.ts` assigns written links
against.

### A registration is a generation

`registerResolver` is the whole invalidation mechanism; there is no second verb
that drops answers. A writer's Try again follows a failed link, and a failure
caches nothing, so it is simply asked again. Registering starts a generation, and that generation owns
everything true of it:

| It owns | Which means |
|---|---|
| its answers and its failures | they go with the generation, so nothing can read the previous one's |
| the one question out per link key | a request carries the waiter it settles, and a completion never looks one up by key |
| its queue and its in-flight counter | four batches at a time means four of THIS generation's batches |

Two properties follow, and each is a writer-visible failure the moment it does
not hold:

- An answer arriving from an abandoned generation settles its own waiter with
  null and touches nothing live. It cannot settle the promise a question asked
  AFTER the change is waiting on. A store that looked its waiter up by href
  instead answered the new question null while the cache held the right
  document, so the follow said nothing was at that address.
- An abandoned generation's promises decrement their own counter, so they never
  admit work into the live one and the live counter never goes negative. A
  shared counter reset at invalidation admitted twice the limit and then drifted
  below zero, which is no limit at all.

A promise cannot be recalled, so retiring a generation drops its queue and
abandons what is in flight; whatever the port still returns lands on an object
nothing can reach. What happens to the waiter depends on who is waiting:

- A `resolve()` waiter (a click) is asked again in the generation that replaced
  its own, and settles with that answer. The writer asked to go somewhere, and a
  catalog moving underneath them is not an answer; mapping retirement to "could
  not be checked" would also blur a failed request with an unasked one.
- A `request()` question (the decorations) settles null and is dropped. The new
  generation publishes, and the decoration scan asks again.
- Unregistering or destroying the port leaves no generation to carry anything
  into, so every waiter settles null.

The app registers again whenever the scope or the project's document catalog
changes (see
[`features/links/.context/CONTEXT.md`](../../../../features/links/.context/CONTEXT.md)),
so a change landing while questions are in flight is the ordinary case here,
not an exotic one.

### Server authority

All canonical Context schemes resolve through the same server port, by
address only: the exact path, or the path with its final extension omitted
when exactly one document fits (`matchDocumentPath`). An explicit canonical
Work slug may navigate to that Work in the same project; contextual
scratch/uploads use the host's selected Work and `@/` is explicit No Work. The
server gets personal scope from authenticated identity. Nothing searches by
name or title.
Submitted transcript `(documentId, uri)` authority remains separate from syntax
lookup; rendering a title does not adopt it as an attachment.

## Rendering a state nobody stored

`linkResolutionPlugin` scans the document for internal link marks, decorates
each with `data-link-state`, and asks the store about anything it has no answer
for. Both halves matter:

- **`apply` is pure.** It reads the cache and builds decorations. Asking is a
  side effect and lives in the plugin's `view`, which requests what the last
  scan found and redraws when an answer lands. A href with an answer is never
  asked about again, which is what terminates the loop.
- **The redraw is deferred by a microtask.** An answer can land while the same
  view is asking the question, and a transaction dispatched from inside a view
  update is the one ProseMirror refuses to apply. The delay also coalesces a
  burst of answers into one redraw.

ProseMirror renders an inline decoration as a span INSIDE the mark's `<a>`,
one span per text node, while the link mark (priority 1000, outermost) renders
one `<a>` around the whole label. The chip is drawn on the `<a>`: each span
carries `data-link-chip-part` and `data-link-chip-icon`, and the link chip
stylesheet reaches the anchor through `a:has([data-link-chip-part])`. So
`[Lin **Feng**]` is one chip with a bold word in it, not two. That nesting is
load-bearing: a mark ranked above the link would split the `<a>`, and a change
to the decoration shape is a silently undrawn chip.

A React surface with no document to scan (the chat transcript) does the same
through `createLinkRequester`: each shown link `watch`es its key, one
requester per surface asks about the whole watched set in one microtask-
coalesced `request()` on mount and on every publish, and each link only reads
its answer. Asking per link costs links × publishes.

Nothing here is stored. Law 9 is the reason: an LLM's
`[Chapter 214](chapter-214.md)` needs zero extra attributes, and no peer ever
receives a resolution.

## Which chip a link draws

`link-chip.ts` is the one presentation rule for internal links, and every
surface draws from it: the transcript and the composer on their own element
(`linkChipAttributes`), the Editor on the decoration spans inside its `<a>`
(`linkChipPartAttributes`).

| Answer | Chip | Icon |
|---|---|---|
| resolved | filled | the resolved document's scheme |
| unresolved | dashed | the target's own family |
| gone | dashed, no hover, not followable | the target's own family |
| pending, failed, not asked | filled | the target's own family |

Gone draws like chat's unavailable reference. The decoration span carries
`data-link-state="gone"`, which the stylesheet uses to drop the hover. The
accessible state sits on the focusable `<a>` itself, as on chat's
reference: the link mark's view (`linkStateAttributes`) sets an
`aria-description` of "No longer available" (a missing link's is "Doesn't
exist yet") and, for gone, `aria-disabled`, which also drops the pointer
cursor. The view reads the resolution from the extension's storage, not
`getLinkAnswerCache`, because a view built while the editor is constructing
sees the editor as destroyed. The hint, the menu and the form say the same words, and the menu
offers no Open link. A press on a link already known to be gone is the
editor's: a click places the caret, and Enter and Alt+Enter fall through
(`followUnlessGone`); a press before the answer arrives still follows, and
that follow does nothing.

A scheme URI knows its family from its prefix and a relative path from the
holder's `baseUri`. The one link that cannot know it yet is a relative path
before the holder's URI arrives; it draws the generic `file` icon (the registration states it: `registerResolver(resolve,
{ baseUri })`, read back as `resolution.baseUri`), so neither waits on an
answer for its icon. An exact
reference (`referenceChip`) is its URI's family, dashed once its document is
gone. External targets get no chip.

The seam: core emits the chip attributes, never an image. The app owns the
icon data and turns each family into a `--link-chip-icon` mask image keyed by
the icon attribute, on the element or on the `<a>` holding it
(`components/app/link-chip/`). The alternatives were an image passed into
core (core would import app icon data), a per-element inline style (the
Editor's decorations could not carry it without a second hook), and a link
mark view writing state onto its own `<a>` (a second drawing path beside the
decorations, and attribute writes ProseMirror's DOM observer would see).

Drawing changes nothing about editing. The label stays ordinary marked text;
the icon is a pseudo-element, so it is not in the document, the clipboard, or
the caret's path; `inclusive: false` still keeps typing at either edge out of
the link.

## Where the mark's own fences are

`MeridianLink` (in `../extensions/meridian-extensions.ts`) configures TipTap
against this module, and it has to: TipTap's stock allow-list is web schemes,
so it reads `manuscript://` as an attack and drops the mark on parse and on
every command, and its bare-URL autolink reads `chapter-213.md` as a hostname
under the `.md` TLD and rewrites a project document into an external site.
`isAllowedUri`, `shouldAutoLink`, and `renderHTML` all ask the classifier.

## Draft resolution and commit

`resolveLinkDraft` reads the selection when the form opens, not when it
commits: focus moves into the form, and the commit must rewrite the range the
writer was looking at. The form always exposes display text and destination. `needsText` means a bare
caret has no existing prose to preserve. Unchanged display text updates only
the link mark, retaining mixed formatting within the range.

The range travels, on the anchor above. `mapLinkDraft` follows every
transaction and returns null when the words are gone, which closes the form —
committing then would write the writer's link into whatever a peer put in
their place. An empty draft maps as one edge: biasing a caret's two edges apart
inverts it the moment somebody types there.

`commitLinkDraft` returns `applied`, `removed`, `invalid`, or `refused`. The
form stays open on `invalid` so a bad URL never closes over a change that did
not happen, and `refused` covers a document that turned read-only mid-form or a replaced
link identity. The form reports refusal without presenting a successful save.
Rewriting a link's text keeps the marks that text already wore.

The menu acts by position instead: `linkAt(state, pos)` resolves the whole mark
under the pointer, and Edit link selects that range before opening the form, so
one draft path serves all three doors. `linkAt` answers null for a position
outside the document rather than throwing: it is called from inside a Yjs
update handler, where a throw is swallowed and the editor quietly stops
applying peer writes.

## Assigning written links

A stored internal link carries a `ref` (`doc:<id>`, or `ahead:<uuid>` for an
address nothing is at yet) beside its `href`, the full address it was written
with. Every client producer assigns it without parsing and without the network
(`link-assignment.ts`):

| Producer | Writes |
|---|---|
| `@` document row | `doc:<id>`, href its current full URI |
| `@` link-ahead row | `mintAheadRef()`, href `aheadAddress(uri, "link")` |
| Ctrl+K, toolbar, menu Edit (`commitLinkDraft`) | a picked document's `doc:`, else `assignWrittenHref`; an unchanged destination keeps the link's attrs, any other is a retarget assigned fresh |
| pasted `[[…]]` | the catalog row's `doc:`, else a minted ahead ref at the link-ahead address |
| any paste (Markdown, HTML without metadata, another project's rich copy) | `assignPastedNodes` on every link still without a ref, in the link clipboard plugin's `transformPasted` |
| same-project rich paste | the copied ref, at the copied current address |
| image uploads | `asset:` src, no ref |

`assignWrittenHref` is markup's `assignFreshLink`, the pass 3 agent-edit
assigns with, over the local index: external and contextual links keep
`ref: null` and their href; an internal one gets the local index's document
(`indexedDocumentAt`, the server's address rule) or a fresh ahead ref.
A missing or incomplete index is safe: an ahead ref minted for an occupied
address settles on its occupant server-side.

## Clipboard references

Internal links have no browser `href`. Their validated stored target travels in
`data-meridian-link` in rich HTML, and plain clipboard text uses the Markdown
codec (`[label](destination)`).

Copying records, on each internal link mark (the clipboard serializer wraps the
link mark's own DOM), `data-meridian-address` (where it points now: a resolved
ref's document at its current address, else the address its href names, as a
full URI with any fragment or query), and for a link with a ref,
`data-meridian-ref` and `data-meridian-project`. The text flavour
(`markdownClipboardSerializer`) serializes through `clipboardLinkScope`, which
spells every internal link as that same full address, so it means the same
thing in another app or through the Markdown paste door. On paste the sanitizer
keeps well-formed metadata, and the plugin's `transformPastedHTML` (which runs
after it) sets each recorded link's href to its address and keeps its ref only
when the project matches, as `data-meridian-kept-ref`, the one attribute the
link mark's parser reads a ref from and which the sanitizer never lets through.
Every link still unbound is then bound fresh by `transformPasted`. Metadata is
never a capability: a kept `doc:` ref resolves through the reader's catalog
and draws gone when they cannot read it. The chat composer takes the full
address. Nothing here enters the stored Markdown. The app's click handler reads the semantic
target; native URL copying must not interpret it relative to the current route.
The link menu copies the pointed-at slice without moving the writer's selection.
External links retain URL copying. Rich HTML restores stored mark spelling and
formatting; it never persists resolver answers or manufactures document identity.

## Pasted `[[Name]]`

Pasting into an Editor document turns each `[[…]]` into a standard link (D15),
so a note brought over from Obsidian keeps its links. A typed `[[`, what the AI
writes, and text already stored stay text; so does a drag inside the editor.

- **Which pastes** (`WikilinkPasteExtension`, the policy): a paste or a drop
  from outside the editor. Three keep their characters: paste without
  formatting (Ctrl/Cmd+Shift+V, ProseMirror's own flag in
  `transformPastedText`, the signal the Markdown door reads as `plain`; it is
  also how a writer pastes literal brackets), any paste or drop whose
  destination is code, and a drag within the document. `transformPasted`
  reads the destination itself, as every paste path resolves it (a keyed
  paste, and the menu's `pasteHTML` and `pasteText`): a pending drop's
  pointer, else the selection's `$from`. Only a drop's pointer is recorded,
  in `handleDOMEvents.drop` the way ProseMirror resolves `$mouse`, and it is
  cleared in a microtask after the event, so a drop ProseMirror abandons
  leaves nothing behind. The plain-or-code flag from `transformPastedText` is
  set and read within one parse of clipboard text. Code matters because
  ProseMirror hands it a bare text slice, and a link there would keep only
  its label.

- **Where.** `transformPasted`, the one prop every paste kind reaches once and
  after parsing (Markdown through the paste door, plain prose, HTML whose text
  holds the brackets). Only the Editor mounts the extension. Its catalog is
  the Editor's: the holder, its link index (what its links resolve against)
  across Manuscript, KB, User, and this Work's Scratch, and the same
  `linkAhead` the `@` menu's link-ahead row uses. While the index loads the
  catalog is null and the brackets stay text rather than all turning dashed.
- **Syntax** (`scanWikilinks`): `[[target]]`, `[[target|label]]` (also the
  table's `\|`), `[[target#Heading]]`, `[[target#^block]]`, folders in the
  target, `.md` implied without an extension. The label is the alias or the
  name without `.md`; the suffix stays on the destination. `![[…]]` (no
  transclusion) and anything in code (a fence, a code mark, or a backtick span
  still spelled out) stay text; so does a link inside a link.
- **Escapes.** On every paste the policy transforms, each escaped opening
  outside code, `\[[` or `\[\[` (as Meridian's own Markdown writes literal
  brackets), becomes the literal `[[`, closed or not and with the catalog
  loaded or not. Paste without formatting and a code destination keep the
  characters as pasted, backslash included. The Markdown door would turn `\[`
  into `[` before the transform could tell an escape from a link, so the
  extension contributes `remarkKeepWikilinkEscapes` (`wikilink-escape.ts`, a
  micromark text construct that claims the escape ahead of the core one and
  keeps the characters) through its storage, and the door reads it per paste
  (`wikilinkPasteParsePlugins`). An Editor without the extension reads an
  escape exactly as Markdown does.
- **Which document** (`rankWikilinkMatches`; per paste, `wikilinkResolver`
  locates the catalog once and ranks only the documents sharing a link's
  filename): case-insensitive, by path ending.
  `[[Name]]`: the holder's folder, then its area root, then the rest by
  holder's area first, fewest folders, alphabetical URI. `[[a/Name]]`: that
  path from the holder's area root, then from another area's root (Manuscript,
  KB, User, Scratch), then path endings ordered as before. Obsidian's own last
  step is index order; ours is fixed so a paste never depends on load order.
  Any match links.
- **No match**: `linkAhead(name, folders)`, which is `linkAheadAddress`: beside
  the holder, a folder form under the holder's area root, the manuscript root
  from a holder with no address or in an area Create refuses (Scratch,
  Uploads, Unfiled). It gets a fresh ahead ref, and is dashed until a
  document arrives there (a follow's Create), which settles the ref.
- **Binding**: a match is `doc:<id>` from the catalog row, spelled as its full
  URI plus the suffix, as `@` writes. The paste is one transaction, so one
  undo removes it.
