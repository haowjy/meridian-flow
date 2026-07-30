# The link system — contracts

Reference depth. Read [`AGENTS.md`](../AGENTS.md) first.

## The classification seam

```ts
export type LinkTarget =
  | { kind: "wikilink"; name: string }   // [[The Second Gate]]
  | { kind: "scheme"; uri: string }      // manuscript://…, work://…
  | { kind: "relative"; path: string }   // chapter-213.md, ../notes/kael.md
  | { kind: "external"; url: string };   // http, https, mailto

classifyLinkTarget(href: string): LinkTarget | null
documentLinkTarget(target: LinkTarget, baseUri: string): DocumentLinkTarget | null
normalizeLinkHref(input: string): string | null
linkTargetHref(target: LinkTarget): string
```

The three internal kinds line up one-for-one with `DocumentLinkTarget` in
`@meridian/contracts/protocol`, which is what `POST /api/projects/:projectId/
links/resolve` takes. `baseUri` is the URI of the document holding the link;
only `relative` needs it and only the caller knows it.

Two directions, one fence. `classifyLinkTarget` reads an href already in the
document — from the markdown parser, an LLM, or this module — and asks what it
is. `normalizeLinkHref` reads what a writer typed and asks what to store; the
one thing it adds is the missing `https://`, last, so a wikilink, a scheme URI,
and a relative path keep their own meaning. The difference shows on a bare
hostname: `example.com` in an href is a path (markdown never adds a scheme),
and `example.com` in the form is a website.

| href | classify | normalize |
|---|---|---|
| `[[The Second Gate]]` | wikilink | `[[The Second Gate]]` |
| `[[ Warden Ilsever ]]` | wikilink | `[[Warden Ilsever]]` |
| `[[Kael\|the warden]]` | null | null |
| `manuscript://appendix/charter` | scheme | unchanged |
| `work://a1b2/notes.md` | scheme | unchanged |
| `chapter-213.md`, `../notes/kael.md` | relative | unchanged |
| `example.com` | relative | `https://example.com` |
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
| Ctrl+K | selection | form, one field |
| Ctrl+K | bare caret | form, two fields, inserts a finished link |
| Ctrl+K | caret in a link | form, pre-filled; an emptied URL removes the link |
| Alt+Enter | caret in a followable link | follows |

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
  disposition: "current" | "new-tab";
}) => void;
getLinkSurface(editor)?.registerNavigator(navigate);      // returns an unregister

type InternalLinkResolver = (target: LinkTarget) => Promise<ResolvedDocumentLink | null>;
getLinkResolution(editor)?.registerResolver(resolve);     // returns an unregister
```

The navigator is where a follow goes. The resolver is where every rendered
internal link's state comes from, and the two share one cache, so a click on a
link the writer can already see resolved opens the document with no round trip.

`createLinkResolution` keys answers by `linkTargetHref(target)` — the
classifier's own spelling — so `[[ The Second Gate ]]` and `[[The Second Gate]]`
ask once between them. Three states are answers (`pending`, `resolved`,
`unresolved`) and a fourth outcome is not: a request that THROWS caches nothing
and renders nothing, because a link the editor could not ask about must never
be drawn as a link that does not exist.

Null from the port covers both "nothing matched" and "several did": ambiguity
resolves to nothing rather than to a guess, and the writer sees the same
dashed link either way. The `[[` menu is where ambiguity is named, before the
link is written.

### A registration is a generation

`registerResolver` is the whole invalidation mechanism; there is no second verb
that drops answers. Registering starts a generation, and that generation owns
everything true of it:

| It owns | Which means |
|---|---|
| its answers and its failures | they go with the generation, so nothing can read the previous one's |
| the one question out per href | a request carries the waiter it settles, and a completion never looks one up by href |
| its queue and its in-flight counter | four at a time means four of THIS generation's questions |

Two properties follow, and each is a writer-visible failure the moment it does
not hold:

- An answer arriving from an abandoned generation settles its own waiter with
  null and touches nothing live. It cannot settle the promise a question asked
  AFTER the change is waiting on. A store that looked its waiter up by href
  instead answered the new question null while the cache held the right
  document, so the follow said nothing carries that name.
- An abandoned generation's promises decrement their own counter, so they never
  admit work into the live one and the live counter never goes negative. A
  shared counter reset at invalidation admitted twice the limit and then drifted
  below zero, which is no limit at all.

A promise cannot be recalled, so retiring a generation drops its queue and
answers every waiter null right away; whatever the port still returns lands on
an object nothing can reach.

The app registers again whenever the scope or the project's document catalog
changes (see
[`features/editor/surfaces/link/.context/CONTEXT.md`](../../../../features/editor/surfaces/link/.context/CONTEXT.md)),
so a change landing while questions are in flight is the ordinary case here,
not an exotic one.

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

ProseMirror renders an inline decoration as a span INSIDE the mark's `<a>`, so
`surfaces/link/link-surfaces.css` reaches the anchor through
`a:has([data-link-state="unresolved"])`
— the underline belongs to the anchor and a descendant cannot call it off.
`link-resolution.test.ts` asserts that nesting, because a change to it is a
silently unstyled unresolved link.

Nothing here is stored. Law 9 is the reason: an LLM's `[[Chapter 214]]` needs
zero extra attributes, and no peer ever receives a resolution.

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
writer was looking at. `needsText` (a bare caret) is the only thing that
chooses between the one-field and two-field forms.

The range travels, on the anchor above. `mapLinkDraft` follows every
transaction and returns null when the words are gone, which closes the form —
committing then would write the writer's link into whatever a peer put in
their place. An empty draft maps as one edge: biasing a caret's two edges apart
inverts it the moment somebody types there.

`commitLinkDraft` returns `applied`, `removed`, `invalid`, or `refused`. The
form stays open on `invalid` so a bad URL never closes over a change that did
not happen, and `refused` covers a document that turned read-only mid-form.
Rewriting a link's text keeps the marks that text already wore.

The menu acts by position instead: `linkAt(state, pos)` resolves the whole mark
under the pointer, and Edit link selects that range before opening the form, so
one draft path serves all three doors. `linkAt` answers null for a position
outside the document rather than throwing: it is called from inside a Yjs
update handler, where a throw is swallowed and the editor quietly stops
applying peer writes.
