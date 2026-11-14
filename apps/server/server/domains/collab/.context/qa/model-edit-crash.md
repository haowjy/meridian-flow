# Crash test of the model's edits

The model's document edits must survive a process death at any step: the document text, the
`document_edits.command_id` receipts, the stored result blocks and the `document_commands` rows
each end up exactly once ([design][design], [model edits](../model-edits.md),
[recovery](../../../runtime/.context/recovery.md)).

```sh
pnpm test:probes model-edit-kills
```

(`pnpm test:probes` runs every `tools/qa/probes/<name>/run.mts`; CI does.) Each probe makes and
drops its own `lfd_probe_*` database.

## The harness

`tools/qa/probes/model-edit-harness/`:

- `child.mts` is one composed server: production ports and services over the scratch database
  with a pool of `max: 2` (a second connection held under a lock hangs the probe instead of
  production), the mock model, and the Hocuspocus gateway. The parent drives it with JSON lines
  on stdin: queue a scripted reply, arm a test hook point, send a message, run the recovery
  lanes once.
- `harness.mts` is the parent: it seeds a Work, chats and documents by SQL, bundles the child
  with esbuild (a tsx boot takes 8 s, the bundle 1 s), spawns children, and asserts on rows.

A case sends a message as the writer, so the run starts as the chat route starts it (admission,
inbox, run claim, orchestrator). The mock model's replies are scripted per response, with the
response id and each tool call id fixed (`responseId`, `id` in `mockModelScript` steps), so a second
process derives the same command ids.

- **Kill**: arming a point with `kill` makes the child `SIGKILL` itself on arrival. The session
  lock is freed by the death, as in production.
- **Hold**: arming with `hold` parks the operation at the point, with the locks it holds, until
  `release`. The old process stays alive while a second one recovers.
- **Takeover**: a second child runs `sweep` (orphan repair and wake scan), the real recovery.

Hook points are in `shared/test-hooks.ts`. The loop's are `response.beforeStore`,
`block.beforeStore`, `block.duringStore` and `block.afterStore`.

[design]: https://github.com/haowjy/meridian-flow-docs/blob/main/work/local-first-design/document-commands/design.md
