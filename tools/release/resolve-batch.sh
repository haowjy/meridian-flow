#!/usr/bin/env bash
set -euo pipefail

: "${TRIGGER_SHA:?TRIGGER_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

git fetch origin main --force --tags
git checkout -B main origin/main
git cat-file -e "${TRIGGER_SHA}^{commit}" || { echo "::error::Trigger commit ${TRIGGER_SHA} is unavailable."; exit 1; }
git merge-base --is-ancestor "$TRIGGER_SHA" HEAD || { echo "::error::Trigger ${TRIGGER_SHA} is not an ancestor of current main tip $(git rev-parse HEAD)."; exit 1; }

first_parent='[]'
while IFS= read -r sha; do
  subject="$(git show -s --format=%s "$sha")"
  is_release=false
  if [[ "$subject" =~ ^release:\ v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?$ ]] || [[ -n "$(git tag --points-at "$sha" --list 'v*')" ]]; then
    is_release=true
  fi
  first_parent="$(jq -c --arg sha "$sha" --argjson isRelease "$is_release" '. + [{sha:$sha,isRelease:$isRelease}]' <<<"$first_parent")"
done < <(git rev-list --first-parent --reverse origin/main)
covered_shas="$(node tools/release/release.mjs coverage "$first_parent")"

batch_commits='[]'
while IFS= read -r sha; do
  [[ -n "$sha" ]] || continue
  message="$(git show -s --format=%B "$sha")"
  skip_trailer=false
  if git interpret-trailers --parse <<<"$message" | grep -Fxq 'Release-Skip: true'; then
    skip_trailer=true
  fi
  labels='[]'
  if [[ "$skip_trailer" == false ]]; then
    prs="$(gh api "/repos/${GITHUB_REPOSITORY}/commits/${sha}/pulls")"
    selected="$(jq --arg sha "$sha" '[.[] | select(.merged_at != null and .base.ref == "main" and .merge_commit_sha == $sha)]' <<<"$prs")"
    reason='exact merge SHA'
    if [[ "$(jq length <<<"$selected")" -eq 0 ]]; then
      selected="$(jq '[.[] | select(.merged_at != null and .base.ref == "main")]' <<<"$prs")"
      reason='merged PR fallback'
    fi
    count="$(jq length <<<"$selected")"
    if [[ "$count" -ne 1 ]]; then
      echo "::error::Expected one merged PR for uncovered first-parent commit ${sha}; found ${count}. Refusing to release without its labels."
      exit 1
    fi
    labels="$(jq -c '[.[0].labels[]?.name]' <<<"$selected")"
    echo "::notice::Coverage includes PR #$(jq -r '.[0].number' <<<"$selected") at ${sha} via ${reason}; labels ${labels}."
  else
    echo "::notice::Coverage excludes ${sha} due to exact Release-Skip: true trailer."
  fi
  batch_commits="$(jq -c --arg sha "$sha" --argjson labels "$labels" --argjson skipTrailer "$skip_trailer" '. + [{sha:$sha,labels:$labels,skipTrailer:$skipTrailer}]' <<<"$batch_commits")"
done < <(jq -r '.[]' <<<"$covered_shas")

batch="$(node tools/release/release.mjs batch "$batch_commits")"
echo "::notice::Resolved release batch: ${batch}."
echo "batch=${batch}" >> "$GITHUB_OUTPUT"
