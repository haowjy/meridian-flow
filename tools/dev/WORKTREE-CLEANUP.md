# Manual worktree cleanup

For when `pnpm dev:prune-worktrees -- --target <x> --dry-run` refuses a
branch you believe is safe to remove. The tool only acts on proof: the commit
contained in another surviving ref (the branch's own local and remote-tracking
refs never count), or an exact merged-PR match, whichever base branch it merged
into ([`tools/dev/AGENTS.md`](AGENTS.md)). When neither holds, it refuses — correctly,
on the evidence it has. This guide is for building better evidence by hand and
recording that evidence in a manually verified cleanup plan, not for using a
bare force override.

## When this applies

- The branch merged into another working branch that no longer exists: its
  integration branch was squash-merged into `main` or `staging` and deleted,
  nothing left contains the commit, and the branch had no PR of its own.
  Squashing discards the ancestor relationship entirely, for every branch that
  fed it.
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

Once you have the evidence, pass a concrete summary of what you checked and
the commits you checked it against. Inspect the plan first:

```bash
pnpm dev:prune-worktrees -- --target <branch> \
  --manually-verified "<reason citing the evidence and commits above>" --dry-run
pnpm dev:prune-worktrees -- --target <branch> \
  --manually-verified "<reason citing the evidence and commits above>"
```

Manual verification replaces only the automatic containment or PR proof; the
tool still refuses primary, current, base, locked, dirty, or (by default) live worktrees and
still revalidates the branch OID and readiness before destructive actions.

### Verify stacked-lane acceptance

Exercise both automatic proof paths on disposable refs. Only the first can be
synthesized; the stacked-PR path needs a real merged PR, so use one whose base
was a working branch.

1. Containment: a lane whose tip is an ancestor of an integration ref. Give
   both branches worktrees, so each is a cleanup target.

   ```bash
   tree=$(git rev-parse origin/main^{tree})
   lane=$(git commit-tree $tree -p origin/main -m "fixture: prune lane")
   integration=$(git commit-tree $tree -p $lane -m "fixture: prune integration")
   git branch fixture/prune-lane $lane
   git branch fixture/prune-integration $integration
   git worktree add ../meridian-flow.worktrees/prune-fixture-lane fixture/prune-lane
   git worktree add ../meridian-flow.worktrees/prune-fixture-integration fixture/prune-integration
   ```

2. A dry run on `fixture/prune-lane` plans with evidence
   `contained in fixture/prune-integration`; a dry run on
   `fixture/prune-integration` refuses (only its own refs contain it).
3. Stacked PR: pick a merged PR whose base is a working branch and whose head
   commit no other ref contains, then create a worktree at that head commit.

   ```bash
   gh pr list --state merged --limit 500 \
     --json number,baseRefName,headRefName,headRefOid
   git for-each-ref --contains=<headRefOid> refs/heads refs/remotes
   git worktree add -b <headRefName> \
     ../meridian-flow.worktrees/prune-fixture-pr <headRefOid>
   ```

   The dry run on `<headRefName>` plans with evidence `merged PR #N into
   <base>`; a surviving carrier would be named instead, because containment is
   checked first.
4. A branch at a commit no other ref contains and no merged PR matches still
   refuses.
5. Remove the fixture worktrees and branches: `git worktree remove <path>` and
   `git update-ref -d <ref>` for each.

## Shells parked in a merged worktree

Use target-only `--force` when a shell or tmux pane still has its cwd inside
the merged checkout:

```bash
pnpm dev:prune-worktrees -- --target <branch> --force --dry-run
pnpm dev:prune-worktrees -- --target <branch> --force
```

The tool stops only the target's managed dev stack and Nx daemon, then
rechecks occupants before dropping its database and removing the worktree.
Known shells/tmux may remain alive; the tool prints their PIDs and pane IDs.
Their owners should `cd` to an existing directory after cleanup. It never
kills user shells or their tmux sessions. Other processes, active work items,
dirty state and inspection failures still block. Merge proof (or concrete
`--manually-verified` evidence), primary/current/base/locked protections and
commit revalidation all still apply. Force is not available for batch cleanup,
and does not pass Git's destructive `worktree remove --force` flag.

### Verify shell preservation

Use an owned disposable worktree with merged-commit proof. Park a shell and a
tmux pane in it and record their PIDs/pane IDs. Without `--force`, targeted
cleanup must refuse. A forced dry run must list dev/Nx shutdown without doing
anything. Actual forced cleanup must stop managed services, remove the checkout
and its database, leave both shells and the user tmux session alive, and print
the surviving PIDs/pane IDs. Have those shells `cd` out afterwards.

Repeat with an uncommitted file or an unmerged commit: force must refuse before
shutdown. With an unrelated non-shell process in the target, force may shut down
managed services but must refuse before dropping the database. Terminate only
your fixture process and retry. `--auto --force` must be rejected.

## Don't

- Don't infer safety from a branch name, a date, or "this was probably
  cleaned up already."
- Don't batch dozens of branches through this without verifying each one;
  the evidence step is per-branch, not per-sweep.
- Don't skip the live-session check because the worktree's git status is
  clean. Clean and idle are different things.
