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

Every remote change reaches this editor as a replacement of the WHOLE document:
y-prosemirror rebuilds the ProseMirror doc from the Yjs type and dispatches one
replace step (`sync-plugin.js`, `_typeChanged`). Every position therefore maps
to a boundary and reports itself deleted, so a surface that holds raw numbers
across a peer edit or an AI write is pointing at nothing — and this product is
built around AI writes landing while the writer works.

`LinkAnchor` is the answer, and it is the same one the rest of the editor
already uses for peer marks and live ranges: Yjs relative positions, resolved
through `relative-position-runtime.ts`. `anchorLinkRange` pins a range,
`resolveLinkAnchor` finds it again, and the ProseMirror mapping stays the
fallback for an editor with no shared document, where there are no remote
changes to survive.

Position is only half of it. `relocateLink` re-reads the mark at the resolved
position and compares it by attributes: coordinates outlive the thing that was
at them, so a link deleted and replaced by other text, or an href a peer
changed, both have to close the surface rather than re-aim it. The menu closes;
the form closes; neither acts on words the writer never pointed at.

## The resolution port

M7 defines the seam and registers no navigator, so internal links do not
navigate yet:

```ts
type InternalLinkNavigator = (request: {
  target: LinkTarget;
  disposition: "current" | "new-tab";
}) => void;
getLinkSurface(editor)?.registerNavigator(navigate); // returns an unregister
```

What the wikilink lane (M12) plugs in, without restructuring anything here:

1. A navigator that calls the resolve endpoint with
   `documentLinkTarget(target, baseUri)` plus the project and work, and opens
   the returned document in the context pane. `{ document: null }` is the
   unresolved case and is where "create the document and link it" belongs.
   `disposition` says whether the writer asked for the same pane or a new tab;
   middle-click and Ctrl/Cmd+click already produce the second.
2. `[[` autocomplete inside the form's Link field. The field already accepts
   and normalizes the wikilink spelling; the autocomplete is a listbox over
   it, not a second commit path.
3. Unresolved rendering. Every link renders `data-link-kind` on its `<a>` —
   rendered only, never a schema attribute — so quiet ink and a dashed
   underline for an unresolved wikilink is a CSS rule plus whatever attribute
   the resolver's answer sets.

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
