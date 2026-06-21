# agent-edit demo harness

Throwaway end-to-end harness for `@meridian/agent-edit`: it wires the real `createAgentEditCore` write path to in-memory fake ports that stand in for the server journal/coordinator, then prints create/view/edit/undo/concurrency scenarios. Run it with `pnpm --filter @meridian/agent-edit demo`. This is confidence-demo code only, not a shipped library surface.

[`architecture.html`](./architecture.html) — interactive, as-built map of the package
(ports & adapters seam, the `write()` pipeline, hot+cold undo). Self-contained, CDN-only;
open it with `file://` or any static server.
