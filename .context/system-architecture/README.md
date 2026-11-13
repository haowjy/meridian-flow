# Architecture map

How Meridian Flow is built. It is a writing app for long fiction: a writer edits a manuscript in
the browser and works on it with a model in chat, and both edit the same documents at once.
Product words are in the [glossary](../glossary.md).

Every page is Markdown with a Mermaid diagram, so it reads on GitHub and in an editor as it
does in the viewer. `pnpm dev` prints a `map` URL that opens the same pages in a viewer; the HTML
holds no content.

## The pages

Each level is a picture of **parts and the flow between them**, not of imports: at most about 12
boxes, arrows that say what moves, the main path numbered. A box that stands for several parts is a
group and opens a page of its own.

- [System](system.md): what runs when a writer uses it, and what happens when they send a message.
- [Code](code.md): the apps and packages as layers.
- [Server](server.md): `apps/server/server`, in groups of domains by the writer work they serve.
- [App](app.md): `apps/app/src`: routes, `core`, `client`, `components` and the features.

Child pages (a group's members) are opened from their group and sit beside these as
`server-<group>.md`.

[Flows](flows/index.md): end-to-end sequences, one page each. [Dependencies](dependencies.md): the
rules the code is meant to keep and the places it breaks them. [Journeys](journeys/index.md): what a
writer does and sees, one step per card, linked to the boxes and state machines behind it. State
machine pages sit in `.context/` beside the code they describe and are listed in the
[state machines index](../state-machines/index.md); a box attaches each one.

## Editing

- **A change that adds, removes or moves something the map names** (a package, a domain, a feature
  directory, or a boundary between them) **updates the map in the same commit.** So does a change
  that adds a state machine page: list it in the index, then on a box.
- **A change that changes a writer journey updates that journey in the same commit.**
- **A change that adds an import breaking a rule in `dependencies.md` adds a row there**, and one
  that removes the last such import deletes the row.
- **`pnpm check:architecture` catches a path that has disappeared, not a picture that has gone
  wrong.** It passing is not the test: read the box you touched and ask whether its words and its
  arrows are still true at run time.

### A level page

````markdown
# Server

One paragraph: what this level is, shown to the reader above the diagram.

```mermaid
flowchart LR
  routes["routes<br/><small>take the request</small>"]:::module
  runtime["runtime<br/><small>runs a turn with the model</small>"]:::domain
  writing["writing<br/><small>drafts and edits</small>"]:::group
  routes -->|"1. sends the message"| runtime
  runtime -->|"2. writes a draft"| writing
```

## runtime

Runs a turn: one line (it also shows in the box list).

Two or three sentences that orient a newcomer.

- Kind: domain
- Paths: `apps/server/server/domains/runtime`
- Docs: [CONTEXT](../../apps/server/server/domains/runtime/.context/CONTEXT.md)
- Machines: [runtime](../../apps/server/server/domains/runtime/.context/state-machines.md)
- Drift: where the docs and the code disagree

## writing

Drafts and edits.

- Kind: group
- Opens: [Server: writing](server-writing.md)
````

- **One `mermaid` block, a `flowchart`.** Each line is the `flowchart` header, a node
  `id["Name<br/><small>role</small>"]:::kind`, an arrow, `subgraph ... ["Title"]` / `end`, or a `%%`
  comment. A label holds only `<br/>` and `<small>`. Anything else fails the check.
- **An arrow** is `a -->|"label"| b`, or `<-->` when data flows back, and points from the side that
  starts the exchange. The label says what moves ("streams the reply"). The main path's labels start
  `1. `, `2. `, … and must run in order on the page; side arrows have no number. An `import` arrow
  fails: imports are not drawn.
- **A note** explains a box in a sentence or two: `note1["text"]:::note`, attached to the box with an
  unlabelled dotted link, `note1 -.- runtime`. A note takes no `##` section, no `Paths` and no `Kind`;
  it must link to a box. GitHub draws it as an ordinary box.
- **A node's id is its section.** Every node has a `## <id>` section on the page and every `##`
  section is a node. A box that belongs to another level, shown for reference, has kind `context`
  and `- See: [label](other.md#id)`.
- **Node kinds** (the class): `person`, `client`, `service`, `store`, `external`, `files`, `domain`,
  `feature`, `module`, `package`, `context`, `group`. A `group` needs `- Opens: [label](child.md)`; its coverage is the paths of
  the boxes on the child page, plus any `Paths` of its own.
- **List items:** `Kind` (required, equals the class), `Paths`, `Docs`, `Machines`, `Opens`,
  `Breaks`, `Drift`, `See`, and `Shot` (a screenshot, later). Paths and links must resolve.
- A level page is listed in the pages above, or opened by a group.

### A flow page

````markdown
# A message becomes an edit

Intro: what the flow starts from and ends with.

```mermaid
sequenceDiagram
  participant app
  participant file-policy
  app->>runtime: sends the message
  runtime->>file-policy: asks for a grant
```

1. The writer sends a message from [app](../app.md#client).
2. [runtime](../server.md#runtime) asks [file-policy](../server.md#file-policy).
````

A participant is a box id from some level page. The numbered steps under the diagram link to
boxes and state machines. [flows/index.md](flows/index.md) lists every flow.

### dependencies.md

The rules in prose, then one table of the places the code breaks them today, one row per
direction: `| from | to | rule | example file |`. `from` and `to` are repo paths or box ids; the
example file is a real importing file. The rules are the ones [CONTEXT.md](../CONTEXT.md) writes:
domains don't import each other in a cycle, domains don't import `lib/`, packages don't import apps.

### A journey page

A `#` title, a summary, then a `##` section per step with a `Does:` and a `Sees:` paragraph, and
the items `Map` (links to `#<box id>` on a level page), `Machines` and later `Shot`:
[Start a project](journeys/start-a-project.md) is a full example.

## What `pnpm check:architecture` catches

- A Mermaid line the format doesn't allow; a box without a section or a section without a box; a
  `Kind` that isn't the box's class; an unknown node kind; an arrow with a kind prefix or an import
  arrow; numbered arrows out of order; a group with no `Opens`; a level page nothing lists or opens;
  a note that links to nothing, joins two notes or two boxes, or has a section.
- A path that doesn't exist; a link whose file or `#id` doesn't resolve, in every page here and in
  the journeys and flows; a journey `Map` link that isn't a box.
- A flow participant that isn't a box id; a flow that isn't in `flows/index.md` or has no numbered
  steps.
- An app, package (with a `package.json`), server domain or app feature directory that no box's
  `Paths` reaches: a new one needs a box, or a path on the box that holds it.
- A state machine page the index links that is on no box; a `*state-machine*.md` the index doesn't link.
- A `dependencies.md` row with no import behind it: nothing under `from` imports `to`, or the
  example file isn't such an importer. The check reads source (relative imports, `@/` in `apps/app`,
  `~/` in `apps/www`, `@meridian/*` package names, stylesheet `@import`), leaves out tests and
  `test-support` files, and ignores imports in comments.
- A break of a written rule with no row: a domain's value import of another domain inside an import
  cycle (one row per direction), a domain's value import of `apps/server/server/lib/`, a package's
  import of an app. The failure names the importing and imported files.
- The viewer's colours: `styles/tokens.css` must match `packages/design-tokens`, and `styles/page.css`
  holds no raw colour.

It doesn't catch: whether a box's words or an arrow are still true; an ordinary import (none is
listed anywhere); `Drift` and `Breaks` notes that went stale; a feature importing another feature,
or an app layer importing another (no rule is written, and the code imports both ways); anything
the checker can't see in source text, such as a path built at run time.

## The viewer

`index.html` needs the pages served from the repo: `pnpm dev` does that
(`apps/app/dev/architecture-dev-plugin.ts`), opened from disk it says so. A level page opens as Map
(boxes you can drag; where you put them is remembered for that page on this computer, and "Reset
layout" undoes it) or Read (the Markdown with its diagram); the header toggles. Scripts come from a
CDN with pinned versions and integrity hashes. See [AGENTS.md](AGENTS.md) for how the
viewer is built.
