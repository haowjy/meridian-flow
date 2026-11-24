# Agents through Mars

The rule: an error, Mars's or Flow's, in one Agent's or skill's file leaves that item out of the
saved version (the rest saves, and the result lists it first); an error in `mars.toml` fails the
Save and the previous version stays; a warning or info saves, with the warning on the result; an Agent never runs with more
access than its file says, except by a warning the Save showed ([contracts](../CONTEXT.md)). Two
scripts hold it.

## Database probe

```sh
pnpm test:probes agents-through-mars
```

`tools/qa/probes/agents-through-mars/run.mts` makes and drops its own `amars_probe_*` database
and runs the real Drizzle store and catalog over it. It checks:

- the built-in package: nine Agents, no diagnostics, `resolvePrimary` for the six primaries, and
  `permission: "read"` for Critic and for the two subagents Muse names;
- 24 files: the errors in an Agent's file (Mars's, Flow's own block checks, a missing skill or
  subagent) must leave it out (`leftOut`, an Error in its package's `files()` findings, unbindable); a missing or invalid
  manifest must fail the Save; the Mars warnings and infos must save, the warnings with a finding
  on the result;
- files that must resolve with exactly the permission or tool lists their rules give (an allow-list is `tools`, `deny` is `disallowed-tools`, `ask` runs as allow, a rule on a tool Flow lacks is met);
- one broken Agent left out while the rest of its package saves, a broken manifest keeping the previous version, and fixing a broken Agent by editing the file and saving;
- a chat keeping its revision when the file is edited and saved, and a new chat binding the newest save by name;
- a reader bump: a second reader version's rows, a held old selection reaching the entry's current revision (or refused as unavailable when that revision is), a bound chat's
  child Agents still resolving, and the boot recompile advancing a package left at the old version.

## Server gate

```sh
LIVE_TEST_MODEL= MODEL_PROVIDER=mock pnpm dev
pnpm exec tsx tools/qa/agents-through-mars/server-gate.mts
```

(`LIVE_TEST_MODEL` set in the main checkout's `.env` stops the mock provider booting; the empty
value overrides it.) It makes a file with an Error (`effort: 7`), Saves it through `POST /api/agents/save`
and checks the Save leaves it out (HTTP 200, its error first), it is listed unavailable and no thread binds it; it has Critic write to `manuscript://Scene` and
checks the refusal and that no document exists; it has Muse spawn `continuity-checker` and
`reader-sim` and reads each child's binding from the database for `permission: read`.

It does not script a child's own `write`: the children's turns run on the mock's default reply.
The browser run (the Agent picker, a chat with Critic, an edit refused in the chat) is a prober's.
