# Package fetch budgets

The rule: a fetch that crosses a shared budget (download, expanded bytes, archive entries, wall
time) aborts with that budget's name, while the bytes are still streaming
([contracts](../CONTEXT.md)).

```sh
pnpm exec tsx tools/qa/probes/package-fetch/run.mts
```

`tools/qa/probes/package-fetch/run.mts` fetches `haowjy/creative-writing-skills` from live GitHub four
times, each with one limit lowered, and asserts the `FetchBudgetError` names that budget. Set
`FLOW_GITHUB_TOKEN` to avoid the unauthenticated rate limit.

The URL forms (root, `tree/<branch>`, `tree/<tag>/<path>`, a branch containing `/`, an annotated tag,
a missing ref) are read with `./mf package fetch <url>` on a running stack.
