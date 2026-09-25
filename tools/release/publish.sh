#!/usr/bin/env bash
set -euo pipefail

: "${TRIGGER_SHA:?TRIGGER_SHA is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
if [[ -z "${RELEASE_TOKEN:-}" ]]; then
  echo '::error::Missing RELEASE_TOKEN. Configure a fine-grained admin PAT or ruleset-bypass GitHub App; see tools/release/README.md#release-token.'
  exit 1
fi
remote="${RELEASE_REMOTE_URL:-https://x-access-token:${RELEASE_TOKEN}@github.com/${GITHUB_REPOSITORY}.git}"
: "${RELEASE_INTENT_JSON:?RELEASE_INTENT_JSON is required}"
intent="$RELEASE_INTENT_JSON"

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
    if git show -s --format=%B "$commit" | grep -Fxq "Release-Trigger: ${TRIGGER_SHA}"; then
      printf '%s\t%s\n' "${BASH_REMATCH[1]}" "$commit"
      return 0
    fi
  done < <(git log origin/main --format='%H %s')
  return 1
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
  push_tag "$tag" "$commit"
  exit 0
fi
# Workflow-resolved labels are passed as intent JSON, not looked up here.
if [[ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).release ? "yes" : "no")' "$intent")" == no ]]; then
  echo '::notice::release:skip requested; no release created.'
  exit 0
fi

for attempt in 1 2 3; do
  fetch_main
  if prior="$(find_prior_release)"; then
    IFS=$'\t' read -r tag commit <<< "$prior"; push_tag "$tag" "$commit"; exit 0
  fi
  tags="$(git tag --list 'v*' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify(s.split(/\n/).filter(Boolean))))')"
  version="$(node tools/release/release.mjs version "$tags" "$intent")"
  if git rev-parse -q --verify "refs/tags/${version}" >/dev/null; then
    echo "::error::Computed tag ${version} already exists locally but has no matching release trigger."; exit 1
  fi
  release_date="$(date -u +%F)"
  node tools/release/release.mjs bump package.json "$version"
  node tools/release/release.mjs changelog CHANGELOG.md "${version#v}" "$release_date"
  git add package.json CHANGELOG.md
  git -c user.name='github-actions[bot]' -c user.email='41898282+github-actions[bot]@users.noreply.github.com' commit -m "release: ${version}" -m "Release-Trigger: ${TRIGGER_SHA}"
  commit="$(git rev-parse HEAD)"
  if git push "$remote" HEAD:main; then
    push_tag "$version" "$commit"
    echo "Released ${version} at ${commit}"
    exit 0
  fi
  git fetch origin main --force --tags
  if ! git rebase origin/main; then
    git rebase --abort || true
    echo "::error::Could not rebase release after push race (attempt ${attempt}/3)."; exit 1
  fi
  # Recompute on next pass after restoring the root package/changelog to main.
  git reset --hard origin/main
  if [[ "$attempt" -eq 3 ]]; then echo '::error::Release push lost three races; rerun the workflow.'; exit 1; fi
done
