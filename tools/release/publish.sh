#!/usr/bin/env bash
set -euo pipefail

: "${TRIGGER_SHA:?TRIGGER_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
: "${RELEASE_BATCH_JSON:?RELEASE_BATCH_JSON is required}"

fetch_main() {
  git fetch origin main --force --tags
  git checkout -B main origin/main
  git cat-file -e "${TRIGGER_SHA}^{commit}" || { echo "::error::Trigger commit ${TRIGGER_SHA} is unavailable."; exit 1; }
  git merge-base --is-ancestor "$TRIGGER_SHA" HEAD || { echo "::error::Trigger ${TRIGGER_SHA} is not an ancestor of current main $(git rev-parse HEAD)."; exit 1; }
}
find_prior_release() {
  local commit subject
  while read -r commit subject; do
    [[ "$subject" =~ ^release:\ (v[0-9]+\.[0-9]+\.[0-9]+(-rc\.[0-9]+)?)$ ]] || continue
    if git interpret-trailers --parse <<<"$(git show -s --format=%B "$commit")" | grep -Fxq "Release-Trigger: ${TRIGGER_SHA}"; then
      printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$commit"
      return 0
    fi
  done < <(git log --first-parent origin/main --format='%H %s')
  return 1
}
require_release_token() {
  if [[ -z "${RELEASE_TOKEN:-}" ]]; then
    echo '::error::Missing RELEASE_TOKEN. Configure an admin fine-grained PAT or ruleset-bypass GitHub App; see docs/deploy/runbook.md.'
    exit 1
  fi
  remote="${RELEASE_REMOTE_URL:-https://x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
}
push_tag() {
  local tag="$1" commit="$2" remote_commit
  remote_commit="$(git ls-remote --tags origin "refs/tags/${tag}^{}" | awk '{print $1}')"
  if [[ -z "$remote_commit" ]]; then remote_commit="$(git ls-remote --tags origin "refs/tags/${tag}" | awk '{print $1}')"; fi
  if [[ -n "$remote_commit" ]]; then
    [[ "$remote_commit" == "$commit" ]] || { echo "::error::Tag ${tag} already points to ${remote_commit}, expected ${commit}."; return 1; }
    return 0
  fi
  git tag -a "$tag" "$commit" -m "Release ${tag#v}"
  git push "$remote" "refs/tags/${tag}"
}

fetch_main
if prior="$(find_prior_release)"; then
  IFS=$'\t' read -r tag commit <<< "$prior"
  echo "Existing release found for trigger: ${tag} at ${commit}; ensuring tag exists."
  require_release_token
  push_tag "$tag" "$commit"
  exit 0
fi
for attempt in 1 2 3; do
  fetch_main
  if prior="$(find_prior_release)"; then
    IFS=$'\t' read -r tag commit <<< "$prior"
    push_tag "$tag" "$commit"
    exit 0
  fi
  batch_output="$(mktemp)"
  GITHUB_OUTPUT="$batch_output" tools/release/resolve-batch.sh
  RELEASE_BATCH_JSON="$(sed -n 's/^batch=//p' "$batch_output")"
  rm -f "$batch_output"
  if [[ "$(jq -r '.release' <<<"$RELEASE_BATCH_JSON")" != true ]]; then
    echo '::notice::Current main batch contains no release-worthy merges; no release created.'
    exit 0
  fi
  require_release_token
  release_intent="$(jq -c '{kind,bump}' <<<"$RELEASE_BATCH_JSON")"
  trailers="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).covered.map((sha) => `Release-Trigger: ${sha}`).join("\n"))' "$RELEASE_BATCH_JSON")"
  intent_kind="$(jq -r '.kind' <<<"$RELEASE_BATCH_JSON")"
  tags="$(git tag --list 'v*' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split(/\n/).filter(Boolean))))')"
  version="$(node tools/release/release.mjs version "$tags" "$release_intent")"
  if git rev-parse -q --verify "refs/tags/${version}" >/dev/null; then
    echo "::error::Computed tag ${version} already exists locally but has no matching release trigger."; exit 1
  fi
  release_date="$(date -u +%F)"
  node tools/release/release.mjs bump package.json "${version#v}"
  if [[ "$intent_kind" == stable ]]; then
    node tools/release/release.mjs changelog CHANGELOG.md "${version#v}" "$release_date"
  fi
  git add package.json
  [[ "$intent_kind" != stable ]] || git add CHANGELOG.md
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "release: ${version}" -m "$trailers"
  commit="$(git rev-parse HEAD)"
  expected_main="$(git rev-parse HEAD^)"
  if push_output="$(git push "$remote" HEAD:main 2>&1)"; then
    printf '%s\n' "$push_output"
    push_tag "$version" "$commit"
    echo "Released ${version} at ${commit} covering $(jq -r '.covered | join(", ")' <<<"$RELEASE_BATCH_JSON")"
    exit 0
  fi
  printf '%s\n' "$push_output" >&2
  git fetch origin main --force --tags
  remote_main="$(git rev-parse origin/main)"
  if [[ "$remote_main" == "$expected_main" ]] && grep -Eiq 'GH013|protected branch|ruleset|permission denied|write access' <<<"$push_output"; then
    echo '::error::RELEASE_TOKEN was rejected by main protection. The token owner or GitHub App must bypass the protect ruleset; see docs/deploy/runbook.md.'
    exit 1
  fi
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "::error::Could not rebase release after push race (attempt ${attempt}/3)."; exit 1
  fi
  # Recompute the version and reapply the release to the fetched main tip.
  git reset --hard origin/main
  if [[ "$attempt" -eq 3 ]]; then echo '::error::Release push lost three races; rerun the workflow.'; exit 1; fi
done
