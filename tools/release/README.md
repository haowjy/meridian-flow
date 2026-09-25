# Release-on-merge

Each release is cut from the current tip of `main`, not from the triggering
merge commit. The job walks first-parent history after the latest release
commit or `v*` tag and resolves every uncovered merge's PR labels. Before the
first release marker exists, the workflow-introduction commit is the bootstrap
boundary; earlier history is not replayed. A later run therefore covers
unreleased merges whose queued runs were replaced. One release commit records
one `Release-Trigger` trailer for each included merge. The strongest included
intent wins; an exact `release:skip` label or `Release-Skip: true` trailer
excludes only that merge. If all uncovered merges are skipped, there is no
release. The sole version source is root `package.json`; package versions
remain private `0.0.0`. Stable tags use `vX.Y.Z`; prereleases use `vX.Y.Z-rc.N`.
Initial release numbering starts at `0.0.0`.

## PR labels

| Labels | Result |
| --- | --- |
| `release:skip` | No release (takes precedence) |
| `release:patch` or `release:stable` | Stable patch |
| `release:minor` | Stable minor |
| `release:major` | Stable major |
| `release:rc` or no `release:*` label | Patch prerelease on latest stable |
| Unknown `release:*` label | Patch prerelease |

Multiple bump labels use the strongest stable bump (major, then minor, then
patch), unless `release:rc` or an unknown release label is present, which
selects an RC. Existing repository labels are `release:patch` and
`release:minor`; the workflow also accepts the other labels above.

The release commit updates root `package.json`. Stable releases roll the
current `## [Unreleased]` content into a dated `## [X.Y.Z]` section, leaving a
fresh empty Unreleased section; existing text preceding that section is
preserved. RC releases leave `CHANGELOG.md` untouched, so their release notes
come from the current `[Unreleased]` section.

## Safety and recovery

The job anchors to current `main` and requires the triggering merge to be an
ancestor. A run whose trigger already appears in any `Release-Trigger` trailer
is a no-op except that it repairs a missing tag. Release commits and tags are
annotated. Push races are retried after fetching/rebasing, and an existing tag
pointing at a different commit fails loudly. Release commits beginning
`release: v` are ignored before they enter the job concurrency group.

For a release that must be backfilled without running the workflow, manually
push an annotated `vX.Y.Z` tag to the intended release commit. Tags cannot be
deleted or moved once the tag ruleset draft is applied. Confirm staging's
release-commit smoke before manually tagging a missed version.

## Release token

`RELEASE_TOKEN` is mandatory; there is no `GITHUB_TOKEN` fallback because
GITHUB_TOKEN-originated pushes do not trigger the required CI run. Configure
either a fine-grained PAT for a repository admin, scoped only to this repo with
Contents read/write, or a GitHub App installation with repository Contents
read/write whose integration is added as a bypass actor to `protect` and the
tag ruleset. The existing `protect` ruleset currently grants
`RepositoryRole` 5 (admin) an `always` bypass. A PAT works via its admin owner's
bypass; an app must be configured explicitly as a bypass actor. The workflow
fails with an actionable error if the secret is absent.
