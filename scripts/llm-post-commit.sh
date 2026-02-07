#!/usr/bin/env bash
#
# Post-commit hook for meridian-llm-go submodule.
# Auto-bumps patch version, tags, pushes, and updates backend/go.mod.
#
# Installed via symlink:
#   .git/modules/meridian-llm-go/hooks/post-commit → ../../../scripts/llm-post-commit.sh
#
# This runs automatically after every commit in the submodule.
# To skip: git commit --no-verify (or delete the symlink to uninstall).

set -euo pipefail

# --- Resolve paths ---
# When running as a git hook, $GIT_DIR is set and we're inside the submodule worktree.
# Resolve the submodule root and parent repo root.
SUBMODULE_DIR="$(git rev-parse --show-toplevel)"
REPO_ROOT="$(cd "$SUBMODULE_DIR/.." && pwd)"
BACKEND_DIR="$REPO_ROOT/backend"
MODULE_PATH="github.com/haowjy/meridian-llm-go"

echo ""
echo "=== meridian-llm-go post-commit hook ==="

# --- Fetch tags from origin ---
echo "Fetching tags from origin..."
git fetch origin --tags --quiet 2>/dev/null || echo "  Warning: Could not fetch tags (offline?)"

# --- Get latest tag ---
LATEST_TAG=$(git tag -l "v*" | sort -V | tail -1)
if [ -z "$LATEST_TAG" ]; then
    echo "  No existing tags found. Starting at v0.0.1"
    LATEST_TAG="v0.0.0"
fi

# --- Check if HEAD is already tagged ---
HEAD_TAGS=$(git tag --points-at HEAD 2>/dev/null || true)
if [ -n "$HEAD_TAGS" ]; then
    echo "  HEAD is already tagged: $HEAD_TAGS"
    echo "  Skipping (no double-bump)."
    echo "=== Done ==="
    exit 0
fi

# --- Increment patch version ---
# Strip 'v' prefix, split on '.', increment patch
VERSION="${LATEST_TAG#v}"
MAJOR=$(echo "$VERSION" | cut -d. -f1)
MINOR=$(echo "$VERSION" | cut -d. -f2)
PATCH=$(echo "$VERSION" | cut -d. -f3)
NEW_PATCH=$((PATCH + 1))
NEW_TAG="v${MAJOR}.${MINOR}.${NEW_PATCH}"

echo "  Latest tag: $LATEST_TAG"
echo "  New tag:    $NEW_TAG"

# --- Tag current commit ---
git tag "$NEW_TAG"
echo "  Tagged HEAD as $NEW_TAG"

# --- Push commit + tag to origin ---
echo "  Pushing to origin..."
PUSH_FAILED=false
if ! git push origin HEAD 2>/dev/null; then
    echo "  Warning: Failed to push commit (network issue?)"
    PUSH_FAILED=true
fi
if ! git push origin "$NEW_TAG" 2>/dev/null; then
    echo "  Warning: Failed to push tag (network issue?)"
    PUSH_FAILED=true
fi

if [ "$PUSH_FAILED" = true ]; then
    echo "  Push failed — tag $NEW_TAG created locally."
    echo "  Run manually: git push origin HEAD && git push origin $NEW_TAG"
    echo "=== Done (with warnings) ==="
    exit 0
fi

echo "  Pushed successfully."

# --- Update backend/go.mod ---
echo "  Updating backend dependencies..."

# go get may fail if GitHub hasn't indexed the tag yet — retry once after a delay
update_backend() {
    cd "$BACKEND_DIR"
    go get "${MODULE_PATH}@${NEW_TAG}" && go mod tidy
}

if ! update_backend 2>/dev/null; then
    echo "  Tag not yet available on GitHub, retrying in 5s..."
    sleep 5
    if ! update_backend 2>/dev/null; then
        echo "  Warning: Could not update backend/go.mod automatically."
        echo "  Run manually: cd backend && go get ${MODULE_PATH}@${NEW_TAG} && go mod tidy"
        echo "=== Done (with warnings) ==="
        exit 0
    fi
fi

echo "  backend/go.mod updated to ${MODULE_PATH}@${NEW_TAG}"

# --- Summary ---
echo ""
echo "=== Summary ==="
echo "  Tagged:  $NEW_TAG"
echo "  Pushed:  origin"
echo "  Backend: updated to $NEW_TAG"
echo ""
echo "  Next: commit backend/go.mod + go.sum in the parent repo"
echo "=== Done ==="
