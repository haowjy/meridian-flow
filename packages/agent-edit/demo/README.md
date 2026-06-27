# agent-edit demo harness

Throwaway end-to-end harness for `@meridian/agent-edit`: it wires the real `createAgentEditCore` write path to in-memory fake ports that stand in for the server journal/coordinator, then prints create/read/edit/undo/concurrency scenarios. Run it with `pnpm --filter @meridian/agent-edit demo`. This is confidence-demo code only, not a shipped library surface.

## React playground

[`playground/`](./playground) — throwaway Vite + React app that drives the same
`createAgentEditCore` + in-memory fakes in the browser and renders the live
`Y.Doc` via `y-prosemirror`. Read-only ProseMirror view; the agent is the only
writer.

```bash
pnpm --filter @meridian/agent-edit-playground dev
# → http://localhost:5180/
```

Build/preview if needed: `pnpm --filter @meridian/agent-edit-playground build`.

The UI has three panels: the live editor (left), the per-block 4-char hash
overlay (right), a command panel that fires each `write()` command with a
free-form `turnId`, and a `write()` output log. A "Run scripted tour" button
replays the harness highlights (multi-write turn undo, cross-block find,
concurrent reconcile) against `tour.mdx` so a viewer can watch the live doc
update without typing.

Caveats — the `jsx_leaf` / `jsx_container` TipTap node-views land in Step 9, so
those nodes render as a labeled placeholder block in the editor pane (the
underlying Y.Doc structure is unchanged).

[`architecture.html`](./architecture.html) — interactive, as-built map of the package
(ports & adapters seam, the `write()` pipeline, cold reconstruction undo/redo). Self-contained;
open it with `file://` or any static server.
