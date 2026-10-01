# Manual worktree cleanup

For when `pnpm dev:prune-worktrees -- --target <x> --dry-run` refuses a
branch you believe is safe to remove. The tool only acts on proof: an exact
merged-PR match, or the commit's ancestry of the base branch
([`tools/dev/AGENTS.md`](AGENTS.md)). When neither holds, it refuses — correctly,
on the evidence it has. This guide is for building better evidence by hand,
not for overriding the tool's judgment.

## When this applies

- The branch merged into another working branch (no PR of its own), and that
  branch was later squash-merged into `main` or `staging`. Squashing
  discards the ancestor relationship entirely, for every branch that fed it.
- The branch merged before this repo's migration-history guard or some other
  check existed, leaving no CI record.
- Any other case where you can reconstruct the merge from history, but the
  tool's two proof paths don't reach it.

If you can't reconstruct a concrete merge path — not "I'm pretty sure," an
actual commit or record — stop and ask a human. A wrong guess here deletes a
branch and its worktree, including an unmerged commit if you're wrong.

## Build the evidence

1. **Find the record of the merge.** The project's decision log, the PR
   description of the integration branch, or a review/report that names the
   commit the side-lane merged as. You need a commit SHA, not a memory.

2. **If the integration branch was squash-merged, find its pre-squash tip.**
   A squashed PR's merge commit has one parent; the original branch tip is
   gone from any ref, but the commit object usually isn't yet (check
   `git cat-file -t <sha>`; it survives until a `git gc --prune` collects it,
   typically two weeks). Recover the SHA from the decision log, a report, or
   `git reflog` if you had it checked out locally.

3. **Confirm the preserved tip is trustworthy**, then use it as your
   ancestry base instead of `main`:

   ```bash
   # Content should match the squashed commit on main almost exactly.
   git diff <preserved-tip> <squashed-commit-on-main> --stat

   # Now every side-lane branch can be checked against real history.
   git merge-base --is-ancestor <branch> <preserved-tip>
   ```

   A handful of unrelated lines (a docs fix landed between the last push and
   the actual merge, say) is expected. Full files of unexplained difference
   is not — stop and dig into why before trusting this as your base.

4. **Check for anything still using the worktree before deleting it.** A
   worktree can be a running agent's task directory with no worktree-level
   trace of that — `meridian work show <work-item>` lists spawns attached to
   it, and `meridian spawn status <id>` shows whether one is still live. A
   worktree with no uncommitted changes can still be load-bearing. Deleting
   one out from under a live session doesn't lose data, but it breaks that
   session's next file operation with no warning.

## Clean up

Once you have the evidence, do by hand exactly what the tool would:

```bash
(cd <worktree-path> && pnpm dev --stop)
(cd <worktree-path> && pnpm dev:db:drop --yes)
git worktree remove <worktree-path>
git branch -D <branch>
```

`dev:db:drop` is a no-op (prints a notice, not an error) when the worktree
never had a scoped database — safe to run unconditionally.

## Don't

- Don't infer safety from a branch name, a date, or "this was probably
  cleaned up already."
- Don't batch dozens of branches through this without verifying each one;
  the evidence step is per-branch, not per-sweep.
- Don't skip the live-session check because the worktree's git status is
  clean. Clean and idle are different things.
