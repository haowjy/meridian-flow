# Package fetch budgets

The rule: a fetch that crosses a shared budget (download, expanded bytes, archive entries, wall
time) aborts with that budget's name, while the bytes are still streaming
([contracts](../CONTEXT.md)).

```sh
pnpm exec tsx tools/qa/probes/package-fetch/run.mts
```

`tools/qa/probes/package-fetch/run.mts` serves a generated 4 MB repository from an in-process fake of
GitHub (the adapter's `fetch` option), fetches it once with no limit, then four times with one limit
lowered, and asserts the `FetchBudgetError` names that budget before the whole archive is read. It
makes no network calls, so CI runs it with the other probes (`pnpm test:probes`).

The URL forms (root, `tree/<draft>`, `tree/<tag>/<path>`, a draft containing `/`, an annotated tag,
a missing ref) are read with `./mf package fetch <url>` on a running stack.
