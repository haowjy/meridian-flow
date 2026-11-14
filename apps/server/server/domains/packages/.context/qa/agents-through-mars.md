# Agents through Mars

The rule: anything Mars or Flow reports on an Agent's file makes that Agent unavailable, and
an Agent never runs with more access than its file says ([contracts](../CONTEXT.md)). Two
scripts hold it.

## Database probe

```sh
pnpm test:probes agents-through-mars
```

`tools/qa/probes/agents-through-mars/run.mts` makes and drops its own `amars_probe_*` database
and runs the real Drizzle store and catalog over it. It checks:

- the built-in package: nine Agents, no diagnostics, `resolvePrimary` for the six primaries, and
  `permission: "read"` for Critic and for the two subagents Muse names;
- 24 files that must each be an unavailable Agent (Mars errors, warnings and infos, Flow's own
  block checks, a missing or invalid manifest, a missing skill or subagent), with `readRevision`
  returning nothing and a `NULL` `definition` row;
- files that must resolve with exactly the permission or tool lists their rules give;
- saving a valid file over a broken personal Agent;
- a reader bump: a second reader version's rows, a held old selection refused, a bound chat's
  child Agents still resolving, and the boot recompile advancing a package left at the old version.

## Server gate

```sh
LIVE_TEST_MODEL= MODEL_PROVIDER=mock pnpm dev
pnpm exec tsx tools/qa/agents-through-mars/server-gate.mts
```

(`LIVE_TEST_MODEL` set in the main checkout's `.env` stops the mock provider booting; the empty
value overrides it.) It saves a file with a removed key through `POST /api/agents` and checks it
is listed unavailable and no thread binds it; it has Critic write to `manuscript://Scene` and
checks the refusal and that no document exists; it has Muse spawn `continuity-checker` and
`reader-sim` and reads each child's binding from the database for `permission: read`.

It does not script a child's own `write`: the children's turns run on the mock's default reply.
The browser run (the Agent picker, a chat with Critic, an edit refused in the chat) is a prober's.
