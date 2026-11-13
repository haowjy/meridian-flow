/*
 * The map's content: every level, box and arrow. Edit this file to correct the map; the
 * rendering code reads nothing else. `check.mjs` (run by `pnpm check`) fails when a level,
 * box or arrow is malformed, when a path in `paths`, `docs` or `machines` no longer exists, or
 * when a page that `.context/state-machines/index.md` links is on no box. Whether the words
 * are still true, and whether an import has an arrow, are review points.
 *
 * A level: { id, title, parent, summary, rules?, docs?, nodes, edges }. `id` is the URL hash.
 * A box:   { id, label, kind, tag?, shot?, sub, about, paths?, docs?, machines?, rules?, breaks?, drift?, child? }
 *   kind   person | client | service | sandbox | store | external | files | domain | feature
 *          | module | package | context (a box that belongs to another level, shown for reference)
 *   machines  the repo paths of the state-machines pages for this box's code
 *             (`<dir>/.context/state-machines.md`); the panel draws them from the Markdown;
 *   breaks where it breaks the dependency rule;
 *   drift  where the docs disagree with the code; child: the level that opens inside it;
 *   shot   the screen the box draws: "<shot>" (a card thumbnail, and the whole screenshot in the
 *          panel) or "<shot>/<region>" (the thumbnail crops that region). Shots are read from
 *          docs/screens/screens.js when it exists and ignored when it doesn't.
 *          A link to a box or an arrow is `#<level>/<box>` or `#<level>/<from>-<to>`.
 * An arrow: { from, to, label, kind, both?, breaks? }, pointing from the side that starts the exchange
 *   (the caller, the reader, the subscriber); `both` when data flows back as well;
 *   `breaks` when the arrow itself breaks the dependency rule.
 *   kind   http | sse | ws | model | files | sql | call | port | import
 *          call: into code the from-box imports a value from; port: through a dependency handed
 *          in (by the composition root or a caller), so at most a type import backs it; import: a
 *          code dependency.
 */
globalThis.ARCHITECTURE = {
  repo: "haowjy/meridian-flow",
  branch: "main",
  roots: [
    { id: "system", label: "Running system" },
    { id: "code", label: "Code dependencies" },
  ],
  levels: [
    {
      id: "system",
      title: "Meridian Flow",
      parent: null,
      docs: [".context/CONTEXT.md", ".context/invariants.md"],
      summary: "Placeholder map: the writer's app and the server it talks to.",
      nodes: [
        {
          id: "app",
          label: "App",
          kind: "client",
          sub: "The writer's browser app",
          about: "Where the writer edits documents and chats with the model.",
          paths: ["apps/app/src/features/chat"],
          machines: [
            "apps/app/src/client/chat-submissions/.context/state-machines.md",
            "apps/app/src/client/creation/.context/state-machines.md",
            "apps/app/src/components/app/composer-toolbar/.context/state-machines.md",
            "apps/app/src/core/editor/.context/state-machines.md",
            "apps/app/src/core/uploads/.context/state-machines.md",
            "apps/app/src/features/chat/.context/state-machines.md",
            "apps/app/src/features/debug/.context/state-machines.md",
            "apps/app/src/features/draft-review/.context/state-machines.md",
            "apps/app/src/features/editor/.context/state-machines.md",
            "apps/app/src/features/import/.context/state-machines.md",
            "apps/app/src/features/project/context/.context/state-machines.md",
            "apps/www/src/features/landing/.context/state-machines.md",
          ],
        },
        {
          id: "server",
          label: "Server",
          kind: "service",
          sub: "Domains behind one HTTP and WebSocket surface",
          about: "Runs the model, keeps threads and projects.",
          paths: ["apps/server/server/domains/runtime"],
          machines: [
            "apps/server/server/domains/collab/.context/state-machines.md",
            "apps/server/server/domains/context/uploads/.context/state-machines.md",
            "apps/server/server/domains/import/.context/state-machines.md",
            "apps/server/server/domains/projects/.context/state-machines.md",
            "apps/server/server/domains/runtime/.context/state-machines.md",
            "apps/server/server/domains/threads/.context/state-machines.md",
            "apps/server/server/lib/.context/state-machines.md",
          ],
        },
        {
          id: "packages",
          label: "Packages",
          kind: "package",
          sub: "Shared code",
          about: "Placeholder box.",
          paths: ["packages/thread-client"],
          machines: [
            "packages/agent-edit/.context/state-machines.md",
            "packages/resource-replica/.context/state-machines.md",
            "packages/thread-client/.context/state-machines.md",
          ],
        },
      ],
      edges: [{ from: "app", to: "server", label: "threads and drafts", kind: "ws", both: true }],
    },
    {
      id: "code",
      title: "Code dependencies",
      parent: null,
      summary: "Placeholder.",
      nodes: [
        {
          id: "runtime",
          label: "Runtime",
          kind: "domain",
          sub: "Runs a thread's turns",
          about: "Placeholder box.",
          paths: ["apps/server/server/domains/runtime"],
        },
      ],
      edges: [],
    },
  ],
};
